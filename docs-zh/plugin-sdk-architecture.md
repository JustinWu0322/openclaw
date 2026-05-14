---
title: Plugin SDK 架构
summary: OpenClaw 插件 SDK（src/plugin-sdk）的内部架构文档，面向维护者，涵盖分层设计、公开 API 表面、运行时机制、类型契约、生命周期钩子及与核心的边界规则。
---

# Plugin SDK 架构

`src/plugin-sdk/` 是插件与核心之间的**公开契约层**。所有插件（bundled 和第三方）只能通过此目录暴露的入口点与核心交互。

## 代码地图

```
src/plugin-sdk/
├── index.ts                    # 根入口，极简 re-export（类型为主）
├── core.ts                     # 主 SDK 表面：channel 插件入口、工具函数、类型导出
├── plugin-entry.ts             # definePluginEntry() — 非 channel 插件的规范入口
├── provider-entry.ts           # defineProviderPluginEntry() — provider 插件的规范入口
├── entrypoints.ts              # SDK 子路径注册表（public/private/deprecated 分类）
├── api-baseline.ts             # API 基线生成器（用于 CI 契约检查）
├── facade-runtime.ts           # Facade 懒加载运行时（bundled plugin 模块解析）
├── facade-loader.ts            # Facade 模块加载器（jiti + 缓存）
├── facade-resolution-shared.ts # Facade 路径解析共享逻辑
├── runtime.ts                  # 运行时工具导出（logger、env、abort、backup）
├── config-runtime.ts           # 配置读写运行时（deprecated，推荐窄子路径）
├── channel-lifecycle.core.ts   # Channel 生命周期原语（RunQueue、abort、状态机）
├── channel-entry-contract.ts   # Bundled channel 入口契约（懒加载 + profiling）
├── channel-ingress.ts          # Channel 入站消息处理
├── channel-streaming.ts        # Channel 流式回复
├── channel-config-helpers.ts   # Channel 配置辅助函数
├── migration-runtime.ts        # 迁移 provider 运行时辅助
├── migration.ts                # 迁移计划/冲突标记
├── provider-auth.ts            # Provider 认证流程
├── provider-stream-shared.ts   # Provider 流式共享逻辑
├── provider-model-shared.ts    # Provider 模型共享逻辑
├── provider-catalog-shared.ts  # Provider 目录共享逻辑
├── testing.ts                  # 测试辅助（插件测试契约）
├── test-helpers/               # 测试工具集（mock runtime、契约套件）
├── AGENTS.md                   # SDK 边界规则文档
└── *.runtime.ts                # 懒加载运行时子路径（按需 import）
```

**文件命名约定：**
- `*.runtime.ts` — 仅在异步路径使用的运行时模块，不应被热路径 barrel 导入
- `*.test.ts` — 共置单元测试
- `*-shared.ts` — 跨 provider/channel 的共享逻辑
- `*-contract.ts` — 契约定义（用于测试验证）

## SDK 分层设计

```
┌─────────────────────────────────────────────────────┐
│  Third-party / Bundled Plugins (extensions/*)        │
├─────────────────────────────────────────────────────┤
│  Public SDK Surface (openclaw/plugin-sdk/*)          │  ← 唯一合法入口
│  ┌───────────────────────────────────────────────┐  │
│  │ index.ts — 类型导出（极简）                     │  │
│  │ core.ts  — 主 API 表面                         │  │
│  │ plugin-entry.ts — 非 channel 入口              │  │
│  │ provider-entry.ts — provider 入口              │  │
│  │ *.runtime.ts — 按需运行时                      │  │
│  └───────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│  Facade Layer (facade-runtime / facade-loader)       │  ← bundled plugin 懒解析
├─────────────────────────────────────────────────────┤
│  Core Internals (src/channels, src/plugins, etc.)    │  ← 插件不可直接访问
└─────────────────────────────────────────────────────┘
```

**分层原则：**
1. 插件只能通过 `openclaw/plugin-sdk` 或 `openclaw/plugin-sdk/<subpath>` 导入
2. 公开子路径在 `scripts/lib/plugin-sdk-entrypoints.json` 注册
3. 私有子路径（`private-local-only`）仅限 repo 内部使用
4. Facade 子路径由 bundled plugin 提供实现，通过懒加载解析

## 公开 API 表面

### 入口点分类

| 分类 | 说明 | 示例 |
|------|------|------|
| `publicPluginSdkEntrypoints` | 第三方插件可用 | `core`, `plugin-entry`, `testing` |
| `privateLocalOnlyPluginSdkEntrypoints` | 仅 repo 内部 | 部分 runtime 子路径 |
| `deprecatedPublicPluginSdkEntrypoints` | 已废弃但保留兼容 | `config-runtime` |
| `supportedBundledFacadeSdkEntrypoints` | Facade 子路径 | `discord`, `lmstudio`, `tts-runtime` |
| `publicPluginOwnedSdkEntrypoints` | 插件拥有的公开表面 | `memory-core-host-*`, `speech-core` |

### 核心导出（index.ts）

`index.ts` 保持极简，仅导出**类型**和少量值：

```typescript
// 类型导出
export type { ChannelPlugin, ChannelId, ChannelCapabilities, ... }
export type { OpenClawPluginApi, PluginRuntime, RuntimeLogger, ... }
export type { ProviderAuthContext, ProviderAuthResult, ... }
export type { OpenClawConfig }
export type { ReplyPayload, HookEntry, SecretInput, SecretRef, ... }

// 值导出
export { emptyPluginConfigSchema }
export { registerContextEngine }
export { buildMemorySystemPromptAddition, delegateCompactionToRuntime }
export { onDiagnosticEvent }
export { optionalStringEnum, stringEnum }
```

### 主 API 表面（core.ts）

`core.ts` 是最大的公开表面，提供：

- **插件入口定义**：`definePluginEntry`, `defineChannelPluginEntry`, `defineSetupPluginEntry`
- **Channel 构建器**：`createChannelPluginBase`, `buildChannelOutboundSessionRoute`
- **配置辅助**：`buildChannelConfigSchema`, `emptyChannelConfigSchema`
- **安全/策略**：`formatPairingApproveHint`, `resolveGatewayBindUrl`
- **工具辅助**：`createActionGate`, `jsonResult`, `readStringParam`
- **会话路由**：`resolveThreadSessionKeys`, `buildAgentSessionKey`
- **去重/队列**：`KeyedAsyncQueue`, `createDedupeCache`

## 运行时 API

### runtime.ts 导出

```typescript
// 运行时环境
export { createNonExitingRuntime, defaultRuntime }
export { resolveRuntimeEnv, createLoggerBackedRuntime }

// 日志
export { info, warn, danger, success, logVerbose, setVerbose, isVerbose }

// 基础设施
export { waitForAbortSignal }
export { createBackupArchive }
export { registerUncaughtExceptionHandler }
export { removePluginFromConfig }
export { collectProviderDangerousNameMatchingScopes }
```

### Facade 运行时（facade-runtime.ts）

Facade 是 SDK 的**懒加载代理层**，用于延迟加载 bundled plugin 的实现：

```typescript
// 创建懒代理 — 首次调用时才加载目标模块
export function createLazyFacadeValue<TFacade, K>(
  loadFacadeModule: () => TFacade,
  key: K,
): TFacade[K]

// 解析 facade 模块位置
// 优先级：bundled plugins dir > registry plugins > null
function resolveFacadeModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): { modulePath: string; boundaryRoot: string } | null
```

**加载流程：**
1. 检查 bundled plugins 目录（`resolveBundledPluginsDir`）
2. 回退到 registry plugin 解析
3. 使用 `jiti` 进行源码转换加载
4. 结果缓存在 `loadedFacadeModules` Map 中

### Channel 生命周期运行时（channel-lifecycle.core.ts）

```typescript
// 创建序列化工作队列
export function createChannelRunQueue(params: ChannelRunQueueParams): ChannelRunQueue

// 被动账户生命周期（启动 → 等待 abort → 清理）
export async function runPassiveAccountLifecycle<Handle>(params): Promise<void>

// HTTP 服务器存活保持
export async function keepHttpServerTaskAlive(params): Promise<void>

// 等待 abort 信号
export function waitUntilAbort(signal?, onAbort?): Promise<void>

// 账户状态写入器
export function createAccountStatusSink(params): (patch) => void
```

## 类型契约

### 插件定义类型

```typescript
// 非 channel 插件定义
interface OpenClawPluginDefinition {
  id: string;
  name: string;
  description: string;
  kind?: "provider" | "channel" | "tool" | ...;
  configSchema: OpenClawPluginConfigSchema;
  register: (api: OpenClawPluginApi) => void;
  reload?: OpenClawPluginReloadRegistration;
  nodeHostCommands?: OpenClawPluginNodeHostCommand[];
  securityAuditCollectors?: OpenClawPluginSecurityAuditCollector[];
}

// Channel 插件定义
interface ChannelPlugin<TResolvedAccount = unknown> {
  id: string;
  meta?: ChannelMeta;
  setup: ChannelSetupAdapter;
  setupWizard?: ChannelSetupWizard;
  capabilities?: ChannelCapabilities;
  commands?: OpenClawPluginCommandDefinition[];
  security?: ChannelSecurityAdapter<TResolvedAccount>;
  pairing?: ChannelPairingAdapter;
  threading?: ChannelThreadingAdapter;
  outbound?: ChannelOutboundAdapter;
  streaming?: ChannelPlugin["streaming"];
  groups?: ChannelPlugin["groups"];
  doctor?: ChannelPlugin["doctor"];
  reload?: ChannelPlugin["reload"];
}

// Provider 插件定义
interface ProviderPlugin {
  id: string;
  label: string;
  docsPath: string;
  aliases?: string[];
  envVars?: string[];
  auth?: ProviderAuthMethod[];
  catalog: ProviderPluginCatalog;
}
```

### 运行时类型

```typescript
interface PluginRuntime {
  config: { current(): OpenClawConfig; mutateConfigFile(...); };
  logger: RuntimeLogger;
  // 会话、工具、事件等运行时 API
}

interface OpenClawPluginApi {
  registrationMode: "full" | "discovery" | "cli-metadata" | "tool-discovery";
  runtime: PluginRuntime;
  registerChannel(params: { plugin: ChannelPlugin }): void;
  registerProvider(params: { provider: ProviderPlugin }): void;
  registerTool(params: { tool: AnyAgentTool }): void;
  registerCommand(params: { command: OpenClawPluginCommandDefinition }): void;
  registerService(params: { service: OpenClawPluginService }): void;
  // ...更多注册方法
}
```

### API 基线契约

`api-baseline.ts` 使用 TypeScript Compiler API 生成 SDK 的完整导出基线：

```typescript
type PluginSdkApiBaseline = {
  generatedBy: "scripts/generate-plugin-sdk-api-baseline.ts";
  modules: PluginSdkApiModule[];  // 每个入口点的导出列表
}
```

基线文件输出到 `docs/.generated/plugin-sdk-api-baseline.json`，CI 中用于检测意外的 API 变更。

## 插件生命周期钩子

### 注册模式（Registration Modes）

`OpenClawPluginApi.registrationMode` 控制插件在不同阶段的注册行为：

| 模式 | 触发场景 | 允许的注册 |
|------|----------|-----------|
| `full` | Gateway 完整启动 | 所有注册（channel、tool、command、service） |
| `discovery` | 插件发现/枚举 | channel 注册 + CLI 元数据 |
| `cli-metadata` | CLI 命令发现 | 仅 CLI 元数据 |
| `tool-discovery` | 工具发现 | 仅 registerFull 中的工具 |

### Channel 插件生命周期

```
defineChannelPluginEntry()
  │
  ├─ registrationMode === "cli-metadata"
  │   └─ registerCliMetadata(api)  → 仅注册 CLI 命令
  │
  ├─ registrationMode === "discovery"
  │   ├─ api.registerChannel({ plugin })
  │   ├─ setRuntime(api.runtime)
  │   └─ registerCliMetadata(api)
  │
  ├─ registrationMode === "tool-discovery"
  │   └─ registerFull(api)  → 仅工具注册
  │
  └─ registrationMode === "full"
      ├─ api.registerChannel({ plugin })
      ├─ setRuntime(api.runtime)
      ├─ registerCliMetadata(api)
      └─ registerFull(api)  → 完整注册（工具、gateway handler 等）
```

### Provider 插件生命周期

`defineProviderPluginEntry()` 封装了：
1. API Key 认证方法创建（`createProviderApiKeyAuthMethod`）
2. 模型目录构建（`buildSingleProviderApiKeyCatalog`）
3. Wizard 设置解析
4. 插件注册（通过 `definePluginEntry` + `api.registerProvider`）

### 迁移生命周期

```typescript
interface MigrationProviderPlugin {
  detect(context: MigrationProviderContext): MigrationDetection;
  plan(context: MigrationProviderContext): MigrationPlan;
  apply(context: MigrationProviderContext, plan: MigrationPlan): MigrationApplyResult;
}
```

### Channel RunQueue 生命周期

```
createChannelRunQueue()
  │
  ├─ enqueue(key, task)  → 按 key 序列化执行
  │   ├─ runState.onRunStart()
  │   ├─ task({ lifecycleSignal })
  │   └─ runState.onRunEnd()
  │
  └─ deactivate()  → 停止接受新任务
```

## 与核心的边界

### 边界规则（摘自 AGENTS.md）

1. **单向依赖**：插件 → SDK → 核心。插件不可直接 import 核心内部模块
2. **导入路径限制**：
   - 插件生产代码：仅 `openclaw/plugin-sdk/*`
   - 禁止：`src/**`、`src/plugin-sdk-internal/**`、其他插件的 `src/**`
3. **Facade 隔离**：bundled plugin 通过 facade 暴露能力，不直接暴露内部实现
4. **运行时子路径**：热路径不应导入 `*.runtime.ts`，这些仅用于异步/按需场景
5. **配置契约**：导出类型、schema、metadata 必须对齐；退役的公开 key 保持退役状态

### 核心向 SDK 暴露的接口

```
src/channels/plugins/types.*.ts  → Channel 插件类型定义
src/plugins/types.ts             → 通用插件类型定义
src/plugins/runtime/types.ts     → PluginRuntime 接口
src/config/types.*.ts            → 配置类型
src/model-catalog/types.ts       → 模型目录类型
src/context-engine/types.ts      → 上下文引擎类型
src/hooks/types.ts               → Hook 类型
```

### SDK 向插件暴露的包路径

```json
{
  "./plugin-sdk": "dist/plugin-sdk/index.js",
  "./plugin-sdk/core": "dist/plugin-sdk/core.js",
  "./plugin-sdk/plugin-entry": "dist/plugin-sdk/plugin-entry.js",
  "./plugin-sdk/provider-entry": "dist/plugin-sdk/provider-entry.js",
  "./plugin-sdk/testing": "dist/plugin-sdk/testing.js",
  "./plugin-sdk/<subpath>": "dist/plugin-sdk/<subpath>.js"
}
```

### 扩展边界的流程

1. 在 `scripts/lib/plugin-sdk-entrypoints.json` 添加入口
2. 创建 `src/plugin-sdk/<name>.ts` 源文件
3. 更新 `src/plugin-sdk/entrypoints.ts` 分类
4. 更新 `package.json` exports
5. 运行 API 基线生成器更新 `docs/.generated/plugin-sdk-api-baseline.json`
6. 更新相关文档（`docs/plugins/*`）

### 验证要求

- 触及 SDK 接缝的变更必须运行 `pnpm build`
- 影响 bundled channel 启动成本的变更需运行入口点 profiler
- 破坏性删除/重命名属于 major version 工作
