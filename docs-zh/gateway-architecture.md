---
title: Gateway 模块架构
summary: OpenClaw Gateway 模块的内部架构文档，面向维护者，涵盖启动流程、HTTP/WS 服务、认证体系、会话管理、配置热重载和协议定义。
---

# Gateway 模块架构

## 代码地图

```
src/gateway/
├── server.ts                    # 公共入口，懒加载 server.impl.ts
├── server.impl.ts               # 主服务器实现（~58KB），startGatewayServer()
├── server-http.ts               # HTTP/HTTPS 服务器创建与请求分发
├── server-methods.ts            # RPC 方法注册与分发（handleGatewayRequest）
├── auth.ts                      # 认证核心逻辑（token/password/tailscale/device-token）
├── auth-resolve.ts              # 认证配置解析（resolveGatewayAuth）
├── auth-rate-limit.ts           # 认证暴力破解防护
├── boot.ts                      # BOOT.md 启动脚本执行
├── session-utils.ts             # 会话列表/查询/元数据工具（~72KB）
├── session-utils.fs.ts          # 会话 transcript 文件读写
├── config-reload.ts             # 配置热重载（chokidar 文件监听）
├── config-reload-plan.ts        # 热重载计划生成
├── server-reload-handlers.ts    # 热重载执行器
├── server-startup-config.ts     # 启动配置加载
├── server-startup-plugins.ts    # 启动插件引导
├── server-startup-post-attach.ts # 启动后附加（channels/cron/boot）
├── server-runtime-state.ts      # 运行时状态容器
├── server-channels.ts           # Channel 管理器
├── server-chat.ts               # Chat 流处理
├── server-cron.ts               # Cron 调度
├── client.ts                    # Gateway WS 客户端 SDK
├── protocol/
│   ├── index.ts                 # 协议类型导出 + AJV 验证器编译
│   ├── schema.ts                # 协议 schema 聚合
│   ├── schema/                  # 按领域拆分的 JSON Schema 定义
│   ├── version.ts               # PROTOCOL_VERSION 常量
│   └── connect-error-details.ts # 连接错误详情
├── server-methods/              # RPC handler 按领域拆分
│   ├── chat.ts                  # chat.send / chat.abort / chat.history
│   ├── sessions.ts              # sessions.list / sessions.create / ...
│   ├── agent.ts                 # agent.run / agent.wait
│   ├── config.ts                # config.get / config.patch / config.apply
│   ├── nodes.ts                 # node.invoke / node.pair / ...
│   ├── channels.ts              # channels.start / channels.stop / channels.status
│   ├── talk.ts                  # talk mode (voice)
│   ├── cron.ts                  # cron.add / cron.remove / cron.run
│   └── ...                      # 其余 40+ handler 模块
└── server/                      # 服务器子系统
    ├── ws-connection.ts         # WebSocket 连接生命周期
    ├── readiness.ts             # 就绪检查器
    ├── health-state.ts          # 健康状态快照
    ├── hooks-request-handler.ts # Webhook 请求处理
    ├── plugins-http.ts          # 插件 HTTP 路由分发
    └── preauth-connection-budget.ts # 预认证连接预算
```

## 总体分层

```text
┌─────────────────────────────────────────────────────────────┐
│                      CLI / Companion Apps                     │
│              (openclaw gateway, macOS app, iOS/Android)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ WebSocket / HTTP
┌──────────────────────────────▼──────────────────────────────┐
│                     server-http.ts                            │
│  HTTP/HTTPS 服务器 + WS Upgrade + 路由分发                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Probes   │ │ControlUI │ │ OpenAI   │ │ Plugin Routes │  │
│  │/health   │ │ SPA      │ │ compat   │ │ (channels)    │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                   server-methods.ts                           │
│  RPC 分发层：角色鉴权 → 方法路由 → handler 调用               │
│  coreGatewayHandlers = { ...chatHandlers, ...sessionsHandlers, ... }
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                   server.impl.ts                             │
│  核心编排：启动流程 / 运行时状态 / 配置热重载 / 关闭           │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐              │
│  │ Auth       │ │ Sessions   │ │ Channels   │              │
│  │ subsystem  │ │ subsystem  │ │ manager    │              │
│  └────────────┘ └────────────┘ └────────────┘              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐              │
│  │ Cron       │ │ Nodes      │ │ Plugins    │              │
│  │ scheduler  │ │ registry   │ │ runtime    │              │
│  └────────────┘ └────────────┘ └────────────┘              │
└─────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                     protocol/                                 │
│  JSON Schema 定义 + AJV 编译验证器 + 版本协商                 │
└─────────────────────────────────────────────────────────────┘
```

## 启动流程

`startGatewayServer(port, opts)` 是 Gateway 的主入口，定义在 `server.impl.ts`。启动过程通过 `startupTrace` 进行性能追踪：

1. **网络运行时引导** — `bootstrapGatewayNetworkRuntime()` 设置全局 fetch/DNS 策略。
2. **配置快照加载** (`config.snapshot`) — 读取 `~/.openclaw/openclaw.json`，合并插件元数据。
3. **Secrets 激活** — `createRuntimeSecretsActivator` 加载凭证文件到运行时。
4. **认证配置准备** (`config.auth`) — `prepareGatewayStartupConfig` 解析 auth mode，必要时生成运行时 token。
5. **诊断/重启策略** — 设置 SIGUSR1 重启策略、事件循环健康监控。
6. **Control UI Origins 种子** — 为非 loopback 绑定补充 CORS 允许源。
7. **插件引导** (`plugins.bootstrap`) — `prepareGatewayPluginBootstrap` 构建插件查找表、注册 channel 插件、确定基础 RPC 方法列表。
8. **运行时配置解析** (`runtime.config`) — 确定 bindHost、端口、TLS、Control UI 开关等。
9. **运行时状态创建** (`runtime.state`) — `createGatewayRuntimeState` 创建 HTTP 服务器、WSS、客户端集合、chat 运行状态等。
10. **Node 会话运行时** — 创建 node 注册表、presence 定时器、会话事件订阅。
11. **HTTP 监听** — `startListening()` 绑定端口。
12. **Post-attach** (`runtime.post-attach`) — 启动 channels、cron、boot 脚本、维护任务。
13. **就绪标记** — `startupSidecarsReady = true`，`/ready` 探针返回 200。

## HTTP/WS 服务

### HTTP 服务器 (`server-http.ts`)

`createGatewayHttpServer(opts)` 创建 `node:http` 或 `node:https` 服务器。请求处理采用 **阶段管道** (`GatewayHttpRequestStage[]`)：

1. **Plugin Auth** — 对受保护的插件路由执行 Gateway 认证。
2. **Plugin HTTP** — 将请求分发给插件注册的 HTTP handler（如 channel webhook）。
3. **Hooks** — `/hooks/*` 路径交给 `HooksRequestHandler`。
4. **Control UI** — SPA 静态文件服务（带 CSP 头）。
5. **Health Probes** — `/health`, `/healthz`, `/ready`, `/readyz`。
6. **OpenAI 兼容端点** — `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses`。
7. **工具调用** — `/tools/invoke`。
8. **会话 HTTP** — `/sessions/:id/history`, `/sessions/:id/kill`。

路由使用路径前缀匹配 + 正则，非 SPA 路由返回 404。

### WebSocket 服务

WS 升级在 HTTP 服务器的 `upgrade` 事件中处理：

- 认证后创建 `GatewayWsClient`，进入 `server/ws-connection.ts` 管理。
- 客户端发送 `connect` 方法完成握手，获得 `HelloOk` 响应（含 `PROTOCOL_VERSION`）。
- 后续通信为 JSON-RPC 风格的 `RequestFrame` / `ResponseFrame` / `EventFrame`。
- 支持 `role` 区分（operator / node / webchat）和 `scopes` 细粒度权限。

### 懒加载模式

HTTP handler 中大量使用模块级 Promise 缓存实现懒加载：

```typescript
let controlUiModulePromise: Promise<typeof import("./control-ui.js")> | undefined;
function getControlUiModule() {
  controlUiModulePromise ??= import("./control-ui.js");
  return controlUiModulePromise;
}
```

这减少了启动时的模块加载开销，仅在首次请求时加载对应子系统。

## 认证体系

### 认证模式 (`auth.ts` + `auth-resolve.ts`)

`resolveGatewayAuth()` 从配置和环境变量解析出 `ResolvedGatewayAuth`，支持以下模式：

| 模式 | 来源 | 说明 |
|------|------|------|
| `none` | 配置 | 无认证（仅限 loopback） |
| `token` | 配置/环境变量 | Bearer token 认证 |
| `password` | 配置 | 密码认证 |
| `tailscale` | Tailscale 代理头 | Tailscale Whois 验证 |
| `device-token` | 设备配对 | 已配对设备的持久 token |
| `bootstrap-token` | 启动时生成 | 临时 token（重启失效） |
| `trusted-proxy` | 反向代理 | 信任代理转发的身份 |

### 认证流程

`authorizeHttpGatewayConnect()` / `authorizeGatewayConnect()` 执行认证：

1. 检查是否为本地直连（loopback + 无转发头）→ 直接通过。
2. 检查 Tailscale 代理请求 → Whois 验证用户身份。
3. 检查 token/password → `safeEqualSecret` 时间安全比较。
4. 检查 device-token → 查询已配对设备列表。
5. 失败时触发 `AuthRateLimiter` 计数。

### 速率限制 (`auth-rate-limit.ts`)

- 按 IP 追踪失败次数，超限后返回 429 + `Retry-After`。
- loopback 地址可配置豁免（`exemptLoopback`）。
- 浏览器 WS 认证使用独立的 `browserRateLimiter`（不豁免 loopback）。

### 角色与作用域 (`role-policy.ts` + `method-scopes.ts`)

- 角色：`operator`（完全权限）、`node`（设备节点）、`webchat`（Web 聊天）。
- 作用域：`admin`（全部方法）或细粒度 scope 列表。
- `authorizeGatewayMethod()` 在每次 RPC 调用前检查角色 + scope。

## 会话管理

### 会话存储

- 会话映射存储在 `~/.openclaw/state/<agentId>/sessions.json`。
- 每个会话条目 (`SessionEntry`) 包含：sessionId、model、title、updatedAt、tokens 等。
- Transcript 以 JSONL 文件存储在 `~/.openclaw/state/<agentId>/sessions/<sessionId>/`。

### 会话工具 (`session-utils.ts`)

提供面向 Gateway RPC 的会话查询能力：

- `listSessions()` — 列出 agent 下所有会话，含 subagent 运行状态。
- `resolveSessionRow()` — 解析单个会话的完整元数据。
- `resolveIdentityAvatarUrl()` — 解析 agent 头像（支持 data URL / HTTP URL / workspace 相对路径）。
- 模型选择：`resolveDefaultModelForAgent()` + fallback 链。

### 会话生命周期

- **创建**：`sessions.create` RPC → 生成 sessionId → 写入 store。
- **Chat**：`chat.send` → agent 运行 → 流式事件广播 → transcript 持久化。
- **Compact**：`sessions.compact` → 压缩历史消息。
- **Reset**：`sessions.reset` → 清空 transcript，保留 store 条目。
- **Delete**：`sessions.delete` → 归档 transcript → 移除 store 条目。

### Boot 机制 (`boot.ts`)

Gateway 启动后执行 `BOOT.md`：

1. 读取 `~/.openclaw/workspace/BOOT.md`。
2. 构建 boot prompt，在临时 session 中运行 agent。
3. 运行完毕后恢复 main session 映射（不污染用户会话）。

## 配置热重载

### 文件监听 (`config-reload.ts`)

使用 `chokidar` 监听 `~/.openclaw/openclaw.json` 和插件安装索引：

1. 文件变更 → 读取新快照 → `diffConfigPaths()` 计算变更路径。
2. `buildGatewayReloadPlan()` 生成重载计划 (`GatewayReloadPlan`)。

### 重载计划

```typescript
type GatewayReloadPlan = {
  restartGateway: boolean;        // 需要完全重启
  hotReasons: string[];           // 热重载原因
  reloadHooks: boolean;           // 重载 webhook 配置
  restartCron: boolean;           // 重启 cron 调度
  restartChannels: Set<string>;   // 需重启的 channel
  reloadPlugins: boolean;         // 重载插件
  disposeMcpRuntimes: boolean;    // 释放 MCP 运行时
  restartGmailWatcher: boolean;   // 重启 Gmail 监听
  restartHeartbeat: boolean;      // 重启心跳
  restartHealthMonitor: boolean;  // 重启健康监控
};
```

### 执行 (`server-reload-handlers.ts`)

- 热重载：更新运行时配置快照 → 通知各子系统 → 广播 `config.changed` 事件。
- 冷重启：触发 SIGUSR1 或 `gateway.restart.request` RPC。
- Skills 变更：`bumpSkillsSnapshotVersion()` 使会话缓存失效。

### 配置写入监听

`registerConfigWriteListener()` 捕获来自 RPC（如 `config.patch`）的配置写入，与文件监听协同避免重复重载。使用 `startupInternalWriteHash` 区分启动写入和外部变更。

## 协议定义

### 版本 (`protocol/version.ts`)

```typescript
export const PROTOCOL_VERSION = <number>;
export const MIN_CLIENT_PROTOCOL_VERSION = <number>;
export const MIN_PROBE_PROTOCOL_VERSION = <number>;
```

客户端连接时在 `connect` 方法中声明协议版本，服务端检查兼容性。

### 帧格式

```typescript
// 请求帧
type RequestFrame = { id: string; method: string; params?: unknown };

// 响应帧
type ResponseFrame = { id: string; result?: unknown; error?: ErrorShape };

// 事件帧（服务端推送）
type EventFrame = { event: string; data?: unknown };
```

### Schema 验证

`protocol/index.ts` 使用 AJV 编译所有协议 schema 为验证函数：

```typescript
const ajv = new Ajv({ allErrors: true, strict: false });
export const validateConnectParams = ajv.compile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame = ajv.compile<RequestFrame>(RequestFrameSchema);
// ... 100+ 验证器
```

Schema 定义按领域拆分在 `protocol/schema/` 目录下。

### 错误码 (`ErrorCodes`)

```typescript
const ErrorCodes = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAVAILABLE: -32000,
  // ...
};
```

### 事件类型 (`GATEWAY_EVENTS`)

服务端推送事件包括：`chat.delta`、`chat.end`、`agent.event`、`talk.event`、`tick`、`shutdown`、`config.changed`、`presence` 等。

## RPC 方法注册 (`server-methods.ts`)

### 方法聚合

`coreGatewayHandlers` 将所有领域 handler 合并为一个扁平 map：

```typescript
export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,    // connect
  ...chatHandlers,       // chat.send, chat.abort, chat.history, chat.inject
  ...sessionsHandlers,   // sessions.list, sessions.create, sessions.delete, ...
  ...agentHandlers,      // agent.run, agent.wait
  ...configHandlers,     // config.get, config.patch, config.apply, config.set
  ...cronHandlers,       // cron.add, cron.remove, cron.run, cron.list
  ...nodeHandlers,       // node.invoke, node.pair.*, node.list
  ...channelsHandlers,   // channels.start, channels.stop, channels.status
  ...skillsHandlers,     // skills.install, skills.search, skills.status
  // ... 50+ handler 组
};
```

### 请求处理流程

`handleGatewayRequest()` 执行：

1. **角色鉴权** — `authorizeGatewayMethod(method, client, params)`。
2. **启动不可用检查** — 启动期间部分方法返回 `UNAVAILABLE` + `retryAfterMs`。
3. **控制面写入限流** — `config.apply` 等写方法限制 3 次/60s。
4. **Handler 查找** — 优先 `extraHandlers`（插件注册），回退 `coreGatewayHandlers`。
5. **插件运行时作用域** — `withPluginRuntimeGatewayRequestScope()` 包裹执行。

### 插件扩展

Channel 插件可通过 manifest 声明 `gatewayMethods`，在启动时注入到活跃方法列表。插件 handler 通过 `extraHandlers` 参数传入。
