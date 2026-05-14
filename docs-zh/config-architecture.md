---
title: 配置系统架构
summary: OpenClaw 配置模块（src/config）的内部架构文档，面向维护者，涵盖代码地图、配置层次模型、Schema 验证、加载流程、热重载机制、环境变量覆盖及类型系统。
---

# 配置系统架构

## 代码地图

`src/config/` 是 OpenClaw 的配置核心模块，约 180+ 个文件，按职责分为以下子系统：

### 入口与导出

| 文件 | 职责 |
|------|------|
| `config.ts` | 公共 API barrel，re-export `io.ts`、`runtime-snapshot.ts`、`validation.ts`、`paths.ts` 等核心函数 |
| `types.ts` | 类型 barrel，聚合所有 `types.*.ts` 子模块的导出 |

### 类型定义（types.*）

按领域拆分为 30+ 个类型文件：

- `types.openclaw.ts` — 顶层 `OpenClawConfig` 类型、`ConfigFileSnapshot`、`ResolvedSourceConfig`、`RuntimeConfig`
- `types.base.ts` — 基础通道类型（`ReplyMode`、`TypingMode`、`DmPolicy`、`StreamingMode` 等）
- `types.agent-defaults.ts` — Agent 默认配置类型
- `types.gateway.ts` — Gateway 配置
- `types.discord.ts` / `types.telegram.ts` / `types.slack.ts` / ... — 各通道配置类型
- `types.models.ts` — 模型定义、成本、能力
- `types.tools.ts` — 工具配置
- `types.secrets.ts` — 密钥引用系统

### Schema 定义（zod-schema.*）

基于 Zod 的运行时验证 schema：

- `zod-schema.ts` — 顶层 `OpenClawSchema`，组合所有子 schema
- `zod-schema.core.ts` — 核心 schema（模型、密钥、颜色等）
- `zod-schema.providers-core.ts` — Provider 配置 schema（62KB，最大单文件）
- `zod-schema.agent-runtime.ts` — Agent 运行时工具 schema
- `zod-schema.agent-defaults.ts` — Agent 默认值 schema
- `zod-schema.session.ts` — 会话配置 schema
- `zod-schema.hooks.ts` / `zod-schema.installs.ts` / `zod-schema.proxy.ts` — 其他子 schema

### Schema 文档与 UI

- `schema.ts` — JSON Schema 生成（供 Control UI 和 `$schema` 引用）
- `schema-base.ts` — 从 Zod schema 生成 JSON Schema 并注入文档
- `schema.help.ts` — 字段描述文本（188KB）
- `schema.labels.ts` — 字段标题标签（60KB）
- `schema.hints.ts` — UI 提示（sensitive 标记、输入类型等）
- `schema.tags.ts` — 派生标签系统

### 配置 I/O

- `io.ts` — 核心 I/O 层（85KB），包含 `createConfigIO()`、`loadConfig()`、`writeConfigFile()`、`readConfigFileSnapshot()` 等
- `io.write-prepare.ts` — 写入前的 merge-patch 计算、env ref 恢复
- `io.audit.ts` — 配置写入审计日志
- `io.observe-recovery.ts` — 配置损坏观测与恢复
- `io.clobber-snapshot.ts` — 覆写快照保存
- `io.invalid-config.ts` — 无效配置错误处理

### 运行时状态

- `runtime-snapshot.ts` — 运行时配置快照管理（内存单例）
- `runtime-overrides.ts` — CLI/RPC 运行时覆盖（不持久化）
- `runtime-schema.ts` — 运行时 schema 查询
- `runtime-group-policy.ts` — 运行时群组策略

### 配置加载辅助

- `paths.ts` — 配置路径解析（`~/.openclaw/openclaw.json`）
- `includes.ts` — `$include` 指令处理
- `env-substitution.ts` — `${VAR}` 环境变量替换
- `env-preserve.ts` — 写入时恢复 env ref
- `config-env-vars.ts` — `env.vars` 配置项注入进程环境
- `materialize.ts` — 从源配置物化为运行时配置（应用默认值）
- `defaults.ts` — 各子系统默认值应用

### 验证

- `validation.ts` — 配置验证主逻辑（54KB），含 plugin-aware 验证
- `allowed-values.ts` — 枚举值约束

### 其他

- `sessions/` — 会话存储子系统（store、transcript、cleanup 等）
- `plugin-auto-enable.*` — 插件自动启用逻辑
- `backup-rotation.ts` — 配置备份轮转
- `redact-snapshot.ts` — 敏感信息脱敏
- `merge-patch.ts` — RFC 7396 JSON Merge Patch 实现
- `mutate.ts` — 原子配置修改（read-modify-write）

---

## 配置层次模型

OpenClaw 配置系统有三个层次的配置表示：

```
┌─────────────────────────────────────────────────────┐
│  磁盘文件 (openclaw.json / JSON5)                    │
│  ↓ 读取 + JSON5 解析                                │
├─────────────────────────────────────────────────────┤
│  ResolvedSourceConfig (源配置)                       │
│  = 磁盘内容 + $include 合并 + ${ENV} 替换            │
│  ↓ materializeRuntimeConfig()                       │
├─────────────────────────────────────────────────────┤
│  RuntimeConfig (运行时配置)                           │
│  = 源配置 + 默认值填充 + 路径规范化 + 覆盖应用        │
└─────────────────────────────────────────────────────┘
```

### 关键类型

```typescript
// 用户编写的配置（磁盘形态）
type OpenClawConfig = { /* 所有可选字段 */ };

// $include + ${ENV} 解析后的源配置（品牌类型）
type ResolvedSourceConfig = OpenClawConfig;

// 应用默认值后的运行时配置（品牌类型）
type RuntimeConfig = OpenClawConfig;
```

### ConfigFileSnapshot

配置快照是贯穿整个系统的核心数据结构：

```typescript
type ConfigFileSnapshot = {
  path: string;              // 配置文件路径
  exists: boolean;           // 文件是否存在
  raw: string | null;        // 原始文件内容
  parsed: unknown;           // JSON5 解析结果（未经 include/env 处理）
  sourceConfig: ResolvedSourceConfig;  // include + env 解析后
  resolved: ResolvedSourceConfig;      // 同 sourceConfig（写入操作用）
  valid: boolean;            // 验证是否通过
  runtimeConfig: RuntimeConfig;        // 运行时配置
  hash?: string;             // SHA-256 哈希（变更检测用）
  issues: ConfigValidationIssue[];     // 验证错误
  warnings: ConfigValidationIssue[];   // 验证警告
  legacyIssues: LegacyConfigIssue[];   // 遗留配置问题
};
```

---

## Schema 定义与验证

### Zod Schema 体系

配置验证基于 Zod，顶层 schema 为 `OpenClawSchema`（`zod-schema.ts`），由多个子 schema 组合：

```typescript
// zod-schema.ts 结构示意
const OpenClawSchema = z.object({
  $schema: z.string().optional(),
  meta: MetaSchema.optional(),
  auth: AuthSchema.optional(),
  models: ModelsConfigSchema.optional(),
  channels: ChannelsSchema.optional(),
  agents: AgentsSchema.optional(),
  tools: ToolsSchema.optional(),
  session: SessionSchema.optional(),
  gateway: GatewaySchema.optional(),
  // ... 40+ 顶层字段
}).strict();
```

子 schema 文件按领域组织：
- `zod-schema.core.ts` — `ModelsConfigSchema`、`SecretsConfigSchema`、`SecretInputSchema`
- `zod-schema.providers-core.ts` — 各 Provider 的详细配置 schema
- `zod-schema.agent-runtime.ts` — `ToolsSchema`
- `zod-schema.session.ts` — `SessionSchema`、`CommandsSchema`、`MessagesSchema`

### 敏感字段标记

`zod-schema.sensitive.ts` 导出 `sensitive()` 辅助函数，用于在 schema 中标记敏感字段：

```typescript
// 标记为敏感的字段在 JSON Schema 输出中会带 x-sensitive 标记
const apiKey = sensitive(z.string());
```

### 验证流程

`validation.ts` 提供两级验证：

1. **Zod schema 验证** — 结构/类型检查
2. **语义验证** — 跨字段逻辑检查（如 allowlist 需要 allowFrom、模型引用有效性、插件配置合法性等）

```typescript
function validateConfigObjectWithPlugins(raw: unknown, options): ValidationResult {
  // 1. Zod parse
  const zodResult = OpenClawSchema.safeParse(stripped);
  // 2. 语义验证（agent dirs、model refs、channel metadata、plugin schemas...）
  // 3. 收集 issues + warnings
}
```

Plugin-aware 验证会加载 `PluginMetadataSnapshot`，根据已安装插件的 manifest 验证插件特定配置。

### JSON Schema 生成

`schema-base.ts` 从 Zod schema 生成标准 JSON Schema（供 IDE 自动补全和 Control UI）：

```typescript
function computeBaseConfigSchemaResponse(): ConfigSchema {
  // 1. zodToJsonSchema(OpenClawSchema)
  // 2. 注入 schema.help.ts 的描述
  // 3. 注入 schema.labels.ts 的标题
  // 4. 应用 sensitive hints
  // 5. 应用 derived tags
}
```

---

## 配置加载流程

### 启动加载（loadConfig）

```
loadConfig()
  └─ loadPinnedRuntimeConfig(createConfigIO().loadConfig)
       ├─ 如果已有 runtimeConfigSnapshot → 直接返回（单例缓存）
       └─ 首次加载：
            ├─ maybeLoadDotEnvForConfig()          // 加载 .env
            ├─ fs.readFileSync(configPath)         // 读取 openclaw.json
            ├─ JSON5.parse(raw)                    // 解析 JSON5
            ├─ resolveConfigIncludes()             // 处理 $include
            ├─ resolveConfigEnvVars()              // 处理 ${ENV}
            ├─ migrateShippedPluginInstallRecords()// 迁移插件安装记录
            ├─ validateConfigObjectWithPlugins()   // Zod + 语义验证
            ├─ materializeRuntimeConfig(cfg, "load")
            │    ├─ applyMessageDefaults()
            │    ├─ applyLoggingDefaults()
            │    ├─ applySessionDefaults()
            │    ├─ applyAgentDefaults()
            │    ├─ applyContextPruningDefaults()
            │    ├─ applyCompactionDefaults()
            │    ├─ applyModelDefaults()
            │    ├─ applyTalkConfigNormalization()
            │    ├─ normalizeConfigPaths()
            │    └─ normalizeExecSafeBinProfiles()
            ├─ finalizeLoadedRuntimeConfig()
            │    ├─ findDuplicateAgentDirs()       // 检查 agent 目录冲突
            │    ├─ applyConfigEnvVars()           // env.vars → process.env
            │    ├─ loadShellEnvFallback()         // 可选 shell env 加载
            │    ├─ ensureOwnerDisplaySecret()     // 确保 owner display secret
            │    └─ applyConfigOverrides()         // 应用运行时覆盖
            └─ setRuntimeConfigSnapshot(config)    // 缓存到内存单例
```

### $include 处理

`includes.ts` 实现模块化配置合并：

- 支持单文件或数组：`"$include": "./base.json5"` 或 `["./a.json5", "./b.json5"]`
- 最大嵌套深度：10 层
- 最大单文件大小：2MB
- 路径安全：限制在配置目录内（或 `OPENCLAW_INCLUDE_ROOTS` 指定的额外目录）
- 循环检测：`CircularIncludeError`
- 合并策略：深度对象合并，后者覆盖前者

### 环境变量替换

`env-substitution.ts` 处理 `${VAR_NAME}` 语法：

- 仅匹配大写环境变量：`/^[A-Z_][A-Z0-9_]*$/`
- 转义语法：`$${VAR}` 输出字面量 `${VAR}`
- 缺失变量：生成警告（不抛错），功能降级
- 写入时恢复：`env-preserve.ts` 在写回磁盘时将值还原为 `${VAR}` 引用

---

## 热重载机制

### 架构概览

```
┌──────────────────────────────────────────────────────┐
│  Gateway 进程                                         │
│                                                      │
│  ┌─────────────────┐    ┌──────────────────────────┐ │
│  │ chokidar watcher│───→│ startGatewayConfigReloader│ │
│  │ (openclaw.json) │    │                          │ │
│  └─────────────────┘    │  debounce → readSnapshot │ │
│                         │  → diffConfigPaths       │ │
│  ┌─────────────────┐    │  → buildGatewayReloadPlan│ │
│  │ In-process write│───→│  → onHotReload/onRestart │ │
│  │ (writeConfigFile)    │                          │ │
│  └─────────────────┘    └──────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### startGatewayConfigReloader（`src/gateway/config-reload.ts`）

核心热重载控制器，职责：

1. **文件监听** — 使用 chokidar 监听 `openclaw.json`，配置 `awaitWriteFinish`（200ms 稳定阈值）
2. **进程内写入订阅** — 通过 `subscribeToWrites` 监听 `writeConfigFile` 的通知，避免重复读盘
3. **防抖** — 可配置的 debounce 延迟（`gateway.reload.debounceMs`）
4. **快照读取与验证** — 调用 `readConfigFileSnapshot()` 获取完整快照
5. **变更检测** — `diffConfigPaths()` 对比当前配置与新配置的差异路径
6. **重载计划** — `buildGatewayReloadPlan()` 根据变更路径决定：
   - 哪些通道需要重启
   - 是否需要重载 hooks/cron/plugins
   - 是否需要完整 gateway 重启
7. **执行** — 热重载（`onHotReload`）或完整重启（`onRestart`）

### 重载模式

通过 `gateway.reload.mode` 配置：
- `"hot"`（默认）— 尽可能热重载，仅必要时重启
- `"restart"` — 任何变更都触发完整重启
- `"off"` — 禁用自动重载

### 运行时快照管理

`runtime-snapshot.ts` 维护进程内单例：

```typescript
let runtimeConfigSnapshot: OpenClawConfig | null;      // 当前运行时配置
let runtimeConfigSourceSnapshot: OpenClawConfig | null; // 对应的源配置
let runtimeConfigSnapshotMetadata: RuntimeConfigSnapshotMetadata | null;
let runtimeConfigSnapshotRevision: number;             // 单调递增版本号
```

- `setRuntimeConfigSnapshot()` — 更新快照
- `getRuntimeConfigSnapshot()` — 读取快照（热路径使用）
- `loadPinnedRuntimeConfig()` — 首次加载后固定，后续返回缓存
- `registerRuntimeConfigWriteListener()` — 注册写入通知监听器
- `setRuntimeConfigSnapshotRefreshHandler()` — 注册刷新处理器（gateway 用于触发热重载）

### Skills 快照失效

当 `skills.*` 路径变更时，调用 `bumpSkillsSnapshotVersion()` 使会话缓存的 skills 快照失效，避免模型调用已移除的工具。

---

## 环境变量与 CLI 覆盖

### 环境变量层次

```
优先级（高→低）：
1. 运行时覆盖（runtime-overrides.ts）
2. 进程环境变量（process.env）
3. config env.vars 配置项
4. .env 文件（state-dir-dotenv.ts）
5. Shell env fallback（$SHELL -l -c 'env -0'）
```

### 关键环境变量

| 变量 | 作用 |
|------|------|
| `OPENCLAW_HOME` | 覆盖 home 目录 |
| `OPENCLAW_STATE_DIR` | 覆盖状态目录 |
| `OPENCLAW_NIX_MODE=1` | Nix 模式（只读配置） |
| `OPENCLAW_INCLUDE_ROOTS` | 额外的 $include 搜索路径 |
| `OPENCLAW_TEST_FAST=1` | 测试快速模式 |

### config env.vars

`config-env-vars.ts` 处理配置文件中的 `env.vars` 字段：

```json5
{
  env: {
    vars: {
      "OPENAI_API_KEY": "sk-...",
      "CUSTOM_VAR": "value"
    }
  }
}
```

- 仅在进程环境中不存在时注入
- 过滤危险变量名（`PATH`、`HOME` 等）
- 在 `finalizeLoadedRuntimeConfig()` 阶段应用

### 运行时覆盖（runtime-overrides.ts）

提供不持久化的运行时配置覆盖，用于 CLI 命令和 RPC 调用：

```typescript
setConfigOverride("agent.model", "anthropic/claude-sonnet-4-6");
unsetConfigOverride("agent.model");
applyConfigOverrides(cfg); // 深度合并覆盖到配置
```

- 支持点分路径（`a.b.c`）
- 深度合并语义
- 原型污染防护（`__proto__`、`prototype`、`constructor` 被过滤）
- 在 `finalizeLoadedRuntimeConfig()` 最后一步应用

### Nix 模式写入保护

`nix-mode-write-guard.ts`：当 `OPENCLAW_NIX_MODE=1` 时，所有配置写入操作抛出 `NixModeConfigMutationError`。

---

## 类型系统

### 类型分层

```
OpenClawConfig（顶层联合类型）
├── 品牌类型
│   ├── ResolvedSourceConfig = OpenClawConfig（语义标记：已解析源）
│   └── RuntimeConfig = OpenClawConfig（语义标记：已物化运行时）
├── 领域类型（types.*.ts）
│   ├── GatewayConfig
│   ├── AgentsConfig / AgentDefaultsConfig
│   ├── ModelsConfig / ModelDefinitionConfig
│   ├── ChannelsConfig / DiscordConfig / TelegramConfig / ...
│   ├── ToolsConfig
│   ├── SecretsConfig / SecretRef
│   ├── SessionConfig
│   └── ...（30+ 领域类型文件）
└── 运行时辅助类型
    ├── ConfigFileSnapshot
    ├── ConfigValidationIssue
    ├── LegacyConfigIssue
    ├── RuntimeConfigSnapshotMetadata
    └── ConfigWriteNotification
```

### 设计原则

1. **所有字段可选** — `OpenClawConfig` 的每个字段都是 `?` 可选的，支持最小配置
2. **品牌类型区分阶段** — `ResolvedSourceConfig` 和 `RuntimeConfig` 在结构上相同，但语义不同，防止混用
3. **领域拆分** — 每个通道/子系统有独立的类型文件，保持编辑局部性
4. **Zod 与 TS 类型对齐** — Zod schema 是运行时验证的 source of truth，TS 类型用于编译时类型检查
5. **严格模式** — Zod schema 使用 `.strict()` 拒绝未知字段
6. **生成的元数据** — `bundled-channel-config-metadata.generated.ts`（249KB）由构建脚本生成，包含所有内置通道的 schema 元数据

### 配置写入的类型安全

写入流程维护源配置与运行时配置的分离：

```typescript
// 写入时：从运行时配置反向投影到源配置形态
writeConfigFile(cfg: OpenClawConfig, options: ConfigWriteOptions)
  → createMergePatch(runtimeSnapshot, cfg)     // 计算运行时 diff
  → applyMergePatch(sourceSnapshot, patch)     // 应用到源配置
  → restoreEnvRefsFromMap()                    // 恢复 ${ENV} 引用
  → applyUnsetPathsForWrite()                  // 移除显式 unset 的路径
  → 持久化到磁盘
```

这确保写入磁盘的配置不会泄漏运行时注入的默认值，保持配置文件的简洁性。
