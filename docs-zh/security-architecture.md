---
title: 安全模块架构
summary: OpenClaw 安全子系统的实现细节，涵盖审计框架、沙箱隔离、工具权限策略、凭证管理、DM 配对安全和输入验证机制。面向维护者的内部架构文档。
---

# 安全模块架构

本文档面向维护者，详细描述 OpenClaw 安全子系统的实现结构和关键设计决策。

## 代码地图

安全相关代码分布在两个主要目录：

### `src/security/` — 安全审计与策略执行

| 文件 | 职责 |
|------|------|
| `audit.ts` | 安全审计主入口，编排所有审计检查项 |
| `audit.types.ts` | 审计报告类型定义（`SecurityAuditFinding`, `SecurityAuditReport`, `SecurityAuditSummary`） |
| `audit-extra.sync.ts` | 同步审计检查集合（~40KB，大量检查逻辑） |
| `audit-extra.async.ts` | 异步审计检查集合（需要 I/O 的检查） |
| `audit-extra.summary.ts` | 审计摘要生成，包含模型风险、工具策略汇总 |
| `audit-gateway-config.ts` | Gateway 配置安全审计（绑定地址、认证、CORS） |
| `audit-channel.ts` | 渠道安全审计（DM 策略、凭证状态） |
| `audit-plugins-trust.ts` | 插件信任模型审计（注册表验证、工具策略） |
| `audit-workspace-skills.ts` | 工作区 Skill 文件逃逸检测 |
| `audit-model-refs.ts` | 模型引用安全检查 |
| `audit-deep-probe-findings.ts` | 深度 Gateway 探测结果收集 |
| `audit-deep-code-safety.ts` | 深度代码安全扫描 |
| `fix.ts` | 安全修复执行器（chmod/icacls 权限修复） |
| `dm-policy-shared.ts` | DM 策略决策逻辑（配对/允许/阻止） |
| `dangerous-tools.ts` | 高危工具常量定义（Gateway HTTP 拒绝列表） |
| `dangerous-config-flags.ts` | 危险配置标志收集器 |
| `dangerous-config-flags-core.ts` | 核心危险标志检测 |
| `core-dangerous-config-flags.ts` | 基础危险标志列表 |
| `exec-filesystem-policy.ts` | 执行/文件系统策略漂移检测 |
| `external-content.ts` | 外部内容安全包装（防注入） |
| `external-content-source.ts` | 外部内容来源分类 |
| `skill-scanner.ts` | Skill 代码安全扫描器 |
| `safe-regex.ts` | 正则表达式安全编译（防 ReDoS） |
| `secret-equal.ts` | 时间安全的密钥比较 |
| `context-visibility.ts` | 上下文可见性策略（历史/引用/转发消息过滤） |
| `channel-metadata.ts` | 不可信渠道元数据包装 |
| `config-regex.ts` | 配置中正则表达式的安全处理 |
| `scan-paths.ts` | 路径安全检查工具 |
| `windows-acl.ts` | Windows ACL 权限检查 |
| `installed-plugin-dirs.ts` | 已安装插件目录安全过滤 |

### `src/secrets/` — 凭证管理系统

| 文件 | 职责 |
|------|------|
| `resolve.ts` | Secret 引用解析器（文件/exec/env 提供者） |
| `runtime.ts` | Secrets 运行时快照管理 |
| `apply.ts` | Secret 配置应用（写入配置/auth-profiles） |
| `plan.ts` | Secret 配置计划生成 |
| `configure.ts` | Secret 交互式配置流程 |
| `configure-plan.ts` | 配置候选项发现与计划构建 |
| `target-registry-data.ts` | Secret 目标注册表数据（所有已知凭证路径） |
| `target-registry-query.ts` | 注册表查询引擎 |
| `target-registry-types.ts` | 注册表类型定义 |
| `credential-matrix.ts` | 凭证矩阵文档生成 |
| `provider-env-vars.ts` | 提供者环境变量映射 |
| `channel-env-vars.ts` | 渠道环境变量映射 |
| `channel-contract-api.ts` | 渠道凭证合约 API |
| `auth-store-paths.ts` | Auth Profile 存储路径发现 |
| `auth-profiles-scan.ts` | Auth Profile 扫描 |
| `runtime-web-tools.ts` | Web 工具凭证运行时 |
| `runtime-gateway-auth-surfaces.ts` | Gateway 认证表面运行时 |
| `runtime-config-collectors-core.ts` | 核心配置收集器 |
| `ref-contract.ts` | Secret 引用合约（ID 验证规则） |
| `secret-value.ts` | Secret 值断言 |
| `path-utils.ts` | JSON 路径操作工具 |
| `storage-scan.ts` | 存储扫描（发现 auth store 文件） |
| `exec-resolution-policy.ts` | Exec 类型 Secret 解析策略 |
| `unsupported-surface-policy.ts` | 不支持的 Secret 表面策略 |

### `src/agents/sandbox/` — 沙箱实现

| 文件 | 职责 |
|------|------|
| `config.ts` | 沙箱配置解析（模式/后端/作用域） |
| `types.ts` | 沙箱类型定义（`SandboxConfig`, `SandboxContext`） |
| `docker.ts` | Docker 沙箱后端实现 |
| `docker-backend.ts` | Docker 后端抽象层 |
| `ssh.ts` / `ssh-backend.ts` | SSH 沙箱后端 |
| `tool-policy.ts` | 沙箱工具策略解析 |
| `validate-sandbox-security.ts` | 沙箱安全验证 |
| `fs-bridge.ts` / `fs-bridge-path-safety.ts` | 文件系统桥接与路径安全 |
| `context.ts` | 沙箱上下文构建 |
| `registry.ts` | 沙箱实例注册表 |
| `browser.ts` | 浏览器沙箱（Chromium in Docker） |
| `sanitize-env-vars.ts` | 环境变量清洗 |
| `prune.ts` | 沙箱清理（空闲/过期容器） |

## 安全分层模型

OpenClaw 安全架构采用分层防御设计：

```
┌─────────────────────────────────────────────────────┐
│  Layer 4: 输入验证 & 内容安全                         │
│  (external-content.ts, safe-regex.ts, channel-metadata.ts) │
├─────────────────────────────────────────────────────┤
│  Layer 3: 工具权限策略                                │
│  (dangerous-tools.ts, exec-filesystem-policy.ts,     │
│   tool-policy.ts, sandbox/tool-policy.ts)            │
├─────────────────────────────────────────────────────┤
│  Layer 2: 沙箱隔离                                   │
│  (sandbox/docker.ts, sandbox/ssh.ts,                 │
│   sandbox/validate-sandbox-security.ts)              │
├─────────────────────────────────────────────────────┤
│  Layer 1: 认证 & 凭证管理                            │
│  (secrets/resolve.ts, secret-equal.ts,               │
│   gateway-auth, dm-policy-shared.ts)                 │
├─────────────────────────────────────────────────────┤
│  Layer 0: 审计 & 可观测性                            │
│  (audit.ts, fix.ts, skill-scanner.ts)                │
└─────────────────────────────────────────────────────┘
```

### 审计严重性分级

```typescript
type SecurityAuditSeverity = "info" | "warn" | "critical";
```

- **critical**: 立即可利用的安全风险（如 DM 策略为 open、Gateway 无认证暴露到公网）
- **warn**: 配置不当但需要额外条件才能利用
- **info**: 安全建议或信息性发现

### 审计执行模式

审计分为两种深度：

1. **非深度审计**（默认）：纯配置分析，无网络 I/O
2. **深度审计**（`deep: true`）：包含 Gateway 探测、代码安全扫描、Docker 标签检查

深度审计通过动态导入（`*.runtime.ts`）延迟加载重型依赖，避免启动时性能损耗。

## 沙箱机制

### 沙箱模式

```typescript
type SandboxConfig = {
  mode: "off" | "non-main" | "all";
  backend: "docker" | "ssh" | "openshell";
  scope: "session" | "agent" | "shared";
  workspaceAccess: "none" | "ro" | "rw";
  // ...
};
```

- **off**: 无沙箱，工具直接在宿主机执行
- **non-main**: 仅非 `main` 会话使用沙箱（推荐用于群组/渠道安全）
- **all**: 所有会话均在沙箱中执行

### Docker 后端

Docker 沙箱是默认后端，关键安全特性：

- 容器命名前缀隔离（`DEFAULT_SANDBOX_CONTAINER_PREFIX`）
- 工作区挂载控制（`workspaceAccess: none | ro | rw`）
- 网络隔离（默认 `none`，浏览器沙箱使用 `bridge`）
- 危险 Docker 配置标志保护：
  - `dangerouslyAllowReservedContainerTargets`
  - `dangerouslyAllowExternalBindSources`
  - `dangerouslyAllowContainerNamespaceJoin`
- 配置哈希驱动的容器重建（配置变更时自动重建）
- 空闲/过期容器自动清理（`prune.ts`）

### SSH 后端

SSH 后端用于远程沙箱执行：

- 支持 identity file / certificate / known hosts
- 独立工作区根目录（`/tmp/openclaw-sandboxes`）
- 严格主机密钥检查可配置

### 文件系统桥接

`fs-bridge.ts` 和 `fs-bridge-path-safety.ts` 实现宿主机与沙箱之间的安全文件操作：

- 路径遍历防护（`isPathInside` 检查）
- 符号链接解析后的边界验证
- 锚定操作（anchored ops）确保所有文件操作在允许的目录内

### 环境变量清洗

`sanitize-env-vars.ts` 在传递环境变量到沙箱时过滤敏感信息，防止凭证泄露到隔离环境。

## 工具权限策略

### Gateway HTTP 工具拒绝列表

`dangerous-tools.ts` 定义了通过 Gateway HTTP `POST /tools/invoke` 默认拒绝的高危工具：

```typescript
const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  "exec", "spawn", "shell",        // RCE 表面
  "fs_write", "fs_delete", "fs_move", // 文件变更
  "apply_patch",                     // 任意文件重写
  "sessions_spawn", "sessions_send", // 会话编排
  "cron",                            // 持久化自动化
  "gateway",                         // 控制面重配置
  "nodes",                           // 节点命令中继
];
```

### 沙箱工具策略

工具策略通过 allow/deny 列表控制沙箱内可用工具：

```typescript
type SandboxToolPolicy = {
  allow?: string[];
  deny?: string[];
};
```

策略解析优先级（从高到低）：
1. Agent 级别配置（`agents.list[].tools.sandbox.tools`）
2. 全局配置（`tools.sandbox.tools`）
3. 默认值（`DEFAULT_TOOL_ALLOW` / `DEFAULT_TOOL_DENY`）

支持 glob 模式匹配（通过 `compileGlobPatterns`）。

### 执行/文件系统策略漂移检测

`exec-filesystem-policy.ts` 检测配置矛盾：当运行时工具（exec/process）被允许但文件系统变更工具（write/edit/apply_patch）被禁用时，报告策略漂移。这种配置可能导致 agent 通过 exec 绕过文件系统限制。

### 工具 Profile 策略

通过 `tools.profile` 配置预设策略集，与沙箱策略和全局策略叠加生效。`isToolAllowedByPolicies` 函数遍历所有策略层，任一 deny 匹配即拒绝。

## 凭证管理（secrets）

### 架构概览

凭证管理系统采用声明式设计：

```
配置声明 (SecretRef) → 解析 (resolve.ts) → 运行时快照 (runtime.ts) → 应用 (apply.ts)
```

### Secret 引用（SecretRef）

凭证通过 `SecretRef` 声明式引用，支持多种提供者：

- **file**: 从文件读取（支持 JSON pointer）
- **exec**: 执行命令获取（有 ID 验证规则防注入）
- **env**: 从环境变量读取

```typescript
type SecretRef = {
  source: SecretRefSource; // "file" | "exec" | "env"
  provider?: string;
  id: string;
};
```

### 解析器安全特性（`resolve.ts`）

- 并发限制（`DEFAULT_PROVIDER_CONCURRENCY = 4`）
- 每提供者最大引用数（`DEFAULT_MAX_REFS_PER_PROVIDER = 512`）
- 批量字节限制（`DEFAULT_MAX_BATCH_BYTES = 256KB`）
- 文件大小限制（`DEFAULT_FILE_MAX_BYTES = 1MB`）
- 超时控制（文件 5s，exec 5s）
- exec 输出大小限制（`DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1MB`）
- 文件权限检查（通过 `readSecureFile` / `inspectPathPermissions`）
- 路径遍历防护（`isPathInside`）
- exec ref ID 验证（防命令注入）
- 解析缓存（`SecretRefResolveCache`）避免重复解析

### 目标注册表（Target Registry）

`target-registry-data.ts` 维护所有已知凭证路径的注册表，用于：

- 审计：发现未配置/过期的凭证
- 配置向导：引导用户设置凭证
- 计划生成：确定需要解析的凭证集合

每个注册表条目定义：
```typescript
type SecretTargetRegistryEntry = {
  id: string;
  configFile: "openclaw.json" | "auth-profiles.json";
  pathPattern: string;          // 配置路径模式
  secretShape: "secret_input" | "sibling_ref";
  includeInPlan: boolean;
  includeInConfigure: boolean;
  includeInAudit: boolean;
  // ...
};
```

### 运行时快照

`runtime.ts` 管理凭证运行时状态：

- 启动时构建 `PreparedSecretsRuntimeSnapshot`
- 包含解析后的配置、auth stores、web tools 元数据
- 支持配置变更时的增量刷新
- 环境变量敏感路径监控（`RUNTIME_PATH_ENV_KEYS`）

### Auth Profile Store

凭证存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`：

- 按 agent 隔离
- 支持 `api_key` 和 `token` 两种类型
- OAuth token 自动刷新策略
- 提供者遮蔽（shadowing）检测

### 凭证矩阵

`credential-matrix.ts` 生成结构化的凭证文档，列出所有用户提供的凭证表面，用于安全审计和文档生成。

## DM 配对安全

### 策略模型

DM（私信）访问通过分层策略控制：

```typescript
type DmGroupAccessDecision = "allow" | "block" | "pairing";
```

### 决策流程

`dm-policy-shared.ts` 实现完整的 DM 访问决策：

1. **群组消息**：检查 `groupPolicy`
   - `"open"`: 允许所有
   - `"allowlist"`: 检查 `groupAllowFrom` 列表
   - `"disabled"`: 阻止

2. **私信**：检查 `dmPolicy`
   - `"open"`: 检查 `allowFrom` 列表（`"*"` 表示全部允许）
   - `"pairing"`（默认）: 未知发送者需要配对码验证
   - `"disabled"`: 阻止所有 DM

3. **配对流程**：
   - 未知发送者收到短配对码
   - 管理员通过 `openclaw pairing approve <channel> <code>` 批准
   - 批准后发送者加入本地允许列表

### 允许列表解析

```typescript
function resolveEffectiveAllowFromLists(params): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
}
```

- 支持 store 级别允许列表（运行时动态添加）
- 支持 `groupAllowFromFallbackToAllowFrom` 回退
- 条目规范化（大小写、空白处理）

### 单一所有者检测

`resolvePinnedMainDmOwnerFromAllowlist` 检测 main 会话是否只有一个允许的 DM 发送者，用于优化单用户场景。

### 上下文可见性

`context-visibility.ts` 控制补充上下文（历史消息、引用、转发）的可见性：

- `"all"`: 所有上下文可见
- `"allowlist_quote"`: 仅允许列表中的发送者 + 引用消息
- 默认阻止非允许列表发送者的上下文

## 输入验证

### 外部内容安全包装

`external-content.ts` 是防止提示注入的核心防线：

**可疑模式检测**：
```typescript
const SUSPICIOUS_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system\s*:?\s*(prompt|override|command)/i,
  /rm\s+-rf/i,
  // ... 更多模式
];
```

**安全包装机制**：
- 使用随机 ID 的 XML 风格边界标记包装外部内容
- 每次包装生成唯一 `randomBytes(8).toString("hex")` ID
- 防止恶意内容注入伪造的边界标记
- 格式：`<<<EXTERNAL_UNTRUSTED_CONTENT id="<random>">>>...<<<END_EXTERNAL_UNTRUSTED_CONTENT id="<random>">>>`

### 正则表达式安全（safe-regex.ts）

防止 ReDoS（正则表达式拒绝服务）攻击：

- 检测嵌套重复（nested repetition）
- 分析量词组合的回溯风险
- 缓存编译结果（最大 256 条）
- 测试窗口限制（2048 字符）
- 拒绝原因分类：`"empty"` | `"unsafe-nested-repetition"` | `"invalid-regex"`

### 时间安全比较

`secret-equal.ts` 使用 `crypto.timingSafeEqual` 防止时序攻击：

- 填充到相同长度后比较
- 额外验证原始长度相等
- 处理 null/undefined 输入

### 渠道元数据清洗

`channel-metadata.ts` 对不可信渠道元数据进行：
- 空白规范化
- 长度截断（单条 400 字符，总计 800 字符）
- 去重
- 通过 `wrapExternalContent` 安全包装

### Skill 代码扫描

`skill-scanner.ts` 对工作区 Skill 代码进行静态安全分析：

- 扫描 `.js/.ts/.mjs/.cjs/.mts/.cts/.jsx/.tsx` 文件
- 文件大小限制（1MB）
- 最大扫描文件数（500）
- 跳过测试文件和目录
- 带缓存的增量扫描（基于 mtime + size）
- 目录遍历缓存（最大 5000 条）

### 危险配置标志检测

`core-dangerous-config-flags.ts` 检测已启用的危险配置：

- `gateway.controlUi.allowInsecureAuth=true`
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`
- `gateway.controlUi.dangerouslyDisableDeviceAuth=true`
- `hooks.gmail.allowUnsafeExternalContent=true`
- `hooks.mappings[N].allowUnsafeExternalContent=true`
- `tools.exec.applyPatch.workspaceOnly=false`
- 沙箱 Docker 危险布尔标志

### Gateway 配置安全审计

`audit-gateway-config.ts` 检查：

- 绑定地址（loopback vs 公网）
- 认证配置（token/password 是否设置）
- Tailscale 集成安全
- Control UI CORS 配置
- 可信代理配置
- HTTP 工具拒绝列表覆盖

### 安全修复执行器

`fix.ts` 提供自动修复能力：

- 文件/目录权限修复（chmod on Unix, icacls on Windows）
- 符号链接安全处理（跳过符号链接目标）
- 配置文件写入（修复不安全配置）
- 操作结果追踪（成功/跳过/错误）

## 设计原则

1. **声明式安全**：安全策略通过配置声明，运行时强制执行
2. **纵深防御**：多层安全检查，单层失败不导致完全暴露
3. **默认安全**：DM 默认配对模式、Gateway HTTP 默认拒绝高危工具
4. **可审计性**：所有安全决策可通过 `openclaw doctor` 审计
5. **延迟加载**：重型安全检查通过 `*.runtime.ts` 动态导入，不影响启动性能
6. **缓存友好**：Skill 扫描、正则编译、Secret 解析均有缓存层
7. **平台适配**：Windows ACL / Unix chmod 双路径支持
