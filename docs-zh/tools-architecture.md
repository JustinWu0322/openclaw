---
title: "工具注册与执行框架架构"
summary: "OpenClaw 工具系统的实现细节，涵盖工具描述符、可用性求值、执行计划、策略管道、工具调用和多来源工具注册"
---

# 工具注册与执行框架架构

工具系统是 OpenClaw Agent 与外部世界交互的核心机制。它负责：声明工具能力（描述符）、判断工具是否可用（可用性求值）、构建最终工具集（执行计划）、应用权限策略（策略管道）、以及实际执行工具调用。

## 代码地图

工具系统分布在三个层次：

### 工具契约层 (`src/tools/`)
| 文件 | 职责 |
|------|------|
| `types.ts` | 核心类型定义：ToolDescriptor、ToolPlan、ToolExecutorRef、可用性表达式 |
| `planner.ts` | 构建工具执行计划（buildToolPlan）：排序、去重、可用性过滤 |
| `availability.ts` | 可用性表达式求值引擎：信号评估、allOf/anyOf 组合逻辑 |
| `execution.ts` | 执行器引用格式化（core/plugin/channel/mcp） |
| `protocol.ts` | 工具描述符到模型协议格式的转换 |
| `descriptors.ts` | 类型安全的描述符定义辅助函数 |
| `diagnostics.ts` | 工具计划契约错误（重名、缺执行器） |

### 工具注册与策略层 (`src/agents/`)
| 文件 | 职责 |
|------|------|
| `openclaw-tools.ts` | 核心工具工厂：创建所有内置工具实例 |
| `tool-catalog.ts` | 工具目录：定义所有核心工具 ID、分区、Profile 映射 |
| `tool-policy-pipeline.ts` | 策略管道：多层策略叠加过滤 |
| `tool-policy.ts` | 策略解析：allow/deny 列表、Profile 策略、插件组展开 |
| `pi-tools.policy.ts` | 有效策略解析：全局/agent/provider/group 策略合并 |
| `pi-tools.before-tool-call.ts` | before_tool_call 钩子包装 |
| `tools/` | 各具体工具实现（bash、read、write、web_search 等） |

### 工具调用层 (`src/gateway/`)
| 文件 | 职责 |
|------|------|
| `tool-resolution.ts` | Gateway 作用域工具解析：合并核心+插件+渠道工具 |
| `tools-invoke-shared.ts` | 工具调用共享逻辑：查找、权限检查、执行 |
| `tools-invoke-http.ts` | HTTP `/tools/invoke` 端点处理 |
| `server-methods/tools-catalog.ts` | RPC 工具目录查询方法 |
| `server-methods/tools-effective.ts` | 有效工具列表（经策略过滤后） |

## 总体分层

```text
┌─────────────────────────────────────────────────────────────────┐
│                    模型 / Agent Runner                            │
│         接收 ToolPlan.visible 作为可用工具列表                     │
└──────────────────────────────┬──────────────────────────────────┘
                               │ 工具调用指令
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    工具执行分发                                    │
│                                                                 │
│  ToolExecutorRef.kind:                                          │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐               │
│  │  core  │  │ plugin │  │channel │  │  mcp   │               │
│  │内置工具 │  │插件工具 │  │渠道动作 │  │MCP工具 │               │
│  └────────┘  └────────┘  └────────┘  └────────┘               │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    策略管道 (Tool Policy Pipeline)                │
│                                                                 │
│  Profile策略 → Provider Profile策略 → 全局策略 → Provider全局策略  │
│  → Agent策略 → Agent Provider策略 → Group策略 → Subagent策略     │
│  → Gateway HTTP 拒绝列表 → Owner-only 策略                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    工具计划构建 (buildToolPlan)                    │
│                                                                 │
│  输入: ToolDescriptor[]  +  ToolAvailabilityContext              │
│  输出: ToolPlan { visible: ToolPlanEntry[], hidden: [...] }      │
│                                                                 │
│  流程: 排序 → 去重校验 → 可用性求值 → 分流(visible/hidden)        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    工具描述符注册                                  │
│                                                                 │
│  来源:                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ 核心工具      │  │ 插件工具      │  │ MCP 工具     │          │
│  │(tool-catalog) │  │(plugin-sdk)  │  │(mcp-http)   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ 渠道动作      │  │ Skill 工具   │                             │
│  │(channel-tools)│  │(workspace)   │                             │
│  └──────────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

## 工具描述符 (ToolDescriptor)

每个工具通过 `ToolDescriptor` 声明自身能力：

```typescript
type ToolDescriptor = {
  name: string;              // 唯一标识符，如 "bash", "web_search"
  title?: string;            // 显示名称
  description: string;       // 给模型看的功能描述
  inputSchema: JsonObject;   // JSON Schema 定义输入参数
  outputSchema?: JsonObject; // 可选的输出 Schema
  owner: ToolOwnerRef;       // 所有者：core | plugin | channel | mcp
  executor?: ToolExecutorRef;// 执行器引用（可用时必须存在）
  availability?: ToolAvailabilityExpression; // 可用性条件
  annotations?: JsonObject;  // 元数据注解
  sortKey?: string;          // 排序键
};
```

### 所有者类型 (ToolOwnerRef)

| Kind | 含义 | 示例 |
|------|------|------|
| `core` | 内置核心工具 | bash, read, write, edit |
| `plugin` | 插件提供的工具 | browser, memory_search |
| `channel` | 渠道特定动作 | discord_send_reaction |
| `mcp` | MCP 服务器工具 | 外部 MCP 工具 |

### 执行器引用 (ToolExecutorRef)

格式化为字符串用于路由：
- `core:bash` — 核心执行器
- `plugin:browser:navigate` — 插件工具
- `channel:discord:send_reaction` — 渠道动作
- `mcp:my-server:query_db` — MCP 工具

## 可用性求值引擎

工具可用性通过声明式表达式定义，运行时求值决定工具是否对当前会话可见。

### 信号类型 (ToolAvailabilitySignal)

| Kind | 含义 | 求值逻辑 |
|------|------|----------|
| `always` | 始终可用 | 直接通过 |
| `auth` | 需要认证提供商 | 检查 authProviderIds 集合 |
| `config` | 需要配置值存在 | 按路径查找配置，支持 exists/non-empty/available 检查 |
| `env` | 需要环境变量 | 检查 env[name] 非空 |
| `plugin-enabled` | 需要插件启用 | 检查 enabledPluginIds 集合 |
| `context` | 需要上下文值匹配 | 检查 values[key]，可选 equals 精确匹配 |

### 组合逻辑

```typescript
// 所有条件都满足
{ allOf: [signal1, signal2, ...] }

// 任一条件满足即可
{ anyOf: [signal1, signal2, ...] }

// 可嵌套
{ allOf: [{ kind: "auth", providerId: "openai" }, { anyOf: [...] }] }
```

### 求值结果

- 通过 → 工具进入 `visible` 列表
- 失败 → 工具进入 `hidden` 列表，附带 `ToolAvailabilityDiagnostic[]` 说明原因

## 工具计划构建 (buildToolPlan)

```text
输入 descriptors[]
       │
       ▼
  按 sortKey/name 排序
       │
       ▼
  唯一性校验 (重名 → ToolPlanContractError)
       │
       ▼
  逐个求值 availability
       │
       ├── 诊断为空 → 检查 executor 存在 → visible[]
       │
       └── 诊断非空 → hidden[] (附带诊断信息)
```

## 策略管道 (Tool Policy Pipeline)

策略管道是一个有序的过滤器链，每层可以 allow/deny 工具：

```text
┌─────────────────────────────────────────────────────┐
│ 1. Profile 策略 (tools.profile: "coding"|"full"|...)│
├─────────────────────────────────────────────────────┤
│ 2. Provider Profile 策略 (tools.byProvider.profile) │
├─────────────────────────────────────────────────────┤
│ 3. 全局策略 (tools.allow / tools.deny)              │
├─────────────────────────────────────────────────────┤
│ 4. Provider 全局策略 (tools.byProvider.allow/deny)  │
├─────────────────────────────────────────────────────┤
│ 5. Agent 策略 (agents.<id>.tools.allow/deny)        │
├─────────────────────────────────────────────────────┤
│ 6. Agent Provider 策略                              │
├─────────────────────────────────────────────────────┤
│ 7. Group 策略 (渠道/账户级别)                        │
├─────────────────────────────────────────────────────┤
│ 8. Subagent 策略 (子 agent 能力限制)                 │
├─────────────────────────────────────────────────────┤
│ 9. Gateway HTTP 拒绝列表 (安全硬编码)               │
├─────────────────────────────────────────────────────┤
│ 10. Owner-only 策略 (非 owner 会话限制)             │
└─────────────────────────────────────────────────────┘
```

每层策略格式：
```typescript
type ToolPolicyLike = {
  allow?: string[];  // 白名单（支持通配符、插件组）
  deny?: string[];   // 黑名单
};
```

特殊展开规则：
- `@plugin:<pluginId>` → 展开为该插件所有工具
- Profile 名称（如 `coding`）→ 展开为预定义工具集

## 核心工具目录 (Tool Catalog)

内置工具按功能分区：

| 分区 | 工具 |
|------|------|
| **Files** | `read`, `write`, `edit`, `apply_patch` |
| **Runtime** | `bash`, `process`, `exec` |
| **Web** | `web_search`, `web_fetch`, `browser` |
| **Memory** | `memory_search`, `memory_get` |
| **Sessions** | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `session_status` |
| **UI** | `canvas` |
| **Messaging** | `message` (跨渠道发送) |
| **Automation** | `cron`, `update_plan` |
| **Nodes** | `nodes` (设备节点调用) |
| **Agents** | `agents_list`, `subagents` |
| **Media** | `image`, `image_generate`, `video_generate`, `music_generate`, `tts`, `pdf` |

### Profile 预设

| Profile | 包含工具 |
|---------|----------|
| `minimal` | 基础文件+运行时 |
| `coding` | minimal + web + memory + sessions |
| `messaging` | coding + message + nodes |
| `full` | 所有工具 |

## 工具执行流程

```text
Agent Runner 发出工具调用指令
       │
       ▼
before_tool_call 钩子 (可拦截/修改)
       │
       ▼
按 ToolExecutorRef.kind 分发
       │
       ├── core → 直接调用内置工具实现
       │          (src/agents/tools/*.ts)
       │
       ├── plugin → 通过 Plugin SDK 调用插件工具
       │            (getPluginToolMeta → plugin.executeTool)
       │
       ├── channel → 渠道动作执行
       │             (getChannelAgentToolMeta → channel.executeAction)
       │
       └── mcp → MCP 协议调用
                 (mcp-http loopback → 外部 MCP 服务器)
       │
       ▼
工具结果返回 Agent Runner → 继续推理循环
```

## Gateway 工具调用 HTTP API

`POST /tools/invoke` 端点允许外部直接调用工具：

```json
{
  "tool": "web_search",
  "args": { "query": "OpenClaw" },
  "sessionKey": "main"
}
```

调用流程：
1. HTTP 认证（共享密钥/Token）
2. 解析 sessionKey → 确定 agent 上下文
3. `resolveGatewayScopedTools` 构建当前可用工具集
4. 查找目标工具 → 权限检查（Gateway HTTP 拒绝列表）
5. `before_tool_call` 钩子
6. 执行工具 → 返回结果

## 插件工具注册

插件通过 Plugin SDK 注册工具：

```typescript
// 插件 manifest 中声明
export const plugin = definePlugin({
  tools: [
    {
      name: "my_tool",
      description: "...",
      inputSchema: { ... },
      execute: async (args, context) => { ... }
    }
  ]
});
```

运行时通过 `getPluginToolMeta(pluginId, toolName)` 查找并执行。

## 内置工具完整列表

### Files（文件操作）
| 工具名 | 用途 |
|--------|------|
| `read` | 读取文件内容 |
| `write` | 创建或覆盖文件 |
| `edit` | 精确编辑文件（局部修改） |
| `apply_patch` | 应用补丁到文件 |

### Runtime（运行时）
| 工具名 | 用途 |
|--------|------|
| `exec` | 执行 shell 命令 |
| `process` | 管理长运行进程 |
| `code_execution` | 在远程沙箱中运行代码分析 |

### Web（网络）
| 工具名 | 用途 |
|--------|------|
| `web_search` | 搜索互联网 |
| `web_fetch` | 抓取网页内容 |
| `x_search` | 搜索 X (Twitter) 帖子 |

### Memory（记忆）
| 工具名 | 用途 |
|--------|------|
| `memory_search` | 语义搜索记忆库 |
| `memory_get` | 读取记忆文件 |

### Sessions（会话）
| 工具名 | 用途 |
|--------|------|
| `sessions_list` | 列出所有会话 |
| `sessions_history` | 查看会话历史记录 |
| `sessions_send` | 向其他会话发送消息 |
| `sessions_spawn` | 创建子 agent 会话 |
| `sessions_yield` | 结束当前 turn，等待子 agent 结果 |
| `subagents` | 管理子 agent |
| `session_status` | 查看当前会话状态 |

### UI（界面）
| 工具名 | 用途 |
|--------|------|
| `browser` | 控制浏览器（Playwright 自动化） |
| `canvas` | 控制节点 Canvas 可视化画布 |

### Messaging（消息）
| 工具名 | 用途 |
|--------|------|
| `message` | 跨渠道发送消息 |

### Automation（自动化）
| 工具名 | 用途 |
|--------|------|
| `cron` | 管理定时任务（创建/列出/删除） |
| `gateway` | Gateway 控制操作 |
| `heartbeat_respond` | 记录心跳检查结果 |

### Nodes（节点）
| 工具名 | 用途 |
|--------|------|
| `nodes` | 控制已配对的设备节点（iOS/Android） |

### Agents（Agent 管理）
| 工具名 | 用途 |
|--------|------|
| `agents_list` | 列出所有 agent |
| `update_plan` | 更新执行计划 |

### Media（媒体）
| 工具名 | 用途 |
|--------|------|
| `image` | 图像理解（分析图片内容） |
| `image_generate` | 图像生成 |
| `video_generate` | 视频生成 |
| `music_generate` | 音乐生成 |
| `tts` | 文本转语音 |

### Profile 预设包含关系

| Profile | 包含的工具 |
|---------|-----------|
| **minimal** | `session_status` |
| **coding** | minimal + 全部 Files + Runtime + Web + Memory + Sessions + `cron` + `update_plan` + Media + MCP |
| **messaging** | Sessions 子集(`sessions_list/history/send`) + `message` + `session_status` |
| **full** | 所有工具（`*`） |

## 设计原则

1. **声明式可用性**：工具不自行判断是否可用，通过 availability 表达式声明前置条件，由框架统一求值
2. **策略与实现分离**：策略管道独立于工具实现，多层策略可叠加
3. **确定性排序**：工具列表排序确定，保证 prompt cache 命中率
4. **四种执行器**：core/plugin/channel/mcp 覆盖所有工具来源，统一分发
5. **诊断可观测**：hidden 工具保留诊断信息，便于 `openclaw doctor` 排查
