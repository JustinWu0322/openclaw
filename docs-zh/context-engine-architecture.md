# 上下文引擎与记忆系统架构

> 模块路径：`src/context-engine/`、`src/memory/`、`src/memory-host-sdk/`

## 概述

上下文引擎是 OpenClaw 的可插拔上下文管理架构，控制 Agent 上下文如何组装、摄取、压缩和维护。记忆系统提供持久化的知识存储、搜索和后台整合能力。

---

## 1. 上下文引擎 (`src/context-engine/`)

### 核心接口 (`types.ts`)

`ContextEngine` 是所有上下文引擎必须实现的合约：

```typescript
interface ContextEngine {
  // 必需方法
  info: ContextEngineInfo;
  ingest(sessionKey, prompt, message, runtimeContext): Promise<IngestResult>;
  assemble(sessionKey, prompt, runtimeContext): Promise<AssembleResult>;
  compact(sessionKey, runtimeContext): Promise<CompactResult>;

  // 可选方法
  bootstrap?(sessionKey, prompt, runtimeContext): Promise<BootstrapResult>;
  maintain?(sessionKey, runtimeContext): Promise<void>;
  ingestBatch?(sessionKey, prompt, messages, runtimeContext): Promise<IngestBatchResult>;
  afterTurn?(sessionKey, prompt, runtimeContext): Promise<void>;
  prepareSubagentSpawn?(params): Promise<SubagentSpawnPreparation>;
  onSubagentEnded?(params): Promise<void>;
  dispose?(): Promise<void>;
}
```

### 关键类型

| 类型                | 说明                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `AssembleResult`    | 上下文组装结果：`messages`（有序 AgentMessage[]）、`estimatedTokens`、`promptAuthority`、`systemPromptAddition?` |
| `CompactResult`     | 压缩结果：`ok`、`compacted`、`result.summary`、`tokensBefore/After`、`sessionId/sessionFile`（会话轮转）         |
| `IngestResult`      | 摄取结果：`ingested` 布尔值（重复/空操作为 false）                                                               |
| `BootstrapResult`   | 引导结果：`bootstrapped`、历史消息导入数、可选 `reason`                                                          |
| `ContextEngineInfo` | 引擎元数据：`id`、`name`、`version`、`ownsCompaction`、`turnMaintenanceMode`                                     |

### 提示缓存类型

| 类型                                | 说明                                               |
| ----------------------------------- | -------------------------------------------------- | ------- | ------ | ----------- | ------ |
| `ContextEnginePromptCacheRetention` | `"none"                                            | "short" | "long" | "in_memory" | "24h"` |
| `ContextEnginePromptCacheUsage`     | input/output/cacheRead/cacheWrite/total token 统计 |
| `ContextEnginePromptCacheInfo`      | retention、lastCallUsage、observation、timestamps  |

### 运行时上下文

```typescript
interface ContextEngineRuntimeContext {
  allowDeferredCompactionExecution: boolean;
  tokenBudget?: number;
  currentTokenCount?: number;
  promptCache?: ContextEnginePromptCacheInfo;
  rewriteTranscriptEntries?: (request) => Promise<TranscriptRewriteResult>;
  llm?: {
    complete: (params) => Promise<CompletionResult>;
  };
}
```

- `rewriteTranscriptEntries` — 运行时拥有的会话 DAG 更新回调
- `llm` — 模型推理能力（供引擎在压缩/维护时使用）

### 安全转录重写

```typescript
interface TranscriptRewriteRequest {
  sessionId: string;
  replacements: TranscriptRewriteReplacement[]; // 按 ID 替换消息内容
}

interface TranscriptRewriteResult {
  changed: boolean;
  bytesFreed: number;
  rewrittenEntries: number;
  reason?: string;
}
```

引擎可通过此机制安全地重写会话历史（如压缩），运行时负责会话 DAG 的一致性。

---

### 注册表 (`registry.ts`)

#### 所有者模型

| 所有者         | 说明           |
| -------------- | -------------- |
| `"core"`       | 保留给默认引擎 |
| `"public-sdk"` | 第三方注册     |

- 默认引擎 ID 受保护，仅 `"core"` 所有者可注册
- 同所有者重注册需要 `allowSameOwnerRefresh`
- 注册结果：`{ ok: true }` 或 `{ ok: false; existingOwner: string }`

#### 解析流程

```
config.plugins.slots.contextEngine (显式 slot 覆盖)
    ↓
defaultSlotId (默认引擎)
    ↓
非默认引擎失败 → 静默回退到默认引擎
默认引擎失败 → 错误传播
```

#### 合约验证

解析后的引擎必须通过合约验证：

- 返回对象具有有效的 `info`（含 `id` 和 `name`）
- 具有 `ingest()`、`assemble()`、`compact()` 方法

#### 进程全局单例

注册表存储在 `Symbol.for("openclaw.contextEngineRegistryState")` 全局单例中，确保重复的 dist chunk 共享同一映射。

#### 向后兼容 Proxy

`wrapContextEngineWithSessionKeyCompat()` 返回一个 Proxy：

1. 首次调用传入全部参数
2. 出错时检测被拒绝的参数键（Zod `unrecognized_keys` 或正则匹配验证消息）
3. 去除被拒绝键后重试，并缓存结果

---

### 委托助手 (`delegate.ts`)

#### `delegateCompactionToRuntime()`

桥接公共 `ContextEngine.compact()` 合约到 OpenClaw 内部 `compactEmbeddedPiSessionDirect` 运行时函数：

```typescript
// 惰性加载运行时模块
const mod = await import("../agents/pi-embedded-runner/compact.runtime.js");
// 映射公共参数到内部格式
```

- `compactionTarget` 参数在公共合约中存在但内部运行时不暴露，因此被有意忽略
- 第三方引擎可复用内置压缩算法而无需重新实现

#### `buildMemorySystemPromptAddition()`

构建记忆/维基指导的系统提示注入，使非遗留引擎也能获得与遗留引擎相同的记忆提示指导：

```typescript
// 从 memory-state 模块构建记忆提示段落
// 从 prompt-cache-stability 模块归一化结构化提示
// 无记忆行时返回 undefined
```

---

### 遗留引擎 (`legacy.ts`)

`LegacyContextEngine` 是默认引擎实现，保持 100% 向后兼容：

| 方法          | 实现                                                                |
| ------------- | ------------------------------------------------------------------- |
| `info`        | `{ id: "legacy", name: "Legacy Context Engine", version: "1.0.0" }` |
| `ingest()`    | No-op（SessionManager 已处理消息持久化）                            |
| `assemble()`  | 直传（现有 pipeline 负责组装）                                      |
| `afterTurn()` | No-op                                                               |
| `compact()`   | 委托 `delegateCompactionToRuntime()`                                |
| `dispose()`   | No-op                                                               |

设计意图：将现有运行时行为包装在 `ContextEngine` 接口后，确保切换到引擎架构时不改变任何行为。

---

## 2. 记忆文件系统 (`src/memory/`)

### 职责

最小模块，管理工作区根记忆文件路径。

### 规范名与遗留名

| 常量                              | 值                               | 说明           |
| --------------------------------- | -------------------------------- | -------------- |
| `CANONICAL_ROOT_MEMORY_FILENAME`  | `"MEMORY.md"`                    | 规范名（大写） |
| `LEGACY_ROOT_MEMORY_FILENAME`     | `"memory.md"`                    | 遗留名（小写） |
| `ROOT_MEMORY_REPAIR_RELATIVE_DIR` | `".openclaw-repair/root-memory"` | 迁移修复目录   |

### 关键函数

| 函数                                           | 说明                                                         |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `resolveCanonicalRootMemoryPath(workspaceDir)` | 返回 `workspaceDir/MEMORY.md`                                |
| `resolveLegacyRootMemoryPath(workspaceDir)`    | 返回 `workspaceDir/memory.md`                                |
| `resolveCanonicalRootMemoryFile(workspaceDir)` | 验证 `MEMORY.md` 存在且是真实文件（非符号链接），否则 `null` |
| `shouldSkipRootMemoryAuxiliaryPath(absPath)`   | 过滤遗留文件和修复目录                                       |

### 设计要点

- 使用 `fs.readdir` + `withFileTypes: true` 精确检测文件类型
- 明确排除符号链接，防止路径遍历
- 遗留文件和修复工件不作为活跃记忆源

---

## 3. 记忆宿主 SDK (`src/memory-host-sdk/`)

### 概述

宿主侧记忆 SDK，管理存储、搜索、后台处理和事件。源码实际位于 `packages/memory-host-sdk/src/`，通过重导出映射到 `src/`。

### 子模块总览

| 模块                | 职责                                     |
| ------------------- | ---------------------------------------- |
| `query.ts`          | 查询关键词提取（FTS 全文搜索，去停用词） |
| `status.ts`         | 记忆 Provider 状态类型                   |
| `engine-qmd.ts`     | QMD 二进制可用性检查                     |
| `engine-storage.ts` | 存储引擎后端配置解析                     |
| `secret.ts`         | API Key/凭据解析                         |
| `multimodal.ts`     | 多模态记忆支持（非文本内容存储/检索）    |
| `dreaming.ts`       | Dreaming 系统（后台记忆整合）            |
| `events.ts`         | 事件日志                                 |
| `host/`             | 后端配置、嵌入输入类型、宿主特定类型     |

---

### Dreaming 系统 (`dreaming.ts`)

受人类睡眠阶段启发的后台记忆整合系统。

#### 三阶段架构

| 阶段      | 频率            | Cron 表达式   | 功能                                      | 回溯 |
| --------- | --------------- | ------------- | ----------------------------------------- | ---- |
| **Light** | 每 6 小时       | `0 */6 * * *` | 去重相似记忆，相似度阈值 0.9              | 2 天 |
| **Deep**  | 每天凌晨 3 点   | `0 3 * * *`   | 短期→长期提升，评分/召回/唯一查询最低要求 | -    |
| **REM**   | 每周日凌晨 5 点 | `0 5 * * 0`   | 跨记忆模式提取，模式强度最低 0.75         | 7 天 |

#### Deep Dreaming 参数

```typescript
{
  limit: 10,              // 每次最大候选数
  minScore: 0.8,          // 最低置信分
  minRecallCount: 3,      // 最低被召回次数
  minUniqueQueries: 3,    // 最低不同查询数
  recencyHalfLife: 14,    // 天，新近度半衰期
  maxAge: 30,             // 天，最大候选年龄
}
```

#### 恢复模式

当记忆健康度低于阈值 (0.35) 时自动进入恢复模式：

```typescript
{
  lookback: 30,           // 天，回溯窗口
  maxCandidates: 20,
  minConfidence: 0.9,     // 恢复期最低置信度
  autoWriteMinConfidence: 0.97,  // 自动写入最低置信度
}
```

#### 执行质量

| 维度     | 选项      |
| -------- | --------- | ---------- | ------------ |
| 速度     | `"fast"   | "balanced" | "slow"`      |
| 思考深度 | `"low"    | "medium"   | "high"`      |
| 预算     | `"cheap"  | "medium"   | "expensive"` |
| 存储模式 | `"inline" | "separate" | "both"`      |

#### 数据源

| 阶段  | 可用源    |
| ----- | --------- | ---------- | ---------- | ------ | --------- |
| Light | `"daily"  | "sessions" | "recall"`  |
| Deep  | `"daily"  | "memory"   | "sessions" | "logs" | "recall"` |
| REM   | `"memory" | "daily"    | "deep"`    |

---

### 事件系统 (`events.ts`)

记录记忆操作事件到 JSONL 日志。

#### 事件日志路径

`memory/.dreams/events.jsonl`

#### 事件类型

| 事件类型                   | 说明              | 关键字段                                          |
| -------------------------- | ----------------- | ------------------------------------------------- |
| `memory.recall.recorded`   | 记忆召回查询完成  | `query`, `resultCount`, `results[]` (path, score) |
| `memory.promotion.applied` | 记忆提升已应用    | `memoryPath`, `applied`, `candidates[]`           |
| `memory.dream.completed`   | Dreaming 阶段完成 | `phase`, `inlinePath`, `reportPath`, `lineCount`  |

#### 函数

- `resolveMemoryHostEventLogPath(workspaceDir)` — 解析事件日志绝对路径
- `appendMemoryHostEvent(event, workspaceDir)` — 追加事件到 JSONL，自动创建目录

---

## 跨模块关系

```
                    ContextEngine 接口
                         |
          +--------------+--------------+
          |              |              |
     LegacyEngine    第三方引擎      插件注册
     (默认/直传)    (自定义逻辑)    (public-sdk)
          |              |
     delegate.ts    delegate.ts
     (压缩委托)     (可选复用内置压缩)
          |
     compact.runtime.ts
     (Pi 嵌入式运行器)

  memory-host-sdk/
  ├── dreaming.ts ←── Cron 调度触发
  ├── events.ts   ←── 所有记忆操作
  ├── query.ts    ←── FTS 关键词提取
  └── engine-*.ts ←── 存储后端配置
          |
     MEMORY.md (根记忆文件)
     memory/ (工作区记忆目录)
```

## 设计模式总结

1. **可插拔架构**：`ContextEngine` 接口允许核心逻辑与上下文管理实现解耦
2. **零破坏迁移**：`LegacyContextEngine` 包装现有行为，默认不改变任何语义
3. **进程全局注册**：使用 Symbol 全局单例确保重复 dist chunk 共享状态
4. **Proxy 兼容层**：自动处理引擎不识别的参数，透明降级
5. **受睡眠启发的整合**：Dreaming 系统的三阶段类比人类睡眠，分别处理去重、提升和模式提取
6. **健康感知**：Deep Dreaming 的恢复模式在记忆健康度低时自动加强整合
7. **安全重写**：转录重写通过运行时回调执行，引擎不直接修改会话 DAG
