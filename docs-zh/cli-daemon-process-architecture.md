# CLI、守护进程与进程管理架构

> 模块路径：`src/cli/`、`src/commands/`、`src/daemon/`、`src/process/`、`src/wizard/`、`src/flows/`、`src/hooks/`

## 概述

OpenClaw 的 CLI、守护进程和进程管理模块构成了系统的用户交互、服务管理和进程控制基础架构。这些模块提供了命令行界面、跨平台服务管理、进程执行控制、交互式配置向导、流程扩展系统和事件钩子机制，共同构建了 OpenClaw 的操作和管理能力。

---

## 1. CLI 模块 (`src/cli/`)

### 职责

提供统一的命令行接口，基于 `commander` 库构建命令解析、参数处理和输出格式化系统。

### 核心组件

#### 程序构建 (`build-program.ts`)

**功能**：创建 `Command` 实例并配置全局设置。

**关键函数**：

```typescript
function buildProgram(): Command {
  const program = new Command();
  program.enablePositionalOptions();

  const ctx = createProgramContext();
  const argv = process.argv;

  setProgramContext(program, ctx);
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);
  registerProgramCommands(program, ctx, argv);

  return program;
}
```

#### 命令注册表 (`command-registry.ts`)

**功能**：协调核心命令和子命令的注册。

**注册机制**：

- **核心命令组**：`crestodian`、`setup`、`onboard`、`configure`、`config`、`backup`、`migrate`、`doctor`、`dashboard`、`reset`、`uninstall`、`message`、`mcp`、`agent`、`agents`、`status`、`health`、`sessions`、`commitments`、`tasks`
- **注册模块**：每个命令组对应独立的注册模块（如 `register.crestodian.js`）
- **命令实现**：实际命令逻辑位于 `src/commands/` 目录，通过注册模块连接

#### 程序上下文 (`context.ts`)

**功能**：管理程序运行时上下文信息。

**关键接口**：

```typescript
type ProgramContext = {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
};
```

### 命令行参数解析

#### 调用解析 (`argv-invocation.js`)

**功能**：解析命令行参数，识别主要命令和子命令。

**解析策略**：

- **主要命令检测**：识别用户意图执行的主要命令
- **参数规范化**：统一处理不同风格的参数格式
- **环境感知**：根据运行环境自动配置合适的参数处理方式

#### 命令路径策略 (`command-path-policy.ts`)

**功能**：管理命令路径的解析和验证规则。

**策略包括**：

- **路径白名单**：允许的命令路径模式
- **安全限制**：防止路径遍历攻击
- **平台适配**：不同操作系统的路径处理差异

### 设计原则

1. **关注点分离**：程序构建、命令注册、上下文管理分离
2. **插件化架构**：支持动态加载命令模块
3. **平台适配**：根据运行环境自动配置合适的参数处理方式
4. **错误处理**：统一的退出代码管理和错误报告机制

---

## 2. Commands 模块 (`src/commands/`)

### 职责

实现具体的 CLI 命令逻辑，提供系统操作和管理功能。

### 模块结构

| 命令类别     | 主要命令                                | 功能描述                   |
| ------------ | --------------------------------------- | -------------------------- |
| **系统管理** | `setup`、`configure`、`doctor`、`reset` | 系统安装、配置、诊断和重置 |
| **服务管理** | `daemon`、`service`、`status`、`health` | 守护进程控制和服务状态监控 |
| **会话管理** | `sessions`、`agents`、`tasks`           | 会话、Agent 和任务管理     |
| **消息处理** | `message`、`mcp`                        | 消息发送和协议桥接         |
| **数据管理** | `backup`、`migrate`、`commitments`      | 数据备份、迁移和承诺管理   |

### 命令实现模式

#### 命令基类

```typescript
abstract class BaseCommand {
  abstract name: string;
  abstract description: string;

  abstract setup(program: Command): void;
  abstract execute(options: CommandOptions): Promise<void>;

  protected validateOptions(options: CommandOptions): void {
    // 通用参数验证逻辑
  }

  protected logProgress(message: string): void {
    // 进度日志记录
  }
}
```

#### 命令注册

```typescript
// 注册模块示例 (register.crestodian.js)
export function registerCrestodianCommand(program: Command, ctx: ProgramContext) {
  program
    .command("crestodian")
    .description("Manage OpenClaw crestodian service")
    .option("--start", "Start the crestodian service")
    .option("--stop", "Stop the crestodian service")
    .option("--restart", "Restart the crestodian service")
    .action(async (options) => {
      const command = new CrestodianCommand();
      await command.execute(options);
    });
}
```

### 依赖关系

- **依赖 flows 模块**：提供配置流程和选项选择
- **依赖 process 模块**：执行子进程和命令队列管理
- **依赖 daemon 模块**：管理服务状态和控制
- **依赖 hooks 模块**：处理命令执行前后的事件钩子

---

## 3. Daemon 模块 (`src/daemon/`)

### 职责

提供跨平台的守护进程管理抽象，支持 macOS（launchd）、Linux（systemd）和 Windows（schtasks）三种服务管理方式。

### 核心抽象

#### 网关服务接口 (`service.ts`)

**统一接口定义**：

```typescript
type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  stage: (args: GatewayServiceStageArgs) => Promise<void>;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};
```

#### 服务状态接口

```typescript
type GatewayServiceState = {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig | null;
  runtime: GatewayServiceRuntime | undefined;
};
```

### 平台适配器

#### 平台服务注册表

```typescript
const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: ignoreServiceWriteResult(stageLaunchAgent),
    install: ignoreServiceWriteResult(installLaunchAgent),
    uninstall: uninstallLaunchAgent,
    stop: stopLaunchAgent,
    restart: restartLaunchAgent,
    isLoaded: isLaunchAgentLoaded,
    readCommand: readLaunchAgentProgramArguments,
    readRuntime: readLaunchAgentRuntime,
  },
  linux: {
    label: "systemd user",
    loadedText: "enabled",
    notLoadedText: "disabled",
    stage: ignoreServiceWriteResult(stageSystemdService),
    install: ignoreServiceWriteResult(installSystemdService),
    uninstall: uninstallSystemdService,
    stop: stopSystemdService,
    restart: restartSystemdService,
    isLoaded: isSystemdServiceEnabled,
    readCommand: readSystemdServiceExecStart,
    readRuntime: readSystemdServiceRuntime,
  },
  win32: {
    label: "Scheduled Task",
    loadedText: "registered",
    notLoadedText: "missing",
    stage: ignoreServiceWriteResult(stageScheduledTask),
    install: ignoreServiceWriteResult(installScheduledTask),
    uninstall: uninstallScheduledTask,
    stop: stopScheduledTask,
    restart: restartScheduledTask,
    isLoaded: isScheduledTaskInstalled,
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
  },
};
```

#### 平台检测与适配

```typescript
function resolveGatewayService(): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    return withFutureConfigGuard(GATEWAY_SERVICE_REGISTRY[process.platform]);
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
```

### 关键功能

#### 服务状态读取

```typescript
async function readGatewayServiceState(
  service: GatewayService,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? (process.env as GatewayServiceEnv);
  const command = await service.readCommand(baseEnv).catch(() => null);
  const env = mergeGatewayServiceEnv(baseEnv, command);
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env }).catch(() => false),
    service.readRuntime(env).catch(() => undefined),
  ]);
  return {
    installed: command !== null,
    loaded,
    running: runtime?.status === "running",
    env,
    command,
    runtime,
  };
}
```

#### 服务启动流程

```typescript
type GatewayServiceStartResult = {
  outcome: "missing-install" | "repair-required" | "scheduled" | "started";
  state: GatewayServiceState;
  issues?: GatewayServiceStartRepairIssue[];
};
```

### 设计原则

1. **跨平台抽象**：统一的接口屏蔽平台差异
2. **状态管理**：统一的服务状态查询和监控
3. **安全隔离**：服务配置文件的权限控制和环境隔离
4. **故障恢复**：自动检测和修复服务配置问题

---

## 4. Process 模块 (`src/process/`)

### 职责

提供进程管理功能，包括子进程执行、进程树管理、命令队列和资源控制。

### 核心组件

#### 进程执行 (`exec.ts`)

**功能**：跨平台进程执行，处理 Windows 批处理文件特殊逻辑。

**关键函数**：

```typescript
// Windows 命令行构建
function buildCmdExeCommandLine(resolvedCommand: string, args: string[]): string {
  return [escapeForCmdExe(resolvedCommand), ...args.map(escapeForCmdExe)].join(" ");
}

function escapeForCmdExe(arg: string): string {
  // 拒绝 cmd 元字符以避免注入攻击
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
        "Pass an explicit shell-wrapper argv at the call site instead.",
    );
  }
  // 需要时添加引号；为 cmd 解析双写内部引号
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}
```

#### 命令队列 (`command-queue.ts`)

**功能**：命令队列管理，支持并发控制和超时处理。

**队列架构**：

```typescript
class CommandQueue {
  private lanes = new Map<string, CommandLane>();

  async enqueue(
    laneId: string,
    task: () => Promise<T>,
    options?: CommandQueueEnqueueOptions,
  ): Promise<T> {
    const lane = this.getOrCreateLane(laneId);

    if (lane.isDraining()) {
      throw new GatewayDrainingError();
    }

    return await lane.enqueue(task, options);
  }

  // 其他方法：clearLane、drainLane、getLaneStats 等
}
```

#### 错误类型

```typescript
class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

class CommandLaneTaskTimeoutError extends Error {
  constructor(lane: string, timeoutMs: number) {
    super(`Command lane "${lane}" task timed out after ${timeoutMs}ms`);
    this.name = "CommandLaneTaskTimeoutError";
  }
}

class GatewayDrainingError extends Error {
  constructor() {
    super("Gateway is draining for restart; new tasks are not accepted");
    this.name = "GatewayDrainingError";
  }
}
```

### 进程管理功能

#### 进程树终止 (`kill-tree.ts`)

**功能**：终止进程及其所有子进程。

**策略**：

- **信号传播**：向进程树发送终止信号
- **平台适配**：不同操作系统的进程树终止方式
- **超时控制**：强制终止长时间不响应的进程

#### Linux OOM 分数调整 (`linux-oom-score.ts`)

**功能**：调整 Linux 系统的 OOM（内存不足）分数，控制进程内存优先级。

#### 进程监控 (`supervisor/`)

**功能**：进程状态监控和自动重启机制。

### 设计原则

1. **平台兼容性**：针对 Windows、Linux、macOS 的差异处理
2. **安全执行**：防止命令注入和参数逃逸
3. **资源控制**：通过命令队列限制并发，防止资源耗尽
4. **进程隔离**：完善的进程树管理和信号处理

---

## 5. Wizard 模块 (`src/wizard/`)

### 职责

提供交互式配置向导系统，用于初始设置、身份验证配置、插件安装等交互流程。

### 核心组件

#### 向导流程类型

```typescript
type WizardFlow = "quickstart" | "gateway" | "plugins" | "auth" | "models";

// 快速启动网关默认值
type QuickstartGatewayDefaults = {
  port: number;
  host: string;
  tailscale: boolean;
  remote: boolean;
};
```

#### 向导提示器接口

```typescript
type WizardPrompter = {
  select: <T>(options: WizardSelectOption<T>[]) => Promise<T>;
  confirm: (message: string) => Promise<boolean>;
  text: (message: string) => Promise<string>;
  // 其他提示方法...
};
```

### 设置流程架构

#### 主设置流程 (`setup.ts`)

```typescript
async function runSetupFlow(
  options: OnboardOptions,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  // 1. 检测迁移源
  const migrationSources = await detectSetupMigrationSources(runtime);

  // 2. 选择设置流程
  const flow = await selectSetupFlow(prompter, migrationSources);

  // 3. 执行具体流程
  let config: OpenClawConfig;
  switch (flow) {
    case "quickstart":
      config = await runQuickstartSetup(prompter, runtime);
      break;
    case "gateway":
      config = await runGatewaySetup(prompter, runtime);
      break;
    case "plugins":
      config = await runPluginSetup(prompter, runtime);
      break;
    // 其他流程...
  }

  // 4. 最终化配置
  return await finalizeSetup(config, runtime, prompter);
}
```

#### 提示器实现 (`clack-prompter.ts`)

**功能**：基于 `@clack/prompts` 的交互式提示器。

**搜索过滤**：

```typescript
function tokenizedOptionFilter<T>(search: string, option: Option<T>): boolean {
  const tokens = normalizeSearchTokens(search);
  if (tokens.length === 0) {
    return true;
  }
  const searchText = buildOptionSearchText(option);
  return tokens.every((token) => searchText.includes(token));
}

function normalizeSearchTokens(search: string): string[] {
  return normalizeLowercaseStringOrEmpty(search)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
```

### 设置子流程

#### 网关配置 (`setup.gateway-config.ts`)

**功能**：配置网关连接参数，包括端口、主机名、远程访问等。

#### 插件配置 (`setup.plugin-config.ts`)

**功能**：选择和配置插件，支持官方插件和第三方插件。

#### 官方插件安装 (`setup.official-plugins.ts`)

**功能**：安装和管理官方插件包。

#### 迁移数据导入 (`setup.migration-import.ts`)

**功能**：从旧版本或其他系统导入配置和数据。

### 设计原则

1. **渐进式配置**：分步骤引导用户完成复杂配置
2. **交互友好**：丰富的提示类型和搜索过滤
3. **状态持久化**：会话管理和配置回滚能力
4. **插件集成**：支持插件贡献配置选项

---

## 6. Flows 模块 (`src/flows/`)

### 职责

定义插件化的流程贡献系统，允许插件为核心流程（如身份验证选择、模型选择、健康检查等）提供可选项。

### 核心类型

#### 流程贡献定义

```typescript
// 流程文档链接
type FlowDocsLink = {
  path: string;
  label?: string;
};

// 流程贡献类型
type FlowContributionKind = "channel" | "core" | "provider" | "search";

// 流程贡献表面（使用场景）
type FlowContributionSurface = "auth-choice" | "health" | "model-picker" | "setup";

// 流程选项
type FlowOption<Value extends string = string> = {
  value: Value;
  label: string;
  hint?: string;
  group?: FlowOptionGroup;
  docs?: FlowDocsLink;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
};

// 流程贡献
type FlowContribution<Value extends string = string> = {
  id: string;
  kind: FlowContributionKind;
  surface: FlowContributionSurface;
  option: FlowOption<Value>;
  source?: string;
};
```

#### 贡献排序

```typescript
function sortFlowContributionsByLabel<T extends FlowContribution>(
  contributions: readonly T[],
): T[] {
  return [...contributions].toSorted(
    (left, right) =>
      left.option.label.localeCompare(right.option.label) ||
      left.option.value.localeCompare(right.option.value),
  );
}
```

### 流程实现

#### 模型选择流程 (`model-picker.ts`)

```typescript
async function promptDefaultModel(params: PromptDefaultModelParams): Promise<string> {
  const { config, prompter, workspaceDir, env } = params;

  // 加载模型目录
  const catalog = await loadModelCatalog();

  // 构建可见模型列表
  const visibleModels = resolveVisibleModelCatalog(catalog, {
    config,
    workspaceDir,
    env,
  });

  // 构建选项
  const options = visibleModels.map((entry) => ({
    value: entry.id,
    label: entry.displayName,
    hint: entry.providerId,
    group: entry.category,
  }));

  // 显示选择提示
  const selected = await prompter.select({
    message: "Select default model",
    options,
    initialValue: config.defaultModel,
  });

  return selected;
}
```

#### 频道设置流程 (`channel-setup.ts`)

**功能**：配置消息频道，如 Telegram、WhatsApp、Discord 等。

#### 提供商配置流程 (`provider-flow.ts`)

**功能**：配置 AI 服务提供商，包括 API 密钥、端点、模型选择等。

#### 搜索设置流程 (`search-setup.ts`)

**功能**：配置搜索功能，如网络搜索、文件搜索等。

#### 健康检查贡献 (`doctor-health-contributions.ts`)

**功能**：插件向健康检查系统贡献检查项。

### 设计原则

1. **插件化架构**：允许插件向核心流程贡献选项
2. **类型安全**：强类型的流程贡献定义
3. **可发现性**：丰富的元数据和文档链接
4. **排序控制**：支持按优先级和字母顺序排序

---

## 7. Hooks 模块 (`src/hooks/`)

### 职责

提供基于文件的钩子系统，支持事件驱动的扩展机制，允许插件和外部代码在特定事件发生时执行自定义逻辑。

### 核心概念

#### 钩子元数据

```typescript
type OpenClawHookMetadata = {
  always?: boolean;
  hookKey?: string;
  emoji?: string;
  homepage?: string;
  /** 此钩子处理的事件（例如：["command:new", "session:start"]） */
  events: string[];
  /** 可选的导出名称（默认："default"） */
  export?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: HookInstallSpec[];
};
```

#### 钩子定义

```typescript
type Hook = {
  name: string;
  description: string;
  source: "openclaw-bundled" | "openclaw-managed" | "openclaw-workspace" | "openclaw-plugin";
  pluginId?: string;
  filePath: string; // HOOK.md 的路径
  baseDir: string; // 包含钩子的目录
  handlerPath: string; // 处理器模块的路径（handler.ts/js）
};

type HookEntry = {
  hook: Hook;
  frontmatter: ParsedHookFrontmatter;
  metadata?: OpenClawHookMetadata;
  invocation?: HookInvocationPolicy;
};
```

### 钩子加载器架构

#### 加载流程 (`loader.ts`)

```typescript
async function loadHookHandlers(config: OpenClawConfig, event: string): Promise<HookHandler[]> {
  const handlers: HookHandler[] = [];

  // 1. 加载内部钩子
  if (hasConfiguredInternalHooks(config)) {
    const internalHookNames = resolveConfiguredInternalHookNames(config);
    for (const hookName of internalHookNames) {
      const handler = await loadInternalHookHandler(hookName, event);
      if (handler) handlers.push(handler);
    }
  }

  // 2. 加载工作空间钩子
  const workspaceEntries = await loadWorkspaceHookEntries(config);
  for (const entry of workspaceEntries) {
    if (shouldIncludeHook(entry, config, event)) {
      const handler = await loadHookHandlerFromEntry(entry, event);
      if (handler) handlers.push(handler);
    }
  }

  // 3. 加载插件钩子
  const pluginHooks = await loadPluginHooks(config);
  for (const hook of pluginHooks) {
    if (hook.metadata?.events?.includes(event)) {
      const handler = await loadHookHandlerFromPlugin(hook, event);
      if (handler) handlers.push(handler);
    }
  }

  return handlers;
}
```

### 钩子文件格式

#### HOOK.md 示例

```markdown
---
events: ["message:received", "message:sent"]
export: "messageLogger"
requires:
  bins: ["jq"]
  env: ["LOG_LEVEL"]
---

# 消息日志钩子

此钩子在消息发送和接收时记录到系统日志。

## 配置

设置 `LOG_LEVEL` 环境变量控制日志详细程度。
```

### 钩子类型

#### 内部钩子 (`internal-hooks.ts`)

**功能**：系统内置的钩子实现，提供核心功能扩展。

#### 消息钩子 (`message-hooks.ts`)

**功能**：消息处理相关的钩子，如消息发送前/后处理、消息过滤等。

#### 插件钩子 (`plugin-hooks.ts`)

**功能**：插件管理和生命周期钩子。

#### Gmail 钩子 (`gmail*.ts`)

**功能**：Gmail 集成特定的钩子实现。

### 设计原则

1. **声明式配置**：基于文件的钩子定义，易于理解和维护
2. **动态加载**：运行时按需加载钩子处理器
3. **沙箱安全**：隔离钩子执行环境，防止恶意代码
4. **依赖管理**：声明式依赖检查，确保钩子可执行

---

## 8. 模块间依赖关系

### 架构依赖图

```
CLI 模块 (src/cli/)
├── 依赖 commands 模块 (src/commands/) 获取具体命令实现
├── 依赖 daemon 模块 (src/daemon/) 实现服务管理命令
├── 依赖 wizard 模块 (src/wizard/) 实现交互式设置
└── 依赖 hooks 模块 (src/hooks/) 执行命令钩子

Commands 模块 (src/commands/)
├── 依赖 flows 模块 (src/flows/) 提供配置流程
├── 依赖 process 模块 (src/process/) 执行子进程
├── 依赖 daemon 模块 (src/daemon/) 管理服务状态
└── 依赖 hooks 模块 (src/hooks/) 处理命令事件

Daemon 模块 (src/daemon/)
├── 独立的核心服务抽象
└── 被 CLI 和 Commands 模块调用

Process 模块 (src/process/)
├── 独立的进程管理工具
└── 被 Commands 和 Daemon 模块调用

Wizard 模块 (src/wizard/)
├── 依赖 flows 模块 (src/flows/) 提供选择选项
└── 被 CLI 模块调用

Flows 模块 (src/flows/)
├── 提供插件化的流程贡献系统
└── 被 Wizard 和 Commands 模块调用

Hooks 模块 (src/hooks/)
├── 提供事件驱动的扩展系统
└── 被所有其他模块作为扩展点使用
```

### 关键依赖模式

1. **单向依赖**：高层模块依赖底层模块，避免循环依赖
2. **接口抽象**：模块间通过定义良好的接口通信
3. **插件架构**：通过 hooks 和 flows 模块提供扩展点
4. **平台适配**：通过抽象层屏蔽平台差异

---

## 9. 架构设计原则总结

### 核心设计原则

1. **模块化**：功能清晰的模块划分，高内聚低耦合
2. **可扩展性**：通过 hooks 和 flows 系统支持插件扩展
3. **跨平台兼容**：抽象层处理平台差异，统一接口
4. **类型安全**：全面的 TypeScript 类型定义
5. **错误处理**：统一的错误处理和数据恢复机制

### 安全设计

1. **沙箱执行**：钩子和插件在受限环境中运行
2. **输入验证**：严格的参数验证和转义
3. **权限控制**：服务配置文件的权限管理
4. **安全审计**：内置的安全检查和漏洞检测

### 性能考虑

1. **懒加载**：动态导入减少启动时间
2. **命令队列**：控制并发避免资源竞争
3. **缓存策略**：配置和状态缓存优化
4. **进程管理**：高效的子进程生命周期管理

### 可维护性

1. **文档化**：丰富的代码注释和类型定义
2. **测试覆盖**：完善的单元测试和集成测试
3. **配置管理**：声明式配置和版本迁移
4. **错误报告**：详细的错误信息和调试支持

该架构为 OpenClaw 提供了强大、灵活、安全的用户交互和系统管理能力，支持从简单的命令行操作到复杂的交互式配置流程，满足不同用户场景的需求。
