---
title: Cron 模块架构
summary: OpenClaw 定时任务系统的内部实现细节，涵盖调度引擎、任务执行、持久化和 agent 集成。
---

# Cron 模块架构

## 代码地图

```
src/cron/
├── types.ts                    # 核心类型定义（CronJob, CronSchedule, CronPayload 等）
├── types-shared.ts             # 跨模块共享的基础类型（CronJobBase）
├── service.ts                  # CronService 类 — 对外暴露的服务入口
├── service-contract.ts         # CronServiceContract 接口定义
├── store.ts                    # 持久化层：加载/保存 jobs.json + jobs-state.json
├── schedule.ts                 # 调度计算：computeNextRunAtMs / computePreviousRunAtMs
├── normalize.ts                # 输入规范化：将用户/API 输入转为内部 CronJobCreate/Patch
├── delivery.ts                 # 投递层：将 cron 输出发送到消息通道
├── delivery-plan.ts            # 投递计划解析：resolveCronDeliveryPlan / resolveFailureDestination
├── delivery-preview.ts         # 投递预览（用于 UI/CLI 展示）
├── delivery-field-schemas.ts   # 投递字段的 schema 验证
├── run-log.ts                  # 运行日志记录
├── run-diagnostics.ts          # 运行诊断信息收集
├── run-id.ts                   # 执行 ID 生成（createCronExecutionId）
├── session-reaper.ts           # 会话清理器：定期清除过期的 cron run session
├── session-target.ts           # 会话目标解析
├── schedule-identity.ts        # 调度身份标识（用于检测 schedule 变更）
├── stagger.ts                  # 错峰调度（避免同时触发大量任务）
├── heartbeat-policy.ts         # 心跳策略
├── active-jobs.ts              # 活跃任务追踪
├── parse.ts                    # 时间解析工具
├── validate-timestamp.ts       # 时间戳验证
├── normalize-job-identity.ts   # 任务身份规范化
├── webhook-url.ts              # Webhook URL 规范化
│
├── service/                    # CronService 内部实现
│   ├── state.ts                # 服务状态定义（CronServiceState, CronServiceDeps）
│   ├── ops.ts                  # 操作实现（start/stop/add/update/remove/run/list）
│   ├── timer.ts                # 定时器引擎（armTimer, runMissedJobs, executeJobCore）
│   ├── jobs.ts                 # 任务操作（createJob, computeNextRun, isJobDue 等）
│   ├── store.ts                # 服务层存储操作（ensureLoaded, persist）
│   ├── locked.ts               # 互斥锁（防止并发操作）
│   ├── normalize.ts            # 服务层规范化辅助
│   ├── list-page-types.ts      # 分页列表类型
│   ├── timeout-policy.ts       # 超时策略
│   └── initial-delivery.ts     # 初始投递配置
│
└── isolated-agent/             # 隔离 agent 执行
    ├── run.ts                  # 核心执行入口（runCronAgentTurn）
    ├── run-executor.ts         # 执行器（调用 agent 运行时）
    ├── run-session-state.ts    # 运行时会话状态管理
    ├── session.ts              # cron 会话解析/创建
    ├── session-key.ts          # cron 会话 key 生成
    ├── delivery-dispatch.ts    # 投递分发（announce/webhook/message-tool）
    ├── delivery-target.ts      # 投递目标解析
    ├── model-selection.ts      # 模型选择逻辑
    ├── model-preflight.runtime.ts  # 模型预检
    ├── helpers.ts              # 辅助函数
    ├── skills-snapshot.ts      # 技能快照
    ├── channel-output-policy.ts    # 通道输出策略
    ├── subagent-followup.ts    # 子 agent 后续处理
    ├── run-config.ts           # 运行配置构建
    ├── run-fallback-policy.ts  # 回退策略
    └── *.runtime.ts            # 各种延迟加载的运行时模块
```

## 定时任务模型

### CronJob 结构

每个定时任务由 `CronJob` 类型表示，核心字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 唯一标识（UUID） |
| `name` | `string` | 任务名称 |
| `enabled` | `boolean` | 是否启用 |
| `schedule` | `CronSchedule` | 调度规则 |
| `sessionTarget` | `CronSessionTarget` | 执行目标会话 |
| `payload` | `CronPayload` | 执行载荷 |
| `delivery` | `CronDelivery` | 投递配置 |
| `failureAlert` | `CronFailureAlert \| false` | 失败告警配置 |
| `agentId` | `string?` | 绑定的 agent ID |
| `state` | `CronJobState` | 运行时状态 |

### 调度类型（CronSchedule）

三种调度模式，通过 `kind` 判别联合类型区分：

- **`at`**：一次性定时（绝对时间戳），执行后自动禁用
- **`every`**：固定间隔（毫秒），支持 `anchorMs` 锚点对齐
- **`cron`**：标准 cron 表达式，支持时区（`tz`）和错峰窗口（`staggerMs`）

### 会话目标（CronSessionTarget）

- `"main"`：在主会话中执行（通过 systemEvent 注入）
- `"isolated"`：创建隔离会话执行 agent turn
- `"current"`：在当前活跃会话中执行
- `` `session:${string}` ``：指定具名会话

### 载荷类型（CronPayload）

- **`systemEvent`**：注入系统事件文本到主会话心跳循环
- **`agentTurn`**：触发独立的 agent 对话轮次，支持 model/thinking/timeout/tools 等覆盖

## 调度引擎

### 核心调度计算（`schedule.ts`）

`computeNextRunAtMs(schedule, nowMs)` 是调度核心：

1. **`at` 类型**：解析绝对时间，若在未来则返回，否则返回 `undefined`
2. **`every` 类型**：基于 anchor + interval 计算下一个对齐时间点
3. **`cron` 类型**：使用 `croner` 库解析 cron 表达式，带 LRU 缓存（最大 512 条）

特殊处理：
- croner 的年份回退 bug 修复（Asia/Shanghai 等时区）
- 多次重试策略确保返回未来时间

### 定时器循环（`service/timer.ts`）

定时器是调度引擎的心脏：

```
armTimer(state) → setTimeout → tick → executeJobCore → applyJobResult → armTimer
```

关键常量：
- `MAX_TIMER_DELAY_MS = 60_000`：最大定时器间隔 60 秒
- `MIN_REFIRE_GAP_MS = 2_000`：同一任务最小重触发间隔（防止死循环）
- `DEFAULT_MISSED_JOB_STAGGER_MS = 5_000`：启动时错过任务的错峰间隔
- `DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5`：启动时立即执行的最大错过任务数

### 启动追赶（Startup Catchup）

Gateway 重启时，定时器检测错过的任务：
1. 标记中断的运行中任务为失败
2. 计算错过的任务列表
3. 按 `missedJobStaggerMs` 间隔逐步执行
4. agent-turn 类型任务额外延迟 `startupDeferredMissedAgentJobDelayMs`（默认 2 分钟）

### 错峰调度（`stagger.ts`）

对于 cron 表达式类型的任务，支持 `staggerMs` 窗口：
- 基于 job ID 生成确定性偏移量
- 避免整点时大量任务同时触发

### 错误退避

连续失败时按指数退避延迟重试：
```
[30s, 60s, 5min, 15min, 1h]
```

## 任务执行流程

### 主会话任务（sessionTarget = "main"）

```
timer tick
  → isJobDue(job, nowMs)
  → resolveJobPayloadTextForMain(job)  // 提取 systemEvent text
  → deps.enqueueSystemEvent(text, { agentId, sessionKey })
  → 或 deps.requestHeartbeat() / deps.runHeartbeatOnce()
  → applyJobResult(state, job, outcome)
```

主会话任务不直接执行 agent turn，而是将文本注入心跳循环。

### 隔离 agent 任务（sessionTarget = "isolated"）

```
timer tick
  → isJobDue(job, nowMs)
  → deps.runIsolatedAgentJob(job, message, abortSignal)
    → isolated-agent/run.ts: runCronAgentTurn()
      → 解析/创建 cron 会话
      → 模型选择 + 预检
      → 构建 agent 上下文
      → 执行 agent turn（通过 run-executor）
      → 投递结果（delivery-dispatch）
  → applyJobResult(state, job, outcome)
```

### 执行超时

- 默认超时由 `timeout-policy.ts` 决定
- 支持 per-job `payload.timeoutSeconds` 覆盖
- 超时后调用 `cleanupTimedOutAgentRun` 清理

### 失败告警

当连续失败次数达到阈值（默认 2 次）：
- 通过 `sendCronFailureAlert` 发送告警
- 支持冷却期（默认 1 小时）
- 支持 `includeSkipped` 将跳过也计入失败

### 任务运行 ID

每次执行生成唯一 `runId`（通过 `createCronExecutionId`），用于：
- 关联 task run 追踪
- 会话 key 中标识具体运行

## 持久化

### 双文件存储模型

Cron 使用分离的双文件持久化：

- **`jobs.json`**（配置文件）：任务定义（schedule, payload, delivery 等），不含运行时状态
- **`jobs-state.json`**（状态文件）：运行时状态（nextRunAtMs, lastRunStatus, consecutiveErrors 等）

这种分离的好处：
- 配置文件可以被版本控制/手动编辑
- 状态文件频繁更新不会污染配置
- 支持从旧版内联状态的平滑迁移

### 存储路径

默认路径：`~/.openclaw/cron/jobs.json`，可通过配置覆盖。

### 原子写入

使用 `replaceFileAtomic` 确保写入安全：
- 先写临时文件
- 然后原子 rename
- 文件权限 `0o600`
- 目录权限 `0o700`

### 写入优化

- 内存缓存序列化结果（`serializedStoreCache`）
- 仅在内容实际变化时写入磁盘
- 支持 `stateOnly` 模式（仅更新状态文件）
- 配置变更时自动创建 `.bak` 备份

### 状态合并

加载时的合并逻辑：
1. 读取 `jobs.json` 获取任务定义
2. 读取 `jobs-state.json` 获取运行时状态
3. 按 job ID 合并状态到任务对象
4. 检测 `scheduleIdentity` 变更时清除 `nextRunAtMs`（强制重新计算）

### 迁移兼容

- 检测旧版内联状态（`hasInlineState`）
- 首次保存时自动分离为双文件
- `needsSplitMigration` 标记确保迁移完整性

## 与 Agent 的集成

### 隔离 Agent 执行（`isolated-agent/`）

这是 cron 与 agent 系统的核心集成点：

1. **会话管理**（`session.ts`）：
   - 为每个 cron job 创建/复用专属会话
   - 会话 key 格式：`agent:<agentId>:cron:<jobId>`
   - 每次运行创建子会话：`agent:<agentId>:cron:<jobId>:run:<uuid>`

2. **模型选择**（`model-selection.ts`）：
   - 支持 per-job model 覆盖
   - 支持 fallback 模型列表
   - 继承 agent 默认配置

3. **执行器**（`run-executor.ts`）：
   - 构建完整的 agent 运行上下文
   - 注入 workspace、skills、tools
   - 通过 CommandLane 排队执行

4. **投递分发**（`delivery-dispatch.ts`）：
   - 执行完成后将输出投递到目标通道
   - 支持 announce（消息通道）和 webhook 模式
   - 检测 message tool 的自主投递避免重复

5. **会话清理**（`session-reaper.ts`）：
   - 定期清除过期的 cron run session
   - 默认保留 24 小时
   - 最小清理间隔 5 分钟
   - 同时清理关联的 transcript 文件

### 事件系统

`CronEvent` 通过 `deps.onEvent` 回调通知外部：
- `added` / `updated` / `removed`：任务变更
- `started`：任务开始执行
- `finished`：任务执行完成（含 status, duration, delivery 等）

### 互斥与并发

- `locked()` 函数确保同一时刻只有一个操作修改状态
- 读操作（list/status）使用 `ensureLoadedForRead` 避免阻塞写操作
- 每个 job 同一时刻只能有一个运行实例（`state.runningAtMs` 标记）
- 通过 `CommandLane` 与 gateway 其他操作协调

### WakeMode

两种唤醒模式：
- **`next-heartbeat`**：将文本注入下一次心跳循环
- **`now`**：立即触发心跳执行，带忙等待重试机制
