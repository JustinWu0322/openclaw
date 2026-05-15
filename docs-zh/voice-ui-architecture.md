# 语音与用户界面架构

> 模块路径：`src/talk/`、`src/realtime-transcription/`、`src/tui/`、`src/terminal/`、`ui/`

## 概述

OpenClaw 的语音与用户界面模块提供了多模态交互能力，涵盖语音对话、实时转录、终端用户界面和 Web 控制界面。这些模块共同构建了从命令行到图形界面，从文本输入到语音交互的完整用户体验体系。

---

## 1. 语音对话模块 (`src/talk/`)

### 职责

管理实时语音对话会话，包括音频流处理、事件序列化、会话状态控制和提供者桥接。

### 核心接口

#### 语音提供者类型

```typescript
type RealtimeVoiceProviderId = string;
type RealtimeVoiceRole = "user" | "assistant";
type RealtimeVoiceAudioFormat = {
  encoding: "g711_ulaw" | "pcm16";
  sampleRateHz: 8000 | 24000;
  channels: 1;
};
```

#### 语音桥接接口

```typescript
type RealtimeVoiceBridge = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  submitToolResult(callId: string, result: unknown): void;
  close(): void;
  isConnected(): boolean;
};
```

#### 对话事件系统

```typescript
type TalkEventType =
  | "session.started"
  | "turn.started"
  | "input.audio.delta"
  | "input.audio.complete"
  | "output.audio.delta"
  | "output.audio.complete"
  | "turn.ended"
  | "turn.timeout"
  | "turn.error"
  | "turn.cancelled"
  | "session.ended";

type TalkEvent<TPayload = unknown> = {
  id: string;
  type: TalkEventType;
  sessionId: string;
  turnId?: string;
  seq: number;
  timestamp: string;
  payload: TPayload;
};
```

### 关键组件

#### 事件序列生成器 (`talk-events.ts`)

```typescript
function createTalkEventSequencer(
  context: TalkEventContext,
  options: { now?: () => Date | string } = {},
): TalkEventSequencer {
  let seq = 0;
  return {
    next<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload> {
      assertTalkEventCorrelation(input);
      seq += 1;
      return {
        ...context,
        id: `${context.sessionId}:${seq}`,
        type: input.type,
        turnId: input.turnId,
        captureId: input.captureId,
        seq,
        timestamp: input.timestamp ?? new Date().toISOString(),
        payload: input.payload,
      };
    },
  };
}
```

#### 会话控制器 (`talk-session-controller.ts`)

**功能**：管理语音对话的回合生命周期和状态转换。

**状态管理**：

- `activeTurnId`：当前活动回合标识
- `outputAudioActive`：输出音频活动状态
- `inputAudioBuffer`：输入音频缓冲区
- `pendingToolCalls`：待处理的工具调用

#### 音频编解码器 (`audio-codec.ts`)

**功能**：音频格式转换和重采样。

**支持格式**：

- **PCM16**：16位脉冲编码调制，24kHz采样率
- **G.711 μ-law**：压缩音频格式，8kHz采样率

**关键函数**：

- `resamplePcm()`：音频重采样
- `pcmToMulaw()`：PCM 转 μ-law 压缩
- `mulawToPcm()`：μ-law 转 PCM 解压缩

#### 提供者注册表 (`provider-registry.ts`)

**功能**：动态加载和管理语音提供者插件。

**注册机制**：

```typescript
function getRealtimeVoiceProvider(
  providerId: RealtimeVoiceProviderId,
  config?: OpenClawConfig,
): RealtimeVoiceProvider | undefined {
  // 1. 从插件系统加载提供者
  const pluginProviders = resolvePluginCapabilityProviders({
    key: "realtimeVoiceProviders",
    cfg: config,
  });

  // 2. 合并内置提供者
  const allProviders = [...pluginProviders, ...BUILTIN_PROVIDERS];

  // 3. 按 ID 查找
  return allProviders.find((p) => p.id === providerId);
}
```

### 设计原则

1. **事件驱动架构**：所有语音交互通过标准化事件流表示，支持细粒度状态追踪
2. **提供者模式**：抽象语音提供者接口，支持多种后端（WebRTC、WebSocket、网关中继）
3. **桥接模式**：`RealtimeVoiceBridge` 连接不同传输协议，统一音频流处理
4. **会话状态机**：通过 `TalkSessionController` 管理回合生命周期和状态转换
5. **插件化扩展**：通过插件系统动态加载语音提供者，支持热插拔

---

## 2. 实时转录模块 (`src/realtime-transcription/`)

### 职责

提供实时语音转文本功能，支持流式音频处理和 WebSocket 连接管理。

### 核心接口

#### 转录会话接口

```typescript
type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void;
  isConnected(): boolean;
};

type RealtimeTranscriptionSessionCallbacks = {
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
};
```

### 关键组件

#### WebSocket 会话 (`websocket-session.ts`)

**功能**：创建和管理 WebSocket 转录会话。

**连接管理**：

```typescript
function createRealtimeTranscriptionWebSocketSession(
  url: string,
  callbacks: RealtimeTranscriptionSessionCallbacks,
  options?: {
    bufferSize?: number; // 音频队列缓冲大小，默认 2MB
    connectTimeout?: number; // 连接超时时间
    retryStrategy?: RetryStrategy; // 重试策略
  },
): RealtimeTranscriptionSession {
  // 实现 WebSocket 连接、音频发送和事件处理
}
```

#### 音频队列管理

**缓冲策略**：

- **队列缓冲**：连接建立前音频数据暂存于内存队列
- **大小限制**：默认 2MB 缓冲区，防止内存溢出
- **流量控制**：连接建立后按需发送缓冲数据

#### 重连机制

**指数退避策略**：

```typescript
type RetryStrategy = {
  maxAttempts: number; // 最大重试次数
  baseDelay: number; // 基础延迟（毫秒）
  maxDelay: number; // 最大延迟（毫秒）
  jitter: boolean; // 是否添加随机抖动
};
```

### 可观测性集成

#### 代理捕获系统

**功能**：调试和监控 WebSocket 通信。

**捕获内容**：

- **WebSocket 帧**：所有发送和接收的数据帧
- **连接事件**：连接建立、关闭、错误
- **音频统计**：发送的音频数据量和频率

#### 错误处理

**错误分类**：

- **连接错误**：网络不可达、认证失败
- **协议错误**：无效的 WebSocket 帧格式
- **服务错误**：转录服务内部错误

### 设计原则

1. **适配器模式**：通过 WebSocket 适配不同转录服务提供者
2. **弹性连接**：内置重连机制（指数退避）和连接超时处理
3. **流量控制**：音频队列缓冲（默认 2MB），防止内存溢出
4. **可观测性**：集成代理捕获系统，记录所有 WebSocket 帧和错误

---

## 3. 终端用户界面模块 (`src/tui/`)

### 职责

提供丰富的终端交互界面，支持聊天、命令执行、会话管理等功能。

### 核心架构

#### 状态管理接口

```typescript
type TuiStateAccess = {
  // 会话管理
  currentAgentId: string;
  currentSessionKey: string;
  sessionInfo: SessionInfo;

  // 连接状态
  isConnected: boolean;
  connectionStatus: string;
  activityStatus: string;

  // 聊天状态
  inputText: string;
  chatMessages: ChatMessage[];
  isSending: boolean;

  // UI 状态
  isEditorExpanded: boolean;
  selectedToolIndex: number;
  showHelp: boolean;

  // 配置状态
  availableModels: ModelInfo[];
  selectedModel: string;
  temperature: number;

  // ... 20+ 个状态字段
};
```

#### 后端接口抽象

```typescript
type TuiBackend = {
  // 连接配置
  connection: { url: string; token?: string };

  // 聊天操作
  sendChat(opts: ChatSendOptions): Promise<{ runId: string }>;

  // 会话管理
  listSessions(): Promise<TuiSessionList>;
  getSession(sessionKey: string): Promise<SessionInfo>;
  createSession(options?: CreateSessionOptions): Promise<SessionInfo>;

  // Agent 管理
  listAgents(): Promise<TuiAgentsList>;
  setCurrentAgent(agentId: string): Promise<void>;

  // 配置管理
  getConfig(): Promise<Partial<OpenClawConfig>>;
  updateConfig(updates: Partial<OpenClawConfig>): Promise<void>;

  // ... 10+ 个方法
};
```

### 关键组件

#### ChatLog 组件

**功能**：聊天记录显示，支持流式渲染和 Markdown。

**特性**：

- **流式渲染**：消息逐字显示，模拟打字效果
- **Markdown 支持**：渲染粗体、斜体、代码块、列表等
- **语法高亮**：代码块支持语法高亮
- **滚动管理**：自动滚动到底部，保持最新消息可见

#### CustomEditor 组件

**功能**：增强型文本编辑器，支持自动完成。

**特性**：

- **多行编辑**：支持多行文本输入
- **自动完成**：基于上下文的智能补全
- **快捷键**：Ctrl+Enter 发送、Ctrl+C 取消
- **历史记录**：支持上下箭头浏览历史消息

#### 后端实现

##### EmbeddedTuiBackend

**本地模式**：直接嵌入 OpenClaw 运行时，无网络开销。

**适用场景**：

- 本地开发和测试
- 离线环境使用
- 性能敏感应用

##### GatewayChatClient

**远程模式**：通过 WebSocket 连接远程网关。

**适用场景**：

- 多客户端访问
- 远程管理
- 负载均衡部署

### 命令处理系统

#### 快捷键映射

| 快捷键 | 功能      | 描述                 |
| ------ | --------- | -------------------- |
| Ctrl+C | 退出/清空 | 退出程序或清空输入框 |
| Ctrl+O | 工具展开  | 展开工具选择面板     |
| Ctrl+L | 模型选择  | 打开模型选择对话框   |
| Ctrl+T | 主题切换  | 切换终端主题         |
| Ctrl+H | 帮助      | 显示帮助信息         |
| Ctrl+R | 重新连接  | 重新连接后端         |
| Ctrl+S | 保存会话  | 保存当前会话状态     |

#### 命令处理器 (`tui-command-handlers.ts`)

**架构**：基于事件总线的命令分发系统。

```typescript
type CommandHandler = {
  pattern: RegExp;
  handler: (match: RegExpMatchArray, state: TuiStateAccess) => Promise<void>;
  description: string;
};

const COMMAND_HANDLERS: CommandHandler[] = [
  {
    pattern: /^\/help$/,
    handler: async (match, state) => {
      state.showHelp = true;
    },
    description: "显示帮助信息",
  },
  {
    pattern: /^\/model\s+(\w+)$/,
    handler: async (match, state) => {
      state.selectedModel = match[1];
    },
    description: "切换模型",
  },
  // ... 更多命令
];
```

### 设计原则

1. **MVC 架构**：
   - 模型：`TuiStateAccess` 管理所有状态
   - 视图：`ChatLog`、`CustomEditor` 等组件
   - 控制器：命令和事件处理器

2. **状态集中管理**：所有 UI 状态通过单一 `state` 对象访问，确保一致性

3. **前后端分离**：`TuiBackend` 抽象层支持不同后端实现

4. **响应式设计**：状态变化自动触发 UI 更新和重渲染

5. **快捷键系统**：丰富的快捷键支持，提高操作效率

---

## 4. 终端控制模块 (`src/terminal/`)

### 职责

提供终端输出格式化、ANSI 转义码处理、跨平台兼容性支持。

### 核心功能

#### ANSI 转义码处理 (`ansi.ts`)

**安全清理**：

```typescript
function sanitizeForLog(v: string): string {
  // 防止日志伪造/终端转义注入 (CWE-117)
  const controlCharsRegex = new RegExp(`[\x00-\x1f\x7f\x80-\x9f]`, "g");
  return stripAnsi(v).replace(controlCharsRegex, "");
}
```

**转义码剥离**：

```typescript
function stripAnsi(text: string): string {
  // 移除所有 ANSI 转义序列
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
```

#### Unicode 感知宽度计算

**字形分割**：

```typescript
function visibleWidth(input: string): number {
  return splitGraphemes(stripAnsi(input)).reduce(
    (sum, grapheme) => sum + graphemeWidth(grapheme),
    0,
  );
}

function splitGraphemes(text: string): string[] {
  // 使用 Intl.Segmenter 正确分割 Unicode 字形
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

function graphemeWidth(grapheme: string): number {
  // 判断字符宽度（全角=2，半角=1，控制字符=0）
  const codePoint = grapheme.codePointAt(0);
  if (!codePoint) return 0;

  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return 0; // 控制字符
  }

  // 全角字符判断
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2329 && codePoint <= 0x232a) || // 角括号
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK 扩展
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul 音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容象形文字
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // 垂直形式
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK 兼容形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角 ASCII
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // 全角符号
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) || // CJK 统一表意文字扩展
    (codePoint >= 0x30000 && codePoint <= 0x3fffd) // 保留区域
  ) {
    return 2;
  }

  return 1;
}
```

#### 终端链接格式化 (`terminal-link.ts`)

**OSC-8 超链接**：

```typescript
function formatTerminalLink(url: string, text?: string): string {
  // 生成 OSC-8 超链接序列
  return `\x1b]8;;${url}\x1b\\${text || url}\x1b]8;;\x1b\\`;
}
```

#### 表格渲染 (`table.ts`)

**对齐和格式化**：

```typescript
function renderTable(
  headers: string[],
  rows: string[][],
  options?: {
    align?: ("left" | "center" | "right")[];
    padding?: number;
    border?: boolean;
    maxWidth?: number;
  },
): string {
  // 计算列宽，考虑 Unicode 字符宽度
  const columnWidths = headers.map((header, i) => {
    const columnValues = [header, ...rows.map((row) => row[i] || "")];
    return Math.max(...columnValues.map((v) => visibleWidth(v)));
  });

  // 渲染表格
  // ...
}
```

### 主题系统 (`theme.ts`)

#### 颜色主题配置

```typescript
type TerminalTheme = {
  primary: chalk.Chalk;
  secondary: chalk.Chalk;
  success: chalk.Chalk;
  warning: chalk.Chalk;
  error: chalk.Chalk;
  info: chalk.Chalk;
  muted: chalk.Chalk;
  background: chalk.Chalk;
  foreground: chalk.Chalk;
};

function createTheme(config?: Partial<TerminalTheme>): TerminalTheme {
  const baseTheme = {
    primary: chalk.cyan,
    secondary: chalk.magenta,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    info: chalk.blue,
    muted: chalk.gray,
    background: chalk.bgBlack,
    foreground: chalk.white,
  };

  return { ...baseTheme, ...config };
}
```

#### NO_COLOR 支持

```typescript
function shouldUseColors(): boolean {
  // 尊重 NO_COLOR 环境变量
  if (process.env.NO_COLOR) {
    return false;
  }

  // 检查终端是否支持颜色
  if (process.stdout.isTTY) {
    return true;
  }

  // 检查环境变量
  return (
    process.env.COLORTERM === "truecolor" ||
    process.env.TERM_PROGRAM === "vscode" ||
    process.env.CI === "true"
  );
}
```

### 设计原则

1. **实用工具库**：提供终端操作的基础设施函数
2. **安全第一**：所有输出都经过消毒，防止终端注入攻击
3. **国际化支持**：正确处理多语言文本的显示宽度
4. **渐进增强**：检测 TTY 支持，非终端环境自动降级

---

## 5. Web 用户界面模块 (`ui/`)

### 职责

提供基于浏览器的控制界面，管理频道、配置和个人资料。

### 核心架构

#### 控制器模式

**架构设计**：每个功能域有独立控制器。

```typescript
// 频道控制器
type ChannelsController = {
  state: ChannelsState;
  actions: {
    loadChannels(): Promise<void>;
    addChannel(config: ChannelConfig): Promise<void>;
    removeChannel(channelId: string): Promise<void>;
    updateChannel(channelId: string, updates: Partial<ChannelConfig>): Promise<void>;
  };
};

// 配置控制器
type ConfigController = {
  state: ConfigState;
  actions: {
    loadConfig(): Promise<void>;
    saveConfig(updates: Partial<OpenClawConfig>): Promise<void>;
    resetConfig(): Promise<void>;
  };
};

// Agent 身份控制器
type AgentIdentityController = {
  state: AgentIdentityState;
  actions: {
    loadIdentities(): Promise<void>;
    createIdentity(identity: AgentIdentity): Promise<void>;
    updateIdentity(identityId: string, updates: Partial<AgentIdentity>): Promise<void>;
    deleteIdentity(identityId: string): Promise<void>;
  };
};
```

#### 表单状态管理

**Nostr 个人资料表单示例**：

```typescript
type NostrProfileFormState = {
  // 表单值
  values: NostrProfile;

  // 验证状态
  fieldErrors: Record<string, string>;
  isValid: boolean;

  // 操作状态
  saving: boolean;
  error: string | null;
  success: string | null;

  // 原始值（用于比较）
  original?: NostrProfile;
};

// 表单操作
type NostrProfileFormActions = {
  setField<K extends keyof NostrProfile>(field: K, value: NostrProfile[K]): void;
  validate(): boolean;
  submit(): Promise<void>;
  reset(): void;
  cancel(): void;
};
```

### API 集成模式

#### 统一的 HTTP 请求处理

```typescript
async function handleNostrProfileSave(host: ChannelsActionHost): Promise<void> {
  const { accountId, state } = host;

  // 验证表单
  if (!validateNostrProfile(state.values)) {
    state.fieldErrors = getValidationErrors(state.values);
    return;
  }

  // 设置保存状态
  state.saving = true;
  state.error = null;
  state.success = null;

  try {
    // API 调用
    const response = await fetch(`/api/channels/nostr/${accountId}/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(host),
      },
      body: JSON.stringify(state.values),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    // 更新状态
    state.saving = false;
    state.success = "Profile saved successfully";
    state.original = { ...state.values };
  } catch (error) {
    // 错误处理
    state.saving = false;
    state.error = error instanceof Error ? error.message : "Unknown error";
  }
}
```

#### 实时更新机制

**WebSocket 集成**：

```typescript
function setupRealtimeUpdates(controller: ChannelsController): () => void {
  const ws = new WebSocket(`wss://${window.location.host}/api/ws`);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "channel_updated":
        controller.actions.loadChannels();
        break;
      case "message_received":
        updateMessageList(data.channelId, data.message);
        break;
      case "connection_status":
        updateConnectionStatus(data.status);
        break;
    }
  };

  // 返回清理函数
  return () => ws.close();
}
```

### 视图组件架构

#### 组件目录结构

```
ui/src/ui/views/
├── channels/          # 频道相关视图
│   ├── ChannelList.tsx
│   ├── ChannelConfig.tsx
│   └── MessageView.tsx
├── config/           # 配置视图
│   ├── GeneralConfig.tsx
│   ├── ModelConfig.tsx
│   └── PluginConfig.tsx
├── agents/           # Agent 视图
│   ├── AgentList.tsx
│   ├── AgentEditor.tsx
│   └── AgentDashboard.tsx
└── shared/           # 共享组件
    ├── Layout.tsx
    ├── Header.tsx
    ├── Sidebar.tsx
    └── Modal.tsx
```

#### 响应式设计

**移动端适配**：

```typescript
// 使用 CSS 媒体查询和容器查询
const useResponsive = () => {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return { isMobile };
};
```

### 国际化支持

#### i18n 基础设施

```typescript
// 语言资源文件结构
type LocaleResources = {
  common: {
    save: string;
    cancel: string;
    delete: string;
    edit: string;
    // ...
  };
  channels: {
    title: string;
    addChannel: string;
    editChannel: string;
    deleteChannel: string;
    // ...
  };
  config: {
    title: string;
    general: string;
    models: string;
    plugins: string;
    // ...
  };
};

// 多语言支持
const SUPPORTED_LOCALES = ["en", "zh-CN", "ja", "ko", "es", "fr", "de"];
```

### Service Worker 集成

#### 离线支持

```typescript
// 注册 Service Worker
if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", {
        scope: "/",
      })
      .then((registration) => {
        console.log("SW registered:", registration);
      })
      .catch((error) => {
        console.log("SW registration failed:", error);
      });
  });
}
```

#### 缓存策略

```typescript
// Service Worker 缓存配置
const CACHE_NAME = "openclaw-ui-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.ico",
  // 其他静态资源
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
});
```

### 设计原则

1. **基于控制器的状态管理**：每个控制器管理特定领域状态
2. **服务工作者支持**：生产环境自动注册 Service Worker
3. **国际化就绪**：完整的 i18n 基础设施
4. **渐进式 Web 应用**：支持离线能力和应用式体验

---

## 6. 模块间依赖关系

### 架构依赖图

```
┌─────────────────┐    ┌──────────────────────────┐
│   ui/ (Web UI)  │────│  Gateway API (HTTP/WS)   │
└─────────────────┘    └────────────┬─────────────┘
                                    │
┌─────────────────┐    ┌────────────▼─────────────┐
│ src/tui/ (TUI)  │────│  src/tui/tui-backend.ts  │
└─────────────────┘    └────────────┬─────────────┘
                                    │
┌─────────────────┐    ┌────────────▼─────────────┐
│ src/terminal/   │◄───│  TUI 输出格式化          │
└─────────────────┘    └────────────┬─────────────┘
                                    │
┌────────────────────────────────────▼──────────────────────────────────┐
│                     Core Runtime (src/agents/, src/config/)           │
└────────────────────────────┬──────────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
┌─────────▼─────────┐ ┌─────▼──────┐ ┌─────────▼─────────┐
│   src/talk/       │ │  src/      │ │  Plugin System    │
│   (语音对话)      │ │  realtime- │ │  (extensions/)    │
└───────────────────┘ │  transcription/│ └───────────────────┘
                      └───────────────┘
```

### 关键集成点

1. **语音与转录集成**：`src/talk/` 和 `src/realtime-transcription/` 通过插件系统与核心运行时集成

2. **TUI 后端适配**：`src/tui/` 通过 `TuiBackend` 接口适配本地和远程运行模式

3. **终端输出链**：`src/tui/` 使用 `src/terminal/` 进行安全的终端输出格式化

4. **Web UI API 集成**：`ui/` 模块通过 HTTP/WebSocket 与网关 API 通信

5. **统一配置管理**：所有 UI 模块共享 `src/config/` 的配置系统

### 跨模块通信协议

#### 事件总线模式

```typescript
// 跨模块事件定义
type UIEvents = {
  "session:created": { sessionKey: string; agentId: string };
  "session:updated": { sessionKey: string; updates: Partial<SessionInfo> };
  "session:deleted": { sessionKey: string };
  "message:received": { sessionKey: string; message: ChatMessage };
  "message:sent": { sessionKey: string; message: ChatMessage };
  "connection:status": { status: "connected" | "disconnected" | "error"; error?: string };
  "config:updated": { updates: Partial<OpenClawConfig> };
};

// 事件总线实现
class EventBus {
  private listeners = new Map<keyof UIEvents, Array<(data: any) => void>>();

  emit<K extends keyof UIEvents>(event: K, data: UIEvents[K]): void {
    const handlers = this.listeners.get(event) || [];
    handlers.forEach((handler) => handler(data));
  }

  on<K extends keyof UIEvents>(event: K, handler: (data: UIEvents[K]) => void): () => void {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);

    // 返回取消订阅函数
    return () => {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    };
  }
}
```

## 7. 设计模式总结

### 核心设计模式

1. **插件化架构**：语音、转录功能通过插件系统扩展
2. **事件驱动**：核心交互通过标准化事件流通信
3. **状态集中管理**：UI 状态通过单一可信源管理
4. **抽象后端接口**：支持本地和远程多种运行模式
5. **安全优先**：终端输出消毒，防止注入攻击
6. **国际化支持**：Web UI 和终端输出都考虑多语言

### 用户体验原则

1. **渐进式交互**：从简单文本输入到复杂语音对话的渐进体验
2. **多模态支持**：文本、语音、图形界面多种交互方式
3. **响应式设计**：适应不同设备和屏幕尺寸
4. **无障碍访问**：考虑视觉、听觉障碍用户的访问需求

### 性能优化策略

1. **懒加载**：按需加载 UI 组件和资源
2. **缓存策略**：静态资源和 API 响应缓存
3. **流式处理**：语音和文本的流式传输和处理
4. **并发控制**：限制同时活动的语音会话数量

该架构为 OpenClaw 提供了全面、灵活、高效的用户交互能力，支持从简单的命令行操作到复杂的多模态对话体验。
