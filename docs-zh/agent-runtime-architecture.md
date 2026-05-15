# Agent 运行时架构

> 模块路径：`src/agents/`

## 概述

Agent 运行时是 OpenClaw 最大的核心模块（~100+ 文件），是驱动 AI Agent 的引擎。它负责 Agent 身份解析、执行合约、沙箱隔离、凭据管理、技能注入、故障转移和首次启动引导。

## 子系统总览

```
src/agents/
├── identity.ts              # Agent 身份解析（名称、emoji、前缀）
├── execution-contract.ts     # 执行合约（strict-agentic / default）
├── defaults.ts               # 产品级默认值
├── failover-policy.ts        # 故障转移策略分类
├── live-model-switch.ts      # 会话内动态模型切换
├── agent-scope.ts            # Agent 作用域解析（共享）
├── bootstrap-prompt.ts       # Bootstrap 提示构建
├── bootstrap-hooks.ts        # Bootstrap Hook 扩展点
├── sandbox/                  # 沙箱隔离
├── auth-profiles/            # 认证配置管理
├── skills/                   # 技能系统
├── pi-embedded-runner/       # 嵌入式 Pi Agent 运行器
└── ...
```

---

## 1. Agent 身份解析 (`identity.ts`)

### 职责

解析 Agent 运行时的"身份"信息——名称、emoji、消息前缀等。采用**分层覆盖模式**：

```
channel-account > channel > global > agent-identity fallback
```

### 关键函数

| 函数                                                  | 说明                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `resolveAgentIdentity(cfg, agentId)`                  | 获取指定 Agent 的 IdentityConfig                                                          |
| `resolveAckReaction(cfg, agentId, opts?)`             | 4 级级联解析确认回复表情：channel-account → channel → global → agent emoji，默认 `"eyes"` |
| `resolveIdentityNamePrefix(cfg, agentId)`             | 返回 `[AgentName]` 括号前缀                                                               |
| `resolveMessagePrefix(cfg, agentId, opts?)`           | 出站消息前缀，支持 `"auto"` 关键字映射到 Agent 名称前缀                                   |
| `resolveEffectiveMessagesConfig(cfg, agentId, opts?)` | 复合解析返回 messagePrefix + responsePrefix                                               |
| `resolveHumanDelayConfig(cfg, agentId)`               | 合并全局 `agents.defaults.humanDelay` 与每 Agent 覆盖                                     |

### 架构模式

- 所有解析函数遵循统一的多级覆盖策略
- `"auto"` 是一个解析时哨兵值，映射到 Agent 的 `[Name]` 前缀
- 委托 `agent-scope.js` 进行 Agent 作用域解析

---

## 2. 执行合约 (`execution-contract.ts`)

### 职责

决定 Agent 运行使用 `"strict-agentic"` 还是 `"default"` 执行合约。

### 行为矩阵

| 条件                                          | 结果                               |
| --------------------------------------------- | ---------------------------------- |
| 支持 Provider/Model + 配置 `"strict-agentic"` | `"strict-agentic"`                 |
| 支持 Provider/Model + 配置 `"default"`        | `"default"`（显式退出）            |
| 支持 Provider/Model + 未配置                  | `"strict-agentic"`（自动激活）     |
| 不支持 Provider/Model                         | `"default"`（即使配置要求 strict） |

### 关键函数

| 函数                                                         | 说明                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `isStrictAgenticSupportedProviderModel({provider, modelId})` | 仅 `openai`/`openai-codex`/`mock-openai` + GPT-5 系列返回 `true` |
| `resolveEffectiveExecutionContract(params)`                  | 主解析器                                                         |
| `stripProviderPrefix(modelId)`                               | 归一化 `openai/gpt-5.4` → `gpt-5.4`                              |

### 设计要点

- **strict-agentic** 是 GPT-5 系列专属的运行时合约
- 不支持的 Provider/Model 始终回退到 `"default"`，防止配置错误导致运行时异常
- `mock-openai` 显式列入支持，确保 QA/测试通道正常

---

## 3. 产品默认值 (`defaults.ts`)

```typescript
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_CONTEXT_TOKENS = 200_000;
```

单一定义点，确保 Agent 子系统的默认值一致。

---

## 4. 故障转移策略 (`failover-policy.ts`)

### 职责

对故障原因进行分类，决定是否允许冷却探测及使用何种冷却槽位。

### 故障原因分类

| 类别     | 原因                                                                             | 行为                      |
| -------- | -------------------------------------------------------------------------------- | ------------------------- |
| 允许探测 | `rate_limit`, `overloaded`, `billing`, `unknown`, `empty_response`, `timeout` 等 | 重试可能成功              |
| 瞬时槽位 | 同上减去 `billing`                                                               | 使用临时冷却槽位          |
| 保持槽位 | `model_not_found`, `format`, `auth`, `auth_permanent`, `session_expired`         | 持久/认证错误，不会自恢复 |

### 设计理念

- 恢复性错误（限流、过载）→ 短暂冷却后允许重试
- 持久性错误（认证失败、格式错误）→ 保持槽位占用，避免重复失败
- `billing` 介于两者之间：允许探测但不使用瞬态槽位

---

## 5. 会话内动态模型切换 (`live-model-switch.ts`)

### 职责

在活跃会话中切换模型/Provider。

### 解析链

```
session store entry → persisted override → provider/model 归一化 → Agent 默认模型
```

### 工作机制

1. `resolveLiveSessionModelSelection()` 从会话存储读取持久化覆盖
2. `requestLiveSessionModelSwitch()` 先中止当前嵌入式 Pi 运行
3. 下次运行自动使用新选择

### 类型

```typescript
type LiveSessionModelSelection = {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: string;
};
```

---

## 6. 沙箱系统 (`sandbox/`)

### 职责

提供隔离的执行环境（Docker 容器、SSH 后端），管理文件系统桥接、浏览器自动化和工具策略。

### 核心类型

| 类型                        | 说明                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- | ------- | --------- |
| `SandboxConfig`             | 顶层配置：`{mode, backend, scope, workspaceAccess, docker, ssh, browser, tools, prune}`  |
| `SandboxContext`            | 运行时上下文：`{enabled, backendId, sessionKey, workspaceDir, runtimeId, containerName}` |
| `SandboxScope`              | 生命周期范围：`"session"                                                                 | "agent" | "shared"` |
| `SandboxWorkspaceAccess`    | 工作区挂载：`"none"                                                                      | "ro"    | "rw"`     |
| `SandboxBrowserContext`     | 浏览器自动化：`{bridgeUrl, noVncUrl?, containerName}`                                    |
| `SandboxToolPolicyResolved` | 工具策略（带来源追踪：agent/global/default）                                             |

### 后端

- **Docker 后端** — 主要后端，容器化管理
- **SSH 后端** — 远程执行替代方案

### 子模块

| 模块                                | 职责                              |
| ----------------------------------- | --------------------------------- |
| `backend.ts`                        | 后端抽象接口                      |
| `docker-backend.ts`                 | Docker 实现                       |
| `ssh-backend.ts`                    | SSH 实现                          |
| `fs-bridge.ts`                      | 主机↔沙箱文件操作桥接             |
| `browser.ts` / `browser-bridges.ts` | 浏览器沙箱（CDP + noVNC）         |
| `registry.ts`                       | 活跃沙箱容器追踪                  |
| `manage.ts`                         | 生命周期操作（list, stop, prune） |
| `tool-policy.ts`                    | 工具 allow/deny 策略解析          |
| `workspace-mounts.ts`               | 工作区目录挂载                    |
| `prune.ts`                          | 空闲/过期沙箱清理                 |
| `validate-sandbox-security.ts`      | 安全验证                          |
| `config-hash.ts`                    | 配置变更检测（触发容器重建）      |

---

## 7. 认证配置管理 (`auth-profiles/`)

### 职责

管理 Provider 认证凭据（API Key、Token、OAuth），支持配置轮换、冷却和使用统计。

### 凭据类型（判别联合）

| 类型               | 标识              | 说明                    |
| ------------------ | ----------------- | ----------------------- |
| `ApiKeyCredential` | `type: "api_key"` | 静态 API 密钥           |
| `TokenCredential`  | `type: "token"`   | 不可刷新的 Bearer Token |
| `OAuthCredential`  | `type: "oauth"`   | 可刷新的 OAuth 凭据     |

### 状态管理

```typescript
type AuthProfileState = {
  order?: Record<string, string[]>; // 偏好排序
  lastGood?: Record<string, string>; // 上次成功的 Profile
  usageStats?: Record<string, ProfileUsageStats>; // 使用统计
};

type ProfileUsageStats = {
  lastUsed: number;
  cooldownUntil?: number; // 冷却截止
  cooldownReason?: string; // 冷却原因
  disabledUntil?: number; // 禁用截止
  errorCount: number;
  failureCounts: Record<string, number>;
};
```

### 关键机制

- **轮换策略**：`order` 偏好排序 + `usageStats` 轮询 + 冷却避让
- **OAuth 管理**：Token 刷新、并发 Agent 刷新协调
- **可移植性**：`copyToAgents` 控制是否可克隆到新 Agent（OAuth 默认不可移植）
- **文件锁**：`upsert-with-lock.ts` 防止并发写损坏
- **诊断/修复**：`doctor.ts` + `repair.ts` 自动修复

---

## 8. 技能系统 (`skills/`)

### 职责

管理 Agent 的技能——从 SKILL.md 文件加载，通过提示注入暴露给模型。

### 核心类型

| 类型                    | 说明                                                       |
| ----------------------- | ---------------------------------------------------------- | --------- | --------------------------- | --- | --------- |
| `Skill`                 | 扩展 `@earendil-works/pi-coding-agent` 的 `CanonicalSkill` |
| `SourceScope`           | `"user"                                                    | "project" | "temporary"` — 技能可见范围 |
| `SkillInvocationPolicy` | `{userInvocable, disableModelInvocation}` — 谁可调用       |
| `SkillInstallSpec`      | 安装方式：`brew                                            | node      | go                          | uv  | download` |
| `SkillCommandSpec`      | 用户可触发的命令面                                         |

### 技能生命周期

```
发现 (source.ts/local-loader.ts)
  → 过滤 (filter.ts/agent-filter.ts — OS/需求/策略)
  → Frontmatter 解析 (frontmatter.ts)
  → 缓存刷新 (refresh.ts/refresh-state.ts)
  → 提示格式化 (skill-contract.ts → <available_skills> XML)
  → 模型注入
```

### 提示格式

技能列表格式化为 XML 注入模型上下文：

```xml
<available_skills>
  <skill name="browser">Browse the web</skill>
  <skill name="search">Search the web</skill>
</available_skills>
```

### 安装规范

支持多个包生态系统：Homebrew (`brew`)、npm (`node`)、Go (`go`)、uv/Python (`uv`)、直接下载 (`download`)。

---

## 9. Bootstrap 引导 (`bootstrap-prompt.ts`, `bootstrap-hooks.ts`)

### 职责

构建 Agent 首次启动引导提示，支持插件通过 Hook 自定义引导流程。

### 两种模式

| 模式                                          | 说明                               |
| --------------------------------------------- | ---------------------------------- |
| **完整** (`buildFullBootstrapPromptLines`)    | Agent 可完成 BOOTSTRAP.md 工作流   |
| **受限** (`buildLimitedBootstrapPromptLines`) | Agent 只能部分引导，禁止声称已完成 |

### Hook 扩展

```typescript
// 插件可监听 "agent:bootstrap" 事件修改引导文件
applyBootstrapHookOverrides({
  files: WorkspaceBootstrapFile[],
  workspaceDir, config, sessionKey, agentId
})
```

---

## 跨模块关系

```
              OpenClawConfig
                   |
      +------------+------------+-------------+
      |            |            |             |
  identity.ts  execution-   defaults.ts   live-model-
  (分层解析)    contract.ts  (常量)        switch.ts
               (合约门控)                  (会话模型切换)
      |            |                         |
  agent-scope  agent-scope               model-selection
  (共享解析)    (共享解析)               + sessions/store

  bootstrap-prompt  bootstrap-hooks
  (提示组装)        (内部 Hook)
       |                  |
       +--- 引导工作流 ---+
                |
          internal-hooks

  sandbox/          auth-profiles/        skills/
  (隔离环境)        (凭据管理)            (能力注入)
  - Docker/SSH      - API Key/Token/OAuth  - SKILL.md 加载
  - fs-bridge       - 轮换 + 冷却          - 提示格式化
  - browser/VNC     - 会话覆盖             - 安装规范
  - 工具策略         - 可移植性             - 命令分发
```

## 架构模式总结

1. **分层覆盖**：配置值从具体（channel-account）到通用（global/default）级联
2. **判别联合**：凭据类型 (`api_key`/`token`/`oauth`)、执行合约 (`default`/`strict-agentic`)、沙箱模式
3. **Agent 作用域委托**：大多数模块将 Agent 特定配置解析委托给 `agent-scope.js`
4. **Provider/Model 门控**：执行合约和故障转移策略都基于 Provider + Model 身份进行门控
5. **Hook 可扩展**：Bootstrap Hook 提供插件级自定义能力
