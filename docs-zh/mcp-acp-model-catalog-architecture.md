# MCP、ACP 与模型目录架构

> 模块路径：`src/mcp/`、`src/acp/`、`src/model-catalog/`、`src/gateway/protocol/`

## 概述

OpenClaw 作为多协议 AI 网关系统，其架构围绕 **Gateway（网关）** 核心构建，通过统一的 WebSocket 协议连接各种客户端和协议桥接器。本架构涵盖四个关键模块：**MCP（模型上下文协议）桥接**、**ACP（Agent通信协议）桥接**、**模型目录系统** 和 **网关协议层**，共同构成 OpenClaw 的协议栈和模型管理基础设施。

---

## 1. MCP（模型上下文协议）模块 (`src/mcp/`)

### 职责

桥接外部 MCP 客户端（如 Claude Code、Codex）与 OpenClaw Gateway，提供基于会话的工具访问和事件通知。

### 核心组件

#### `OpenClawChannelBridge` (`channel-bridge.ts`)

**功能**：维护与 Gateway 的 WebSocket 连接，管理内存事件队列，处理 Claude 通道通知。

**关键特性**：

- 支持 `events_poll` 和 `events_wait` 长轮询
- 可选的 Claude 通道模式（`off`/`on`/`auto`）
- 会话路由基于 Gateway 现有路由元数据

#### MCP 服务器 (`channel-server.ts`)

**功能**：使用 `@modelcontextprotocol/sdk` 创建标准 MCP 服务器。

**配置选项**：

```typescript
type OpenClawChannelServerOptions = {
  gatewayUrl: string;
  gatewayPassword?: string;
  claudeChannelMode?: "off" | "on" | "auto";
  verbose?: boolean;
};
```

### 关键类型

#### 会话描述符

```typescript
type ConversationDescriptor = {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};
```

#### 队列事件

```typescript
type QueueEvent =
  | { type: "message"; sessionKey: string; conversation?: ConversationDescriptor; ... }
  | { type: "claude_permission_request"; requestId: string; toolName: string; ... }
  | { type: "exec_approval_requested" | "exec_approval_resolved"; raw: Record<string, unknown> }
  | { type: "plugin_approval_requested" | "plugin_approval_resolved"; raw: Record<string, unknown> };
```

#### 审批类型

```typescript
type ApprovalKind = "exec" | "plugin";
type ApprovalDecision = "allow-once" | "allow-always" | "deny";
```

### MCP 工具注册

#### 会话工具 (`channel-tools.ts`)

| 工具名称             | 功能         | 权限                     |
| -------------------- | ------------ | ------------------------ |
| `conversations_list` | 列出可用会话 | 无                       |
| `conversations_read` | 读取会话详情 | 无                       |
| `messages_read`      | 读取会话消息 | 无                       |
| `messages_send`      | 发送消息     | 需要 `send_message` 权限 |

#### 工具服务 (`openclaw-tools-serve.ts`)

- 提供 `conversations` 工具集
- 权限检查：`send_message` 权限验证
- 会话路由：基于现有 Gateway 会话

### 设计原则

1. **基于会话的路由**：MCP 工具暴露基于 Gateway 会话路由的对话，不创建新路由
2. **事件队列模式**：内存中的实时事件队列，支持游标分页和长轮询
3. **协议桥接**：将 Gateway 会话状态映射为 MCP 工具和通知
4. **客户端适配**：支持通用 MCP 客户端和 Claude Code 特定通知

---

## 2. ACP（Agent通信协议）模块 (`src/acp/`)

### 职责

桥接外部 ACP 客户端（如 IDE、编辑器）与 OpenClaw Gateway，提供 stdio 协议到 WebSocket 协议的转换。

### 核心组件

#### `AcpGatewayAgent` (`translator.ts`, 68,741 行)

**功能**：核心转换器，实现 ACP 协议与 Gateway 协议的双向转换。

**关键特性**：

- 会话映射：ACP `sessionId` ↔ Gateway `sessionKey`
- 事件记录：支持 `loadSession` 的历史回放
- 审批中继：将 Gateway 执行审批转发给 ACP 客户端
- 工具流式传输：部分支持工具调用更新

#### ACP 服务器 (`server.ts`)

**功能**：通过 stdio 与 IDE 客户端通信，通过 WebSocket 连接 Gateway。

**配置选项**：

```typescript
type AcpServerOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  defaultSessionLabel?: string;
  requireExistingSession?: boolean;
  resetSession?: boolean;
  prefixCwd?: boolean;
  provenanceMode?: AcpProvenanceMode;
  sessionCreateRateLimit?: { maxRequests?: number; windowMs?: number };
  verbose?: boolean;
};
```

### 关键类型

#### ACP 会话

```typescript
type AcpSession = {
  sessionId: SessionId;
  sessionKey: string; // 映射到 Gateway sessionKey
  ledgerSessionId?: string; // 事件记录器会话ID
  cwd: string; // 工作目录
  createdAt: number;
  lastTouchedAt: number;
  abortController: AbortController | null;
  activeRunId: string | null;
};
```

#### ACP 运行时接口

```typescript
interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: { handle?: AcpRuntimeHandle }): Promise<AcpRuntimeCapabilities>;
  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void>;
}
```

### 事件记录器 (`event-ledger.ts`)

**功能**：记录会话事件，支持历史回放。

**关键特性**：

- 持久化存储：事件写入磁盘
- 会话回放：`loadSession` 时重新播放事件
- 增量记录：仅记录新事件，避免重复

### 设计原则

1. **协议转换桥接**：将 ACP JSON-RPC over stdio 转换为 Gateway WebSocket 协议
2. **会话持久化**：通过事件记录器支持会话状态恢复
3. **安全沙箱**：自动批准限于当前工作目录的读取操作
4. **增量兼容**：逐步实现 ACP 协议特性，明确标注支持状态

---

## 3. 模型目录模块 (`src/model-catalog/`)

### 职责

统一模型发现、配置管理和版本控制，为 OpenClaw 提供标准化的模型访问接口。

### 核心组件

#### 模型目录结构

```typescript
type ModelCatalog = {
  providers?: Record<string, ModelCatalogProvider>;
  aliases?: Record<string, ModelCatalogAlias>;
  suppressions?: ModelCatalogSuppression[];
  discovery?: Record<string, ModelCatalogDiscovery>;
};
```

#### 模型定义

```typescript
type ModelCatalogModel = {
  id: string;
  name?: string;
  api?: ModelApi; // "openai", "anthropic", "google", "azure", "cohere" 等
  baseUrl?: string;
  headers?: Record<string, string>;
  input?: ModelCatalogInput[]; // "text", "image", "document"
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  cost?: ModelCatalogCost;
  compat?: ModelCompatConfig;
  status?: ModelCatalogStatus; // "available", "preview", "deprecated", "disabled"
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
};
```

### 统一模型目录条目

```typescript
type UnifiedModelCatalogEntry<TCapabilities = unknown> = {
  kind: UnifiedModelCatalogKind; // "text", "image_generation", "video_generation", "music_generation"
  provider: string;
  model: string;
  label?: string;
  source: UnifiedModelCatalogSource; // "manifest", "provider-index", "static", "live", "cache", "configured", "runtime-refresh"
  default?: boolean;
  configured?: boolean;
  capabilities?: TCapabilities;
  modes?: readonly string[];
  authEnvVars?: readonly string[];
  docsPath?: string;
  fetchedAt?: number;
  expiresAt?: number;
  warnings?: readonly string[];
};
```

### 多源发现机制

| 源类型            | 描述          | 更新频率   |
| ----------------- | ------------- | ---------- |
| `manifest`        | 静态清单文件  | 发布时     |
| `provider-index`  | 提供者索引    | 定期刷新   |
| `static`          | 静态配置      | 启动时     |
| `live`            | 实时 API 查询 | 按需       |
| `cache`           | 缓存结果      | 缓存过期时 |
| `configured`      | 用户配置      | 配置变更时 |
| `runtime-refresh` | 运行时刷新    | 会话启动时 |

### 规范化处理 (`normalize.ts`)

**功能**：验证和标准化不同来源的模型数据。

**处理流程**：

1. **验证**：检查必需字段和格式
2. **合并**：合并提供者级和模型级配置
3. **抑制**：应用抑制规则（隐藏不支持的模型）
4. **标准化**：生成统一引用标识

### 成本建模

```typescript
type ModelCatalogCost = {
  input?: number; // 每百万输入 token 价格
  output?: number; // 每百万输出 token 价格
  image?: number; // 每张图像价格
  video?: number; // 每秒视频价格
  audio?: number; // 每分钟音频价格
  currency?: string; // 货币代码，默认 "USD"
  tiered?: ModelCatalogCostTier[]; // 分层定价
};
```

### 设计原则

1. **多源发现**：支持静态清单、提供者索引、缓存、配置和运行时刷新
2. **规范化处理**：统一不同来源的模型数据格式
3. **成本建模**：支持分层定价和详细成本结构
4. **状态管理**：明确的模型状态（可用、预览、弃用、禁用）和替换链
5. **能力描述**：通过 `capabilities` 字段扩展模型特定功能

---

## 4. 网关协议层 (`src/gateway/protocol/`)

### 职责

定义 OpenClaw Gateway 的核心通信协议，提供强类型的 WebSocket API。

### 协议架构

#### 传输层

- **协议**：WebSocket，文本帧
- **格式**：JSON 负载
- **编码**：UTF-8

#### 帧类型

| 帧类型 | 结构                                                  | 方向          |
| ------ | ----------------------------------------------------- | ------------- | ------------- |
| 请求帧 | `{type:"req", id, method, params}`                    | 客户端→服务器 |
| 响应帧 | `{type:"res", id, ok, payload                         | error}`       | 服务器→客户端 |
| 事件帧 | `{type:"event", event, payload, seq?, stateVersion?}` | 服务器→客户端 |

#### 连接生命周期

1. **连接**：客户端发送 `connect` 请求
2. **握手**：服务器返回 `hello-ok` 响应
3. **通信**：后续请求-响应和服务器推送事件
4. **断开**：WebSocket 关闭或显式 `disconnect`

### 模式定义系统

#### TypeBox 模式 (`schema/` 目录)

| 模式文件              | 覆盖领域       |
| --------------------- | -------------- |
| `agent.ts`            | 智能体相关操作 |
| `channels.ts`         | 通道管理       |
| `sessions.ts`         | 会话管理       |
| `cron.ts`             | 定时任务       |
| `exec-approvals.ts`   | 执行审批       |
| `plugin-approvals.ts` | 插件审批       |
| `frames.ts`           | 基础帧结构     |
| `protocol-schemas.ts` | 协议模式注册表 |

#### 模式定义示例

```typescript
// 请求帧模式
export const RequestFrameSchema = Type.Object({
  type: Type.Literal("req"),
  id: Type.String({ minLength: 1 }),
  method: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  idempotencyKey: Type.Optional(Type.String()),
});

// 响应帧模式
export const ResponseFrameSchema = Type.Object({
  type: Type.Literal("res"),
  id: Type.String({ minLength: 1 }),
  ok: Type.Boolean(),
  payload: Type.Optional(Type.Unknown()),
  error: Type.Optional(
    Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(Type.Unknown()),
    }),
  ),
});
```

### 客户端能力协商

#### 客户端信息 (`client-info.ts`)

```typescript
type ClientInfo = {
  name: string; // 客户端名称
  mode: ClientMode; // "control-plane" | "node" | "plugin" | "acp" | "mcp"
  capabilities: string[]; // 能力列表
  version?: string; // 客户端版本
  userAgent?: string; // 用户代理字符串
};
```

#### 能力列表

| 能力               | 描述         |
| ------------------ | ------------ |
| `sessions`         | 会话管理能力 |
| `channels`         | 通道管理能力 |
| `cron`             | 定时任务能力 |
| `exec-approvals`   | 执行审批能力 |
| `plugin-approvals` | 插件审批能力 |
| `events`           | 事件订阅能力 |

### 错误处理

#### 错误代码

| 错误代码              | 描述           | HTTP 等效 |
| --------------------- | -------------- | --------- |
| `invalid_request`     | 请求格式错误   | 400       |
| `unauthorized`        | 认证失败       | 401       |
| `forbidden`           | 权限不足       | 403       |
| `not_found`           | 资源不存在     | 404       |
| `method_not_allowed`  | 方法不允许     | 405       |
| `conflict`            | 资源冲突       | 409       |
| `too_many_requests`   | 请求过多       | 429       |
| `internal_error`      | 服务器内部错误 | 500       |
| `service_unavailable` | 服务不可用     | 503       |

#### 错误详情 (`connect-error-details.ts`)

```typescript
type ConnectErrorDetails = {
  reason: string; // 错误原因
  retryAfter?: number; // 重试等待时间（秒）
  helpUrl?: string; // 帮助文档 URL
  debugInfo?: Record<string, unknown>; // 调试信息
};
```

### 设计原则

1. **强类型协议**：使用 TypeBox 定义 JSON Schema，生成 TypeScript 类型
2. **模块化模式**：每个领域有独立模式文件，便于维护
3. **向后兼容**：协议版本管理，新增字段可选
4. **统一错误处理**：标准化的错误代码和详情格式
5. **能力协商**：客户端声明能力和角色（控制平面、节点等）

---

## 5. 模块间依赖关系

### 协议桥接矩阵

| 协议方向      | 桥接机制                                    | 状态     | 特性支持                             |
| ------------- | ------------------------------------------- | -------- | ------------------------------------ |
| ACP → Gateway | `AcpGatewayAgent` (translator.ts)           | 生产就绪 | 核心流程、会话列表、部分工具流式传输 |
| Gateway → ACP | 同上                                        | 生产就绪 | 会话信息更新、使用量更新、审批中继   |
| MCP → Gateway | `OpenClawChannelBridge` (channel-bridge.ts) | 生产就绪 | 会话工具、事件队列、审批管理         |
| Gateway → MCP | 同上                                        | 生产就绪 | 实时消息、Claude 通道通知            |

### 会话映射策略

#### ACP 会话映射

- **映射规则**：`acp:<uuid>` 或指定的 `sessionKey`
- **持久化**：支持 `loadSession` 历史回放
- **工作目录**：每个 ACP 会话关联特定工作目录

#### MCP 会话映射

- **映射规则**：基于现有 Gateway 会话路由元数据
- **持久化**：无持久化会话状态
- **工具访问**：通过 Gateway 会话路由访问工具

#### 跨协议会话隔离

- **事件路由**：不同协议客户端访问相同 `sessionKey` 时，事件路由为尽力而为
- **状态同步**：会话状态通过 Gateway 统一管理
- **权限隔离**：各协议客户端独立权限检查

### 依赖路径

```
外部客户端
    ├── IDE/编辑器 (stdio) ──▶ ACP 模块 ──▶ Gateway 客户端 ──┐
    └── MCP 客户端 (stdio) ──▶ MCP 模块 ──▶ Gateway 客户端 ──┘
                                                                │
                                                                ▼
                                                          Gateway (网关)
                                                                │
                                                                ├──▶ 通道插件 (Telegram, WhatsApp, Discord...)
                                                                ├──▶ 智能体运行时
                                                                └──▶ Model Catalog ──▶ 模型提供者 API
```

**关键依赖**：

1. **ACP/MCP → Gateway 客户端**：两个桥接模块都依赖 `src/gateway/client.js` 建立 WebSocket 连接
2. **Gateway → Model Catalog**：网关通过模型目录解析模型配置和发现可用模型
3. **外部协议 SDK**：
   - ACP：`@agentclientprotocol/sdk`
   - MCP：`@modelcontextprotocol/sdk/server`

---

## 6. 协议互操作性与兼容性

### 兼容性保障机制

#### 协议版本管理

- **Gateway 协议**：版本号在连接握手时协商
- **ACP 协议**：客户端声明支持的协议版本
- **MCP 协议**：遵循 MCP 规范版本

#### 增量特性支持

| 特性类别 | 支持策略   | 回退机制                   |
| -------- | ---------- | -------------------------- |
| 必需特性 | 完全实现   | 无，必需特性失败则连接失败 |
| 可选特性 | 部分实现   | 降级到基本功能             |
| 实验特性 | 有条件实现 | 配置开关控制               |

#### 错误处理兼容性

- **未知方法**：返回清晰错误而非静默忽略
- **参数验证**：严格验证参数，提供详细错误信息
- **向后兼容**：旧版本客户端可连接新版本服务器（有限功能）

### 配置兼容性

#### 遗留配置修复

- **工具**：`openclaw doctor --fix`
- **范围**：修复遗留的配置格式和路径
- **策略**：自动迁移到新格式，保留备份

#### 配置继承

1. **全局默认值**：系统默认配置
2. **用户配置**：`~/.openclaw/config.json`
3. **项目配置**：项目目录中的 `.openclaw.json`
4. **会话配置**：运行时参数（最高优先级）

### 安全边界与权限

#### 协议桥接安全

- **认证传递**：ACP/MCP 客户端认证传递到 Gateway
- **权限隔离**：各协议客户端独立权限检查
- **审计日志**：所有协议操作记录审计日志

#### 沙箱策略

| 协议 | 沙箱级别 | 自动批准范围           |
| ---- | -------- | ---------------------- |
| ACP  | 工作目录 | 当前工作目录的读取操作 |
| MCP  | 会话范围 | 基于会话权限的工具访问 |
| 原生 | 系统级   | 配置决定的权限级别     |

---

## 7. 性能优化策略

### 连接管理

#### 连接池

- **Gateway 连接**：ACP/MCP 模块复用 Gateway 连接
- **心跳机制**：定期发送 ping/pong 保持连接
- **自动重连**：连接断开时自动重连（指数退避）

#### 会话缓存

- **内存缓存**：活跃会话缓存到内存
- **LRU 策略**：最近最少使用会话淘汰
- **预热机制**：高频会话预加载

### 事件处理

#### 事件队列优化

- **内存队列**：MCP 事件队列使用内存存储
- **游标分页**：支持游标分页，避免全量传输
- **长轮询**：`events_wait` 支持长轮询减少轮询次数

#### 事件过滤

- **客户端过滤**：客户端声明感兴趣的事件类型
- **服务器过滤**：服务器端按需发送事件
- **批量发送**：相似事件批量发送减少网络开销

### 模型目录性能

#### 缓存策略

| 缓存级别 | 存储位置 | 失效策略                |
| -------- | -------- | ----------------------- |
| 内存缓存 | 进程内存 | 配置变更时失效          |
| 磁盘缓存 | 临时目录 | TTL 控制（默认 1 小时） |
| 网络缓存 | CDN/代理 | 提供者索引更新时失效    |

#### 懒加载

- **提供者懒加载**：提供者类在首次使用时动态导入
- **配置懒解析**：配置解析延迟到实际需要时
- **模型懒发现**：模型列表按需查询

---

## 8. 监控与调试

### 指标收集

#### 连接指标

| 指标名称               | 类型   | 说明             |
| ---------------------- | ------ | ---------------- |
| `protocol_connections` | 计数器 | 各协议连接数     |
| `connection_duration`  | 直方图 | 连接持续时间分布 |
| `reconnect_count`      | 计数器 | 重连次数         |

#### 性能指标

| 指标名称                       | 类型   | 说明               |
| ------------------------------ | ------ | ------------------ |
| `request_latency`              | 直方图 | 请求处理延迟       |
| `event_queue_size`             | 量表   | 事件队列大小       |
| `model_catalog_cache_hit_rate` | 百分比 | 模型目录缓存命中率 |

### 日志系统

#### 结构化日志

```typescript
type ProtocolLog = {
  timestamp: string;
  protocol: "acp" | "mcp" | "gateway";
  sessionId: string;
  operation: string;
  duration: number;
  success: boolean;
  error?: string;
  clientInfo?: ClientInfo;
};
```

#### 日志级别

| 级别  | 记录内容             | 使用场景 |
| ----- | -------------------- | -------- |
| ERROR | 错误详情、堆栈跟踪   | 问题诊断 |
| WARN  | 降级决策、性能警告   | 运维监控 |
| INFO  | 连接建立、关键操作   | 日常监控 |
| DEBUG | 详细协议帧、内部状态 | 开发调试 |

### 追踪系统

#### 分布式追踪

- **请求级追踪**：从协议入口到 Gateway 的完整处理链路
- **跨协议追踪**：ACP → Gateway → MCP 的跨协议调用链
- **异步任务追踪**：并发事件的执行关系

#### 追踪标识

- `traceId`：全局唯一请求标识
- `spanId`：单个协议操作标识
- `parentSpanId`：父操作标识（构建调用树）
- `protocol`：协议类型标签（acp/mcp/gateway）

---

## 9. 故障处理与恢复

### 故障检测

#### 连接故障

- **心跳超时**：定期 ping/pong 检测连接存活
- **协议错误**：无效帧格式或违反协议
- **资源耗尽**：内存、文件描述符等资源限制

#### 服务故障

- **Gateway 不可用**：Gateway 服务停止响应
- **模型服务不可用**：模型 API 服务故障
- **配置错误**：无效配置导致服务异常

### 恢复策略

#### 自动恢复

- **连接重试**：指数退避重连策略
- **会话恢复**：通过事件记录器恢复会话状态
- **配置回滚**：检测到配置错误时回滚到上次有效配置

#### 手动恢复

- **诊断工具**：`openclaw doctor` 诊断和修复问题
- **配置修复**：手动修复错误配置
- **服务重启**：重启故障服务组件

### 降级策略

#### 功能降级

| 故障类型     | 降级策略           | 用户体验影响     |
| ------------ | ------------------ | ---------------- |
| 模型服务故障 | 切换到备用模型     | 响应质量可能下降 |
| Gateway 故障 | ACP/MCP 直接降级   | 部分功能不可用   |
| 网络故障     | 离线模式（如支持） | 仅本地功能可用   |

#### 协议降级

- **ACP 降级**：无法连接 Gateway 时，降级到本地执行
- **MCP 降级**：Claude 通道不可用时，降级到标准 MCP 工具
- **功能开关**：通过配置开关禁用故障功能

---

## 10. 架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        外部客户端生态系统                               │
├─────────────────┬─────────────────┬─────────────────┬─────────────────┤
│   IDE/编辑器    │  MCP 客户端     │    CLI 工具     │    Web UI       │
│   (Zed, Cursor) │ (Codex, Claude) │                 │                 │
└────────┬────────┴────────┬────────┴────────┬────────┴────────┬────────┘
         │ (stdio)         │ (stdio)         │ (WebSocket)     │ (HTTP/WS)
         ▼                 ▼                 ▼                 ▼
┌────────┴─────────────────┴─────────────────┴─────────────────┴────────┐
│                    OpenClaw 协议桥接层                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────────┐   │
│  │   ACP模块   │  │   MCP模块   │  │     原生 Gateway 客户端      │   │
│  │  (translator)│  │ (channel-   │  │    (CLI, Web, 节点)         │   │
│  │             │  │   bridge)   │  │                              │   │
│  └──────┬──────┘  └──────┬──────┘  └──────────────┬───────────────┘   │
│         │                │                        │                   │
│         └────────────────┴────────────────────────┘                   │
│                                │ (WebSocket)                          │
└────────────────────────────────┼──────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Gateway (网关核心)                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  会话管理   │  │  通道路由   │  │  审批引擎   │  │  事件总线   │   │
│  │ (sessions)  │  │ (channels)  │  │ (approvals) │  │  (events)   │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │
│         │                │                 │                │          │
└─────────┼────────────────┼─────────────────┼────────────────┼──────────┘
          │                │                 │                │
          ▼                ▼                 ▼                ▼
┌─────────────┐  ┌─────────────────┐  ┌─────────────┐  ┌─────────────┐
│ Model       │  │ 通道插件生态    │  │ 智能体运行时 │  │ 存储后端    │
│ Catalog     │  │ (Telegram,      │  │ (acpx,      │  │ (session    │
│ (模型发现)  │  │  WhatsApp, ...) │  │  embedded)  │  │  state)     │
└─────────────┘  └─────────────────┘  └─────────────┘  └─────────────┘
```

## 设计模式总结

1. **协议桥接模式**：ACP/MCP 作为外部协议到内部 Gateway 协议的转换器
2. **会话中心模式**：所有协议围绕 Gateway 会话模型构建统一抽象
3. **事件驱动架构**：实时事件通过队列和订阅机制传播
4. **多源发现模式**：模型目录支持多种来源的模型发现和配置
5. **强类型协议**：使用 TypeBox 定义 JSON Schema，确保类型安全
6. **渐进式兼容**：明确特性支持矩阵，逐步实现协议规范
7. **安全边界清晰**：协议桥接不绕过底层安全机制，权限独立检查

该架构使 OpenClaw 能够作为 **多协议 AI 网关**，同时支持 IDE 集成、代码助手场景和复杂的多通道消息路由，为不同使用场景提供统一的 AI 能力接入点。
