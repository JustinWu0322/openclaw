---
title: Channels 模块架构
summary: OpenClaw 多渠道消息系统的内部架构文档，面向维护者，涵盖渠道抽象模型、注册发现、消息收发、生命周期管理、DM 策略与健康监控。
---

# Channels 模块架构

## 代码地图

```
src/channels/
├── registry.ts                    # 渠道 ID 规范化与已注册渠道查询
├── channel-config.ts              # 渠道配置匹配（direct/parent/wildcard 三级回退）
├── ids.ts                         # ChatChannelId 类型定义与排序常量
├── allow-from.ts                  # DM/Group allowFrom 列表合并逻辑
├── allowlist-match.ts             # 允许列表匹配工具
├── mention-gating.ts              # @提及检测与门控
├── command-gating.ts              # 命令授权门控
├── session.ts / session.types.ts  # 入站会话记录与路由更新
├── typing.ts / typing-lifecycle.ts # 打字状态指示器
├── status-reactions.ts            # 状态 emoji 反应控制器
├── ack-reactions.ts               # 消息确认反应
├── run-state-machine.ts           # 运行状态机（busy/idle 追踪）
├── conversation-resolution.ts     # 会话解析（DM/Group/Channel 判定）
├── draft-stream-controls.ts       # 草稿流控制
├── model-overrides.ts             # 渠道级模型覆盖
├── sender-identity.ts / sender-label.ts  # 发送者身份标识
├── inbound-debounce-policy.ts     # 入站消息防抖策略
│
├── message/                       # 消息发送/接收核心
│   ├── index.ts                   # 公共导出桶
│   ├── types.ts                   # 消息适配器类型体系
│   ├── send.ts                    # 持久化消息批量发送
│   ├── receive.ts                 # 消息接收上下文与 ACK 策略
│   ├── live.ts                    # 实时预览（流式编辑）
│   ├── reply-pipeline.ts          # 回复管道组装
│   ├── outbound-bridge.ts         # 出站桥接适配器
│   ├── contracts.ts               # 能力证明验证
│   ├── capabilities.ts            # 持久化最终投递需求推导
│   ├── receipt.ts                 # 消息回执处理
│   ├── state.ts                   # 持久化消息状态记录
│   └── rendered-batch.ts          # 渲染批次计划
│
├── message-access/                # 入站访问控制（Ingress）
│   ├── types.ts                   # 完整 Ingress 类型体系
│   ├── runtime.ts                 # Ingress 解析器工厂
│   ├── runtime-types.ts           # 运行时类型
│   ├── decision.ts                # 访问图求值与最终决策
│   ├── state.ts                   # Ingress 状态解析
│   ├── allowlist.ts               # 允许列表规范化
│   ├── sender-gates.ts            # 发送者门控
│   ├── runtime-identity.ts        # 身份适配器
│   └── runtime-access-groups.ts   # 访问组成员关系解析
│
├── turn/                          # 渠道 Turn（一次完整入站→回复循环）
│   ├── types.ts                   # Turn 全类型定义
│   ├── kernel.ts                  # Turn 执行内核
│   ├── context.ts                 # Turn 上下文构建
│   ├── durable-delivery.ts        # 持久化投递
│   ├── dispatch-result.ts         # 分发结果统计
│   └── delivery-result.ts         # 投递结果工具
│
├── plugins/                       # 渠道插件系统
│   ├── types.plugin.ts            # ChannelPlugin 完整接口
│   ├── types.core.ts              # ChannelMeta, ChannelCapabilities 等核心类型
│   ├── types.adapters.ts          # 各适配器接口（Config/Setup/Status/Pairing/...）
│   ├── registry.ts                # 插件注册表查询
│   ├── registry-loaded.ts         # 已加载插件存储
│   ├── bootstrap-registry.ts      # 启动时插件引导
│   ├── bundled.ts                 # 内置渠道插件加载
│   ├── bundled-ids.ts             # 内置渠道 ID 列表
│   ├── catalog.ts                 # 渠道目录（UI/安装/发现）
│   ├── module-loader.ts           # 外部插件模块加载器（支持 TS/JS）
│   ├── dm-access.ts               # DM 策略读写
│   ├── pairing.ts                 # 配对适配器查询
│   ├── status.ts                  # 账户快照构建
│   ├── lifecycle-startup.ts       # 启动维护钩子
│   ├── setup-wizard-helpers.ts    # 设置向导辅助
│   ├── group-policy-warnings.ts   # 群组策略警告
│   └── contracts/                 # 契约测试套件
│
└── transport/
    └── stall-watchdog.ts          # 传输层停滞看门狗
```

## 渠道抽象模型

### ChannelPlugin 接口

每个渠道（WhatsApp、Telegram、Discord 等）实现为一个 `ChannelPlugin` 对象，定义在 `plugins/types.plugin.ts`：

```typescript
type ChannelPlugin<ResolvedAccount, Probe, Audit> = {
  id: ChannelId;              // 唯一标识，如 "telegram", "discord"
  meta: ChannelMeta;          // 用户可见元数据（标签、文档路径、排序）
  capabilities: ChannelCapabilities;  // 能力声明
  config: ChannelConfigAdapter<ResolvedAccount>;  // 配置读写
  setup?: ChannelSetupAdapter;       // 安装/配置向导
  pairing?: ChannelPairingAdapter;   // DM 配对
  security?: ChannelSecurityAdapter; // 安全策略
  status?: ChannelStatusAdapter;     // 状态探测与快照
  lifecycle?: ChannelLifecycleAdapter; // 生命周期钩子
  message?: ChannelMessageAdapterShape; // 消息发送/接收适配器
  gateway?: ChannelGatewayAdapter;   // Gateway RPC 方法
  // ... 更多可选适配器
};
```

核心设计原则：
- **适配器模式**：每个关注点（配置、发送、状态、配对等）是独立的可选适配器
- **泛型账户**：`ResolvedAccount` 由各渠道自定义，核心不关心具体结构
- **能力声明**：通过 `capabilities` 和 `message.live.capabilities` 声明支持的特性

### 消息适配器体系

`message/types.ts` 定义了消息发送的分层适配器：

```
ChannelMessageAdapterShape
├── send: ChannelMessageSendAdapter     # text/media/payload 三种发送方法
│   └── lifecycle: SendLifecycleAdapter # beforeAttempt/afterSuccess/afterFailure/afterCommit
├── durableFinal: DurableFinalAdapter   # 持久化最终投递能力声明 + 未知发送协调
├── live: LiveAdapterShape              # 实时预览能力（draftPreview/nativeStreaming/...）
│   └── finalizer: FinalizerShape       # 预览终结能力（finalEdit/normalFallback/...）
└── receive: ReceiveAdapterShape        # 接收 ACK 策略声明
```

### Turn 模型

一次完整的入站消息处理称为一个 **Turn**，流程定义在 `turn/types.ts`：

```
ingest → classify → preflight → resolve → authorize → assemble → record → dispatch → finalize
```

`ChannelTurnAdapter<TRaw>` 是渠道插件实现 Turn 的核心接口：
- `ingest(raw)` — 原始事件规范化为 `NormalizedTurnInput`
- `classify(input)` — 事件分类（message/command/reaction/lifecycle）
- `preflight(input, eventClass)` — 预检（可提前 drop/handle）
- `resolveTurn(input, eventClass, preflight)` — 组装完整 Turn 上下文

## 渠道注册与发现

### 注册流程

```
启动时:
  bootstrap-registry.ts
    → listBundledChannelPluginIds()     # 从 channel-catalog-registry 获取内置列表
    → getBootstrapChannelPlugin(id)     # 合并 runtime + setup 插件
    → 注册到 registry-loaded.ts 的内存存储

外部插件:
  module-loader.ts
    → loadChannelPluginModule()         # 支持 .ts/.js/.mts/.mjs，TS 通过 jiti 加载
    → 安全边界检查（不允许逃逸插件根目录）
    → 注册到同一内存存储
```

### 查询路径

`registry.ts` 提供两层查询：

1. **轻量级**（`normalizeChannelId`）：仅做 ID 规范化，不触发插件加载
2. **完整查询**（`normalizeAnyChannelId`）：查询已注册插件注册表，支持别名匹配

`plugins/registry.ts` 提供插件级查询：
- `listChannelPlugins()` — 列出所有已加载插件
- `getChannelPlugin(id)` — 先查已加载，回退到内置
- `getLoadedChannelPlugin(id)` — 仅查已加载

### 目录系统

`plugins/catalog.ts` 管理渠道发现目录，支持多来源：
- **bundled**：内置渠道（优先级最高）
- **workspace**：工作区插件
- **global**：全局安装的插件
- **config**：配置文件指定的插件
- **external catalog**：外部目录文件（JSON 格式，支持环境变量 `OPENCLAW_PLUGIN_CATALOG_PATHS`）

## 消息收发流程

### 入站流程（Inbound）

```
平台 Webhook/WS 事件
  → 渠道插件 ingest() 规范化
  → classify() 事件分类
  → preflight() 预检（可能提前 drop）
  → message-access/runtime.ts: resolveChannelMessageIngress()
      → 构建 IngressStateInput（subject/allowlists/routeFacts/event）
      → state.ts: resolveChannelIngressState() 规范化允许列表
      → decision.ts: decideChannelIngress() 求值访问图
      → 返回 ChannelIngressDecision（admission/graph）
  → resolveTurn() 组装 Turn 上下文
  → turn/kernel.ts: runChannelTurn()
      → record 阶段：recordInboundSession()
      → dispatch 阶段：调用 agent 获取回复
      → finalize 阶段：清理历史、调用 onFinalize
```

### 出站流程（Outbound）

```
Agent 回复 payload
  → delivery.preparePayload() 预处理
  → 判断是否走持久化投递（delivery.durable）
  → 是：turn/durable-delivery.ts
      → deliverInboundReplyWithMessageSendContext()
      → message/send.ts: DurableMessageBatchSend
      → 渲染批次 → 逐 payload 发送 → 构建回执
  → 否：delivery.deliver() 直接投递
  → delivery.onDelivered() 回调
```

### 实时预览（Live Preview）

支持流式输出的渠道（如 Discord 编辑消息）使用 `message/live.ts`：

```
createLiveMessageState() → phase: "idle"
  → markLiveMessagePreviewUpdated() → phase: "previewing"
  → markLiveMessageFinalized() → phase: "finalized"
  → 或 markLiveMessageCancelled() → phase: "cancelled"
```

能力通过 `ChannelMessageLiveCapability` 声明：
- `draftPreview` — 支持草稿预览
- `previewFinalization` — 支持预览终结（编辑为最终版本）
- `nativeStreaming` — 平台原生流式支持
- `progressUpdates` — 进度更新
- `quietFinalization` — 静默终结（不通知用户）

## 渠道生命周期

### 启动

```
Gateway 启动
  → plugins/lifecycle-startup.ts: runChannelPluginStartupMaintenance()
      → 遍历所有已加载插件
      → 调用 plugin.lifecycle.runStartupMaintenance()
      → 失败不阻塞，记录警告继续
```

### 运行状态

`run-state-machine.ts` 追踪渠道活跃状态：
- `onRunStart()` — 递增活跃计数，启动心跳定时器
- `onRunEnd()` — 递减计数，清理心跳
- 心跳间隔默认 60s，通过 `setStatus` 回调发布状态补丁

### 传输层看门狗

`transport/stall-watchdog.ts` 检测连接停滞：
- `arm()` — 启动监控
- `touch()` — 更新最后活动时间
- 超时触发 `onTimeout` 回调（通常触发重连）
- 检查间隔 = max(250ms, min(5s, timeout/6))

### 状态反应控制器

`status-reactions.ts` 提供统一的 emoji 状态反馈：

```
setQueued("👀") → setThinking("🤔") → setTool("🔥") → setDone("👍")
                                                      → setError("😱")
```

特性：
- 防抖（默认 700ms）
- 停滞检测（soft 10s → "🥱"，hard 30s → "😨"）
- 工具类型识别（coding/web/generic）

## DM 策略与配对

### DM 策略类型

定义在 `plugins/dm-access.ts`：

```typescript
type ChannelDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
```

- **pairing**（默认）：未知发送者收到配对码，需 `openclaw pairing approve` 批准
- **allowlist**：仅允许列表中的发送者
- **open**：允许所有人（需显式配置 `allowFrom: ["*"]`）
- **disabled**：完全禁用 DM

### Ingress 访问图

`message-access/decision.ts` 实现有序门控图求值：

```
Route Gates → Sender Gates → Command Gate → Event Gate → Activation Gate
```

每个门产生 `AccessGraphGate`：
- `phase`: route | sender | command | event | activation
- `effect`: allow | block-dispatch | block-command | skip | observe | ignore
- `reasonCode`: 机器可读的拒绝原因

最终决策 `ChannelIngressDecision`：
- `admission`: dispatch | observe | skip | drop | pairing-required
- `decisiveGateId`: 决定性门的 ID
- `graph`: 完整访问图（用于诊断）

### 配对流程

`plugins/pairing.ts` 提供配对适配器查询：

```
listPairingChannels()        # 列出支持配对的渠道
getPairingAdapter(channelId) # 获取配对适配器
notifyPairingApproved(...)   # 批准后通知渠道插件
```

配对适配器由各渠道插件通过 `plugin.pairing` 提供，核心只负责协调。

### 允许列表解析

`message-access/runtime.ts` 合并多来源允许列表：

```
effectiveAllowFrom = mergeDmAllowFromSources({
  allowFrom,        # 配置文件中的 allowFrom
  storeAllowFrom,   # 配对存储中已批准的 ID
  dmPolicy,         # 当前 DM 策略
})
```

支持访问组（Access Groups）扩展允许列表条目。

## 渠道健康监控

### 账户快照

`plugins/status.ts` 构建渠道账户状态快照 `ChannelAccountSnapshot`：

```typescript
type ChannelAccountSnapshot = {
  accountId: string;
  enabled?: boolean;
  configured?: boolean;
  statusState?: string;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  restartPending?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  // ...
};
```

构建路径：
1. 优先使用 `plugin.status.buildAccountSnapshot()`（插件自定义）
2. 回退到通用逻辑：从 `resolveAccount` + `isEnabled` + `isConfigured` 推导

### 状态探测

插件可实现 `status.probeAccount()` 进行主动健康检查：
- 超时控制
- 结果通过 `formatCapabilitiesProbe()` 格式化为诊断行

### 状态问题

`ChannelStatusIssue` 分类：
- `intent` — 意图问题（配置不完整）
- `permissions` — 权限不足
- `config` — 配置错误
- `auth` — 认证失败
- `runtime` — 运行时异常

### Doctor 集成

插件通过 `plugin.doctor` 适配器参与 `openclaw doctor` 诊断：
- 检查配置一致性
- 检测过时的遗留配置
- 验证凭证有效性
