---
title: 沙箱系统架构
summary: OpenClaw 沙箱系统的内部架构文档，面向维护者，涵盖配置解析、运行时上下文、后端抽象、Docker/SSH/OpenShell 后端、文件系统桥接、浏览器沙箱、工具策略和生命周期管理。
---

# 沙箱系统架构

沙箱系统负责把 Agent 的工具执行放到受控运行时中，降低模型执行命令、读写文件和使用浏览器时对宿主机的影响范围。它不承诺提供完美安全边界；它的职责是把执行位置、工作区可见性、工具权限和运行时生命周期显式化，并在危险配置进入 Docker 或远程后端前尽早拒绝。

## 代码地图

沙箱主体位于 `src/agents/sandbox/`，对外通过 `src/agents/sandbox.ts` 聚合导出。插件后端通过 `src/plugin-sdk/sandbox.ts` 复用后端注册和 SSH/remote FS bridge 能力。

| 文件                                                  | 职责                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `config.ts`                                           | 解析 `agents.defaults.sandbox` 与 `agents.list[].sandbox`，合并 Docker、SSH、browser、prune、tool policy 默认值 |
| `types.ts` / `backend*.ts`                            | 定义 `SandboxConfig`、`SandboxContext`、`SandboxBackendHandle`、后端注册表和管理接口                            |
| `context.ts`                                          | 根据 session/agent/config 决定是否启用沙箱，准备工作区，创建后端，组装 `SandboxContext`                         |
| `docker.ts` / `docker-backend.ts`                     | Docker 容器创建、配置哈希、exec argv 构造、runtime manager                                                      |
| `ssh.ts` / `ssh-backend.ts`                           | SSH 配置物化、远程命令执行、远程 canonical 工作区、runtime manager                                              |
| `fs-bridge.ts` / `remote-fs-bridge.ts`                | Docker/local mount 与远程 shell 后端的文件系统桥接                                                              |
| `fs-paths.ts` / `fs-bridge-path-safety.ts`            | host/container 路径映射、挂载优先级、符号链接与 canonical 路径校验                                              |
| `validate-sandbox-security.ts`                        | Docker bind、network、seccomp、AppArmor 的运行时安全校验                                                        |
| `browser.ts` / `browser-bridges.ts` / `novnc-auth.ts` | Docker 浏览器沙箱、CDP bridge、noVNC 观察链接                                                                   |
| `registry.ts` / `manage.ts` / `prune.ts`              | runtime 注册表、list/recreate/remove、空闲和过期清理                                                            |
| `tool-policy.ts` / `runtime-status.ts`                | 沙箱内工具 allow/deny 解析、阻断诊断、`sandbox explain` 支撑                                                    |
| `workspace.ts` / `workspace-mounts.ts`                | 沙箱工作区种子文件、Docker 工作区挂载参数                                                                       |

OpenShell 后端在插件内实现：

| 文件                                    | 职责                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `extensions/openshell/index.ts`         | 插件 full registration 时调用 `registerSandboxBackend("openshell", ...)`     |
| `extensions/openshell/src/backend.ts`   | OpenShell sandbox create/get/delete、SSH config 获取、mirror/remote 模式编排 |
| `extensions/openshell/src/fs-bridge.ts` | OpenShell `mirror` 模式的本地 canonical 文件桥                               |
| `extensions/openshell/src/mirror.ts`    | 本地/远程目录同步，过滤 `.git`、hooks、git-hooks 和符号链接                  |
| `extensions/openshell/src/config.ts`    | 插件配置 schema 与默认值                                                     |

## 总体分层

```text
┌──────────────────────────────────────────────────────────────┐
│ Agent run / Codex app server / compact run                    │
│ resolveSandboxContext(config, sessionKey, workspaceDir)        │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ 运行时决策层                                                   │
│ runtime-status.ts: mode + main session 判断是否 sandboxed       │
│ config.ts: 合并 agent/global/default 沙箱配置                   │
│ context.ts: scopeKey、workspaceDir、backend、browser、fsBridge   │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ 后端抽象层                                                     │
│ SandboxBackendHandle                                           │
│ buildExecSpec / finalizeExec / runShellCommand / createFsBridge │
└───────────────┬─────────────────────┬────────────────────────┘
                │                     │
      ┌─────────▼─────────┐ ┌─────────▼─────────┐ ┌────────────▼────────────┐
      │ Docker backend     │ │ SSH backend        │ │ OpenShell plugin backend │
      │ local container    │ │ remote canonical   │ │ mirror / remote          │
      └─────────┬─────────┘ └─────────┬─────────┘ └────────────┬────────────┘
                │                     │                        │
┌───────────────▼─────────────────────▼────────────────────────▼────────────┐
│ 工具消费层                                                                  │
│ exec/process 使用 buildExecSpec；read/write/edit/apply_patch 使用 fsBridge； │
│ browser 工具使用 sandboxBrowserBridgeUrl；prompt media 通过 bridge 读取。     │
└────────────────────────────────────────────────────────────────────────────┘
```

## 配置模型

沙箱配置源是 `agents.defaults.sandbox`，每个 agent 可用 `agents.list[].sandbox` 覆盖。解析入口是 `resolveSandboxConfigForAgent(cfg, agentId)`。

核心类型：

```typescript
type SandboxConfig = {
  mode: "off" | "non-main" | "all";
  backend: string; // docker | ssh | openshell | plugin-registered backend
  scope: "session" | "agent" | "shared";
  workspaceAccess: "none" | "ro" | "rw";
  workspaceRoot: string;
  docker: SandboxDockerConfig;
  ssh: SandboxSshConfig;
  browser: SandboxBrowserConfig;
  tools: SandboxToolPolicy;
  prune: SandboxPruneConfig;
};
```

关键默认值：

| 字段                  | 默认值                           | 说明                                                |
| --------------------- | -------------------------------- | --------------------------------------------------- |
| `mode`                | `off`                            | 默认不启用沙箱                                      |
| `backend`             | `docker`                         | 启用沙箱但未指定后端时使用 Docker                   |
| `scope`               | `agent`                          | 默认一个 agent 一个 runtime；兼容旧 `perSession`    |
| `workspaceAccess`     | `none`                           | 默认不把 agent workspace 作为可写主工作区暴露给沙箱 |
| `workspaceRoot`       | `STATE_DIR/sandboxes`            | 本地沙箱工作区根目录                                |
| `docker.image`        | `openclaw-sandbox:bookworm-slim` | 默认命令执行镜像                                    |
| `docker.network`      | `none`                           | 命令容器默认无网络                                  |
| `docker.readOnlyRoot` | `true`                           | 容器根文件系统默认只读                              |
| `docker.capDrop`      | `["ALL"]`                        | 默认丢弃 Linux capabilities                         |
| `prune.idleHours`     | `24`                             | 空闲清理阈值                                        |
| `prune.maxAgeDays`    | `7`                              | 最大保留时间                                        |

Agent 覆盖有一个重要例外：当 `scope: "shared"` 时，agent 级别的 `docker`、`browser`、`ssh`、`prune` 子配置不会覆盖全局配置，因为 shared runtime 不能同时满足多个 agent 的运行时差异。

## 运行时决策流程

`resolveSandboxContext()` 是沙箱进入 Agent 运行时的主入口。

```text
resolveSandboxContext()
  │
  ├─ resolveSandboxRuntimeStatus()
  │    ├─ 从 sessionKey 推断 agentId
  │    ├─ 解析 mainSessionKey
  │    └─ mode=off/all/non-main 判断 session 是否 sandboxed
  │
  ├─ resolveSandboxConfigForAgent()
  │
  ├─ maybePruneSandboxes()
  │
  ├─ ensureSandboxWorkspaceLayout()
  │    ├─ 计算 scopeKey: session | agent:<id> | shared
  │    ├─ workspaceAccess=rw  → 使用 agent workspace
  │    └─ workspaceAccess!=rw → 使用 sandbox workspace 并同步 skills
  │
  ├─ requireSandboxBackendFactory(backend)
  ├─ backendFactory(...): SandboxBackendHandle
  ├─ updateRegistry(runtime)
  ├─ ensureSandboxBrowser() 可选
  └─ createFsBridge() 或默认 createSandboxFsBridge()
```

`scope` 决定 runtime 复用粒度：

| Scope     | `scopeKey`        | 行为                                     |
| --------- | ----------------- | ---------------------------------------- |
| `session` | 原始 session key  | 每个会话独立 runtime                     |
| `agent`   | `agent:<agentId>` | 同一 agent 的 sandboxed 会话共享 runtime |
| `shared`  | `shared`          | 全局共享 runtime                         |

`mode: "non-main"` 用 `mainSessionKey` 判断，而不是用 agent id 判断。渠道群聊、线程和非 main session key 会进入沙箱。

## 工作区模型

沙箱同时跟踪两个目录：

- `agentWorkspaceDir`: agent 的真实工作区。
- `workspaceDir`: 当前运行实际使用的工作区，可能是真实工作区，也可能是 `workspaceRoot/<scope-slug>` 下的沙箱工作区。

`workspaceAccess` 控制这两个目录的关系：

| `workspaceAccess` | `context.workspaceDir` | Docker 主挂载     | `/agent` 挂载             | 写入语义                               |
| ----------------- | ---------------------- | ----------------- | ------------------------- | -------------------------------------- |
| `rw`              | `agentWorkspaceDir`    | `/workspace` 可写 | 通常无额外挂载            | 沙箱直接写真实工作区                   |
| `ro`              | sandbox workspace      | `/workspace` 只读 | 真实 agent workspace 只读 | 工具读真实 agent workspace，写入被拒绝 |
| `none`            | sandbox workspace      | `/workspace` 只读 | 无 `/agent`               | 沙箱只看到 seeded sandbox workspace    |

当使用 sandbox workspace 时，`ensureSandboxWorkspace()` 会从真实工作区复制基础 bootstrap 文件（如 `AGENTS.md`、`SOUL.md`、`TOOLS.md` 等），再调用 `ensureAgentWorkspace()` 补齐缺失文件。`context.ts` 还会在 `workspaceAccess !== "rw"` 时把符合条件的 remote skills 同步到 sandbox workspace。

## 后端抽象

后端通过 `registerSandboxBackend(id, { factory, manager })` 注册。内置注册发生在 `src/agents/sandbox/backend.ts`：

- `docker` → `createDockerSandboxBackend`
- `ssh` → `createSshSandboxBackend`

插件可通过 `openclaw/plugin-sdk/sandbox` 注册新后端；OpenShell 插件就是这种模式。

`SandboxBackendHandle` 是运行时后端契约：

| 方法/字段                           | 说明                                                        |
| ----------------------------------- | ----------------------------------------------------------- |
| `id` / `runtimeId` / `runtimeLabel` | 后端标识与 runtime 展示名                                   |
| `workdir`                           | 后端中的默认工作目录                                        |
| `env`                               | 注入 exec 的默认环境变量                                    |
| `configLabel` / `configLabelKind`   | registry/list 用于显示和检测当前配置是否匹配                |
| `capabilities.browser`              | 后端是否支持浏览器沙箱                                      |
| `buildExecSpec()`                   | 把 shell command 转成宿主进程 argv/env/stdin/finalize token |
| `finalizeExec()`                    | exec 完成后释放 SSH session 或做 mirror 同步                |
| `runShellCommand()`                 | 文件桥运行内部 shell helper 的通道                          |
| `createFsBridge()`                  | 可选，后端自定义文件桥                                      |

`SandboxBackendManager` 负责 CLI/生命周期能力：

- `describeRuntime()` 用于 `openclaw sandbox list` 判断是否还在运行、配置标签是否匹配。
- `removeRuntime()` 用于 `openclaw sandbox recreate` 和 prune 删除后端 runtime。

## Docker 后端

Docker 是本地默认后端。`ensureSandboxContainer()` 负责容器生命周期：

1. 根据 `scopeKey` 生成容器名：`${containerPrefix}${slugifySessionKey(scopeKey)}`。
2. 计算配置哈希：Docker 配置、`workspaceAccess`、host workspace 路径、agent workspace 路径、mount format version。
3. 如果容器不存在，创建并启动。
4. 如果容器存在但配置哈希不匹配：
   - 最近 5 分钟还在运行的 hot container 不强删，只输出 `openclaw sandbox recreate ...` 提示。
   - 非 hot container 会被删除并重建。
5. 如果容器停止，重新启动。
6. 更新 sharded registry。

容器创建参数由 `buildSandboxCreateArgs()` 与 `appendWorkspaceMountArgs()` 组合：

- `--read-only`、`--tmpfs /tmp` 等只读根文件系统支持。
- `--network` 默认 `none`。
- `--cap-drop ALL` 与 `--security-opt no-new-privileges` 默认启用。
- `seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`、`pidsLimit`、`memory`、`cpus`、`gpus`、`ulimits` 可配置。
- `docker.env` 会先经过 `sanitizeEnvVars()`，阻止常见 token、API key、password、private key 等环境变量进入容器。
- `setupCommand` 在容器创建后运行一次。

exec 工具不直接拼 `docker exec`，而是调用后端的 `buildExecSpec()`。Docker 后端构造 `docker exec -i [-t] -w <workdir> -e ... <container> /bin/sh -lc <command>`，并对 PATH 做额外处理，避免宿主 PATH 影响容器内部 shell 查找。

## SSH 后端

SSH 后端用于把工具执行放到任意 SSH 可达主机。它不支持 `sandbox.docker.binds`，也不支持浏览器沙箱。

运行时目录由 `resolveSshRuntimePaths(workspaceRoot, scopeKey)` 生成：

```text
<workspaceRoot>/<runtimeId>/
  workspace/   # remoteWorkspaceDir
  agent/       # remoteAgentWorkspaceDir
```

SSH 后端是 remote-canonical 模型：

1. 首次使用时检查 `runtimeRootDir` 是否存在。
2. 不存在则从本地 `workspaceDir` 上传到 remote `workspace/`。
3. 当 `workspaceAccess !== "none"` 且 agent workspace 与 workspaceDir 不同，也上传 agent workspace 到 remote `agent/`。
4. 后续 `exec`、read/write/edit/apply_patch 都直接操作远程目录。
5. 远程变更不会自动同步回本地；`openclaw sandbox recreate` 删除远程 runtime 后，下次从本地重新 seed。

SSH 认证材料支持两类来源：

- `identityFile`、`certificateFile`、`knownHostsFile`: 使用本地已有文件。
- `identityData`、`certificateData`、`knownHostsData`: 内联字符串或 SecretRef 解析结果，运行时写入临时 `0600` 文件，SSH session 释放时删除。

`createSshSandboxSessionFromSettings()` 会生成临时 OpenSSH config，固定 host alias 为 `openclaw-sandbox`，并设置 `BatchMode`、连接超时、host key 策略等。`buildSshSandboxArgv()` 统一处理 TTY 与非 TTY 模式。

## OpenShell 后端

OpenShell 是插件后端，不在 core 中硬编码。`extensions/openshell/index.ts` 在 full registration 模式下注册 `openshell` backend。

OpenShell 后端生命周期：

```text
createOpenShellSandboxBackend()
  ├─ sandbox get <name>
  ├─ 不存在则 sandbox create --name <name> --from <source> ...
  ├─ sandbox ssh-config <name>
  ├─ 通过 core SSH session 执行远程命令
  └─ 通过 manager 调用 sandbox delete <name>
```

OpenShell 支持两种工作区模式：

| 模式     | canonical 位置           | 文件桥                               | exec 前后行为                                         |
| -------- | ------------------------ | ------------------------------------ | ----------------------------------------------------- |
| `mirror` | 本地工作区               | `createOpenShellFsBridge()`          | exec 前上传本地快照，exec 后下载远程 workspace 回本地 |
| `remote` | OpenShell 远程 workspace | `createRemoteShellSandboxFsBridge()` | 首次 create 后 seed 一次，之后直接远程读写            |

`mirror` 模式会过滤 `.git`、`hooks`、`git-hooks`，并通过 `stageDirectoryContents()` 丢弃符号链接和特殊文件，避免远程内容覆盖可信宿主元数据或跟随宿主机外部路径。

OpenShell 配置默认值：

| 字段                      | 默认值                                        |
| ------------------------- | --------------------------------------------- |
| `command`                 | `openshell`，优先解析 bundled `openshell` bin |
| `mode`                    | `mirror`                                      |
| `from`                    | `openclaw`                                    |
| `remoteWorkspaceDir`      | `/sandbox`                                    |
| `remoteAgentWorkspaceDir` | `/agent`                                      |
| `timeoutSeconds`          | `120`                                         |

远程目录必须位于 `/sandbox` 或 `/agent` 下。

## 文件系统桥接

文件工具不直接访问任意路径。沙箱启用后，`src/agents/pi-tools.ts` 会：

- 用 `createSandboxedReadTool()` 替换 read。
- 在 `workspaceAccess === "ro"` 时硬禁用 write/edit/apply_patch。
- 在可写沙箱中把 apply_patch 的文件操作接到 `SandboxFsBridge`。
- exec/process 走后端 `buildExecSpec()`。

默认 Docker/local bridge 是 `createSandboxFsBridge()`。它先构造 mounts：

1. workspace mount: host `workspaceDir` ↔ container `containerWorkdir`。
2. agent mount: 当 `workspaceAccess !== "none"` 且 agent workspace 不同，host `agentWorkspaceDir` ↔ container `/agent`。
3. custom binds: 来自 `docker.binds`，bind 的 host/container 路径优先级高于默认 mount。

路径解析支持两种输入：

- container 绝对路径，例如 `/workspace/src/index.ts`。
- host 相对/绝对路径，按当前 cwd 与 mount hostRoot 映射回 container path。

安全校验由 `SandboxFsPathGuard` 执行：

- 先按词法路径判断 container path 是否落在允许 mount 下。
- 用 host root 打开目标，防止 host 路径逃逸。
- 在沙箱中通过 `readlink -f` 获取 canonical container path，再确认 canonical path 仍在允许 mount 下。
- 写、删、重命名使用 pinned parent + basename 模式，避免检查后到使用前的符号链接替换。
- read/stat 拒绝 hardlink 或非预期类型。

远程后端使用 `createRemoteShellSandboxFsBridge()`，逻辑相同但所有操作通过 `runRemoteShellScript()` 在远程执行；OpenShell `mirror` 模式使用 `createOpenShellFsBridge()`，本地文件操作成功后再同步对应路径到远程。

## 安全校验

Docker 创建前会调用 `validateSandboxSecurity()`。它覆盖四类危险配置：

| 校验             | 默认行为                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| bind source      | 必须是绝对 host 路径；拒绝 `/etc`、`/proc`、`/sys`、`/dev`、`/root`、Docker socket、常见 home credential 子目录等 |
| bind source root | 默认必须落在 runtime allow roots，即当前 `workspaceDir` 与 `agentWorkspaceDir`                                    |
| bind target      | 默认拒绝覆盖 `/workspace` 和 `/agent`，防止 shadow OpenClaw 管理挂载                                              |
| network          | 拒绝 `host`；默认拒绝 `container:<id>` namespace join                                                             |
| seccomp/AppArmor | 拒绝 `unconfined`                                                                                                 |

存在三个显式 dangerous override：

- `dangerouslyAllowReservedContainerTargets`
- `dangerouslyAllowExternalBindSources`
- `dangerouslyAllowContainerNamespaceJoin`

这些 override 只放宽对应校验；blocked host paths、`host` network、`unconfined` profiles 仍由专门校验保护。

## 工具策略

沙箱是否启用决定“工具在哪里运行”；工具策略决定“哪些工具可见”。沙箱内额外应用 `tools.sandbox.tools` 或 `agents.list[].tools.sandbox.tools`。

默认 allow：

```text
exec, process, read, write, edit, apply_patch, image,
sessions_list, sessions_history, sessions_send, sessions_spawn,
sessions_yield, subagents, session_status
```

默认 deny：

```text
browser, canvas, nodes, cron, gateway, <所有 channel id>
```

解析规则：

- agent 级 `agents.list[].tools.sandbox.tools.*` 优先于全局 `tools.sandbox.tools.*`。
- `allow: []` 保持旧语义：允许全部。
- `alsoAllow` 可在默认 allow 基础上补充工具。
- `group:*` 会展开成工具组。
- 显式 allowlist 会自动保留 `image`，除非 deny 明确阻止。
- deny 始终优先；非空 allowlist 会阻止未匹配工具。

被沙箱工具策略阻止时，`formatSandboxToolPolicyBlockedMessage()` 会生成带 session、原因、修复 key 和 `openclaw sandbox explain` 命令的诊断。

## 浏览器沙箱

浏览器沙箱只在后端声明 `capabilities.browser === true` 时可用。目前 Docker 后端支持，SSH 和 OpenShell 不支持。

`ensureSandboxBrowser()` 的主要流程：

1. 检查 `browser.enabled` 和沙箱工具策略是否允许 `browser`。
2. 生成 browser 容器名 `${browser.containerPrefix}${scopeSlug}`。
3. 用 browser Docker 配置、端口、noVNC、CDP source range、workspace mount 和 security epoch 计算配置哈希。
4. 创建独立 Docker network（默认 `openclaw-sandbox-browser`）或复用已有 network。
5. 创建 browser 容器，暴露 CDP/noVNC 到宿主 `127.0.0.1` 随机端口。
6. 启动本地 browser bridge server，把 OpenClaw browser tool 请求转发到 sandbox CDP。
7. 更新 browser registry，并返回 `SandboxBrowserContext`。

CDP ingress 默认 fail-closed：

- 显式 `browser.cdpSourceRange` 优先。
- 否则只对 bridge-like Docker network 自动取 gateway IPv4 `/32`。
- `network: "none"` 使用 `127.0.0.1/32`。
- 其他无法推断的 network 必须显式配置 `cdpSourceRange`。

noVNC 默认启用且有密码。OpenClaw 不把密码放在查询参数里，而是生成短期 token URL，通过本地 bootstrap 页面在 URL fragment 中打开 noVNC。

## Registry、CLI 与清理

沙箱 runtime metadata 存储在 sharded registry 中：

```text
STATE_DIR/sandbox/
  containers/<sha256(containerName)>.json
  browsers/<sha256(containerName)>.json
```

旧版 monolithic 文件仍可迁移：

- `STATE_DIR/sandbox/containers.json`
- `STATE_DIR/sandbox/browsers.json`

迁移由 `migrateLegacySandboxRegistryFiles()` 执行，通常通过 doctor 修复流程触发。无效 legacy 文件会 quarantine，避免一个坏 JSON 隐藏当前 sharded entries。

CLI 管理入口：

| 命令                        | 实现                                    | 行为                                                                           |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `openclaw sandbox explain`  | `src/commands/sandbox-explain.ts`       | 输出有效 sandbox、tool policy、elevated gate 和 fix-it key                     |
| `openclaw sandbox list`     | `src/commands/sandbox.ts` + `manage.ts` | 读取 registry，调用后端 manager 描述 runtime 状态和配置匹配                    |
| `openclaw sandbox recreate` | `src/commands/sandbox.ts` + `manage.ts` | 按 `--all`、`--session`、`--agent`、`--browser` 删除 runtime，下次使用自动重建 |

`maybePruneSandboxes()` 每 5 分钟最多执行一次。它按当前配置的 `prune.idleHours` 和 `prune.maxAgeDays` 删除过期 container/browser runtime，并清理 browser bridge server 状态。

## 与 Agent 运行时的集成

PI embedded runner 与 Codex app server 都在准备 run 时调用 `resolveSandboxContext()`：

```text
resolvedWorkspace = agent workspace
sandbox = resolveSandboxContext(config, sandboxSessionKey, resolvedWorkspace)
effectiveWorkspace =
  sandbox.enabled
    ? sandbox.workspaceAccess === "rw" ? resolvedWorkspace : sandbox.workspaceDir
    : resolvedWorkspace
```

这个 `effectiveWorkspace` 后续用于 skill prompt、bootstrap/context engine 等。`workspaceAccess !== "rw"` 时，运行时不会复用外部传入的 skills snapshot，而是从 effective workspace 重新解析，确保 prompt 输入与沙箱可见文件一致。

`pi-tools.ts` 把 `SandboxContext` 分发给各类工具：

- `exec`: 传入 `containerName`、`workspaceDir`、`containerWorkdir`、后端 env、`buildExecSpec`、`finalizeExec`。
- `read`: 通过 `SandboxFsBridge` 读取，必要时附加 `/agent` 只读 mount 信息给 workspace guard。
- `write/edit`: sandbox 启用时不使用 host write/edit 工具；可写路径由 bridge 或 apply_patch 处理。
- `apply_patch`: 仅在 `workspaceAccess !== "ro"` 时提供；sandbox 中通过 bridge 写入。
- plugin/browser tools: 接收 `sandboxed`、`sandboxBrowserBridgeUrl`、`allowHostBrowserControl` 等上下文。

## 设计边界

- Core 只知道后端注册契约，不硬编码 OpenShell 细节。
- Docker 专属字段只在 Docker/browser Docker 创建时生效；SSH/OpenShell 明确拒绝 `docker.binds`。
- 浏览器沙箱是 Docker-only 能力，后端必须显式声明支持。
- 远程 canonical 后端不会自动把远程变更同步回本地，除非 OpenShell `mirror` 模式显式这么做。
- Runtime 变更不靠启动时迁移修补；旧 runtime 通过配置哈希、registry manager、`sandbox recreate` 和 prune 管理。
- 沙箱工具策略不替代底层隔离。允许 `exec` 后，shell 内部副作用由 backend/workspaceAccess/bind/network 约束，而不是由 `write`/`edit` deny 自动约束。

## 相关文档

- `docs/gateway/sandboxing.md` — 用户向 sandbox 配置参考。
- `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md` — sandbox、工具策略、elevated 的区别。
- `docs/tools/multi-agent-sandbox-tools.md` — 多 agent 下 sandbox 和工具策略优先级。
- `docs/cli/sandbox.md` — `openclaw sandbox` CLI 用法。
- `docs-zh/security-architecture.md` — 安全分层中的沙箱位置。
- `docs-zh/tools-architecture.md` — 工具注册、策略与执行框架。
