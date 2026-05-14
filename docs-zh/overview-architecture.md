---
title: "OpenClaw 整体架构概览"
summary: "OpenClaw 系统的全局架构图、模块划分、数据流和组件关系"
---

# OpenClaw 整体架构概览

## 系统定位

OpenClaw 是一个本地优先的个人 AI 助手平台。核心是一个 **Gateway 进程**（控制平面），连接多种消息渠道、AI 模型提供商和工具/技能，为单用户提供统一的 AI 助手体验。

## 整体架构图

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                            用户交互层                                         │
│                                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ WhatsApp │ │ Telegram │ │ Discord  │ │  Slack   │ │ Signal/iMessage/ │  │
│  │          │ │          │ │          │ │          │ │ IRC/Teams/...    │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘  │
│       │             │            │             │                │            │
│  ┌────┴─────┐ ┌─────┴────┐ ┌────┴─────┐ ┌────┴─────┐ ┌───────┴────────┐   │
│  │ macOS App│ │ iOS Node │ │ Android  │ │ WebChat  │ │  Control UI    │   │
│  │(Menu Bar)│ │          │ │  Node    │ │          │ │  (浏览器)       │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬────────┘   │
└───────┼─────────────┼────────────┼─────────────┼───────────────┼────────────┘
        │             │            │             │               │
        └─────────────┴────────────┴──────┬──────┴───────────────┘
                                          │
                                   WebSocket / HTTP
                                          │
┌─────────────────────────────────────────┼───────────────────────────────────┐
│                              Gateway 进程                                    │
│                                         │                                   │
│  ┌──────────────────────────────────────┴────────────────────────────────┐  │
│  │                        HTTP/WS 服务层                                  │  │
│  │  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐             │  │
│  │  │ 认证/鉴权│  │ RPC 方法 │  │ OpenAI   │  │ MCP HTTP  │             │  │
│  │  │ (Auth)  │  │ (Methods)│  │ 兼容 API │  │ (Loopback)│             │  │
│  │  └─────────┘  └──────────┘  └──────────┘  └───────────┘             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        核心编排层                                       │  │
│  │                                                                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │  │
│  │  │ 会话管理 │  │ Agent    │  │ 渠道管理 │  │ 配置系统 │             │  │
│  │  │(Sessions)│  │ Runner   │  │(Channels)│  │ (Config) │             │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │  │
│  │                                                                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │  │
│  │  │ 定时任务 │  │ 插件系统 │  │ 安全/沙箱│  │ 节点管理 │             │  │
│  │  │  (Cron)  │  │(Plugins) │  │(Security)│  │ (Nodes)  │             │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        能力层                                          │  │
│  │                                                                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │  │
│  │  │ 工具执行 │  │ TTS/语音 │  │ 媒体理解 │  │ 图像/视频│             │  │
│  │  │ (Tools)  │  │  (Talk)  │  │  (Media) │  │  生成    │             │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │  │
│  │                                                                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │  │
│  │  │ Web 搜索 │  │ 浏览器   │  │  Canvas  │  │  Memory  │             │  │
│  │  │(Search)  │  │(Browser) │  │ (画布)   │  │ (记忆)   │             │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        插件/扩展层 (extensions/)                        │  │
│  │                                                                       │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │  │
│  │  │ OpenAI  │ │Anthropic│ │ Google  │ │  xAI    │ │DeepSeek │       │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │  │
│  │  │WhatsApp │ │Telegram │ │ Discord │ │  Slack  │ │ Matrix  │       │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │  │
│  │  │ElevenLab│ │ Browser │ │Firecrawl│ │  Brave  │ │ Tavily  │       │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          │ HTTP/SDK
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          外部服务层                                           │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ AI 模型提供商 │  │ 消息平台 API │  │ 搜索/爬虫 API│  │ TTS/STT 服务 │   │
│  │ (LLM APIs)  │  │              │  │              │  │              │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 数据流

```text
用户消息 → 渠道插件(Ingress) → DM策略/配对检查 → 会话路由
    → Agent Runner → 模型推理 → 工具调用(循环) → 流式回复
    → 渠道插件(Egress) → 用户
```



## 核心模块说明

| 模块 | 路径 | 职责 |
|------|------|------|
| **Gateway** | `src/gateway/` | 核心控制平面。HTTP/WS 服务器、RPC 方法注册、认证鉴权、会话管理、配置热重载、节点管理 |
| **Agent Runner** | `src/agents/` | AI agent 执行引擎。模型调用、工具循环、流式事件、fallback/retry、compaction |
| **Auto-Reply** | `src/auto-reply/` | 渠道消息到 agent 的桥接层。活跃运行管理、followup/steer、typing 状态、回复 payload 组装 |
| **Config** | `src/config/` | 配置系统。Schema 定义(Zod)、多层加载、热重载、环境变量覆盖、类型导出 |
| **Channels** | `src/channels/` | 多渠道抽象。渠道注册/发现、消息适配、DM 策略、健康监控 |
| **Sessions** | `src/sessions/` | 会话模型与工具。跨会话通信(sessions_list/send/history) |
| **Plugins** | `src/plugins/` | 插件加载器。发现、注册、生命周期管理、能力声明 |
| **Plugin SDK** | `src/plugin-sdk/` | 插件开发 SDK。公开 API 表面、运行时注入、类型契约 |
| **Security** | `src/security/` | 安全框架。沙箱(Docker/SSH)、工具权限策略、审计、输入验证 |
| **Secrets** | `src/secrets/` | 凭证管理。SecretRef 架构、Auth Profile、凭证存储与解析 |
| **Cron** | `src/cron/` | 定时任务。调度引擎、持久化、启动追赶、与 agent 集成 |
| **CLI** | `src/cli/` | 命令行界面。命令注册、参数解析、交互式 TUI |
| **Talk/TTS** | `src/talk/`, `src/tts/` | 语音能力。Voice Wake、Talk Mode、TTS 合成 |
| **Media** | `src/media/`, `src/media-understanding/` | 媒体处理。图片/音频/视频理解与转码 |
| **Image/Video Gen** | `src/image-generation/`, `src/video-generation/` | 生成式媒体。图像/视频生成调度 |
| **Web Search/Fetch** | `src/web-search/`, `src/web-fetch/` | 网络能力。搜索和网页抓取 |
| **Infra** | `src/infra/` | 基础设施。进程管理、错误处理、环境检测、日志、网络工具 |
| **Tools** | `src/tools/` | 工具注册与执行框架 |
| **Hooks** | `src/hooks/` | 生命周期钩子系统。before/after 事件、webhook |
| **Routing** | `src/routing/` | 消息路由。多 agent 路由规则、渠道→agent 映射 |
| **Pairing** | `src/pairing/` | DM 配对。配对码生成、审批、允许列表 |
| **Daemon** | `src/daemon/` | 守护进程。launchd/systemd 服务安装与管理 |
| **MCP** | `src/mcp/` | Model Context Protocol 集成 |
| **ACP** | `src/acp/` | Agent Communication Protocol 集成 |

## 扩展插件 (extensions/)

扩展插件通过 Plugin SDK 与核心交互，按功能分类：

### 模型提供商 (Model Providers)
| 插件 | 说明 |
|------|------|
| `openai` | OpenAI GPT/o 系列 |
| `anthropic` | Claude 系列 |
| `google` | Gemini 系列 |
| `xai` | Grok 系列 |
| `deepseek` | DeepSeek 系列 |
| `mistral` | Mistral 系列 |
| `ollama` | 本地 Ollama |
| `openrouter` | OpenRouter 聚合 |
| `amazon-bedrock` | AWS Bedrock |
| `groq`, `cerebras`, `fireworks`, `together` | 推理加速 |
| `qwen`, `moonshot`, `volcengine`, `minimax` | 国内模型 |

### 消息渠道 (Channel Plugins)
| 插件 | 说明 |
|------|------|
| `whatsapp` | WhatsApp Business API |
| `telegram` | Telegram Bot API |
| `discord` | Discord Bot |
| `slack` | Slack App |
| `signal` | Signal Messenger |
| `imessage` | iMessage (macOS) |
| `matrix` | Matrix 协议 |
| `msteams` | Microsoft Teams |
| `googlechat` | Google Chat |
| `irc`, `nostr`, `feishu`, `line`, `mattermost`, `zalo` | 其他渠道 |

### 能力插件 (Capability Plugins)
| 插件 | 说明 |
|------|------|
| `browser` | 浏览器自动化 (Playwright) |
| `elevenlabs` | ElevenLabs TTS |
| `firecrawl` | 网页爬取 |
| `tavily`, `brave`, `exa`, `searxng` | 搜索引擎 |
| `canvas` | 可视化画布 |
| `memory-core`, `memory-wiki`, `memory-lancedb` | 记忆系统 |
| `codex` | OpenAI Codex harness |
| `fal`, `runway`, `comfy` | 图像/视频生成 |

## 伴侣应用 (apps/)

| 应用 | 路径 | 说明 |
|------|------|------|
| macOS App | `apps/macos/` | 菜单栏控制、Voice Wake、WebChat |
| iOS Node | `apps/ios/` | 设备配对节点、语音转发、Canvas |
| Android Node | `apps/android/` | WS 节点、语音/相机/屏幕捕获 |
| Swabble | `apps/swabble/` | 内部工具 |

## 关键设计原则

1. **本地优先**：Gateway 运行在用户设备上，数据不经过第三方中转
2. **插件无关核心**：核心不硬编码任何特定提供商/渠道，通过 Plugin SDK 契约交互
3. **单用户模型**：默认信任 main session，非 main session 可启用沙箱隔离
4. **热重载**：配置变更无需重启，通过 diff + reload plan 增量应用
5. **流式优先**：agent 事件流式推送，支持实时预览和中断
6. **多 agent 路由**：不同渠道/账户可路由到隔离的 agent workspace

## 技术栈

- **语言**：TypeScript (ESM, strict)
- **运行时**：Node.js 24+ (兼容 22.16+)，Bun 兼容
- **包管理**：pnpm workspace
- **构建**：tsdown (基于 Rolldown)
- **测试**：Vitest
- **格式化**：oxfmt
- **Lint**：oxlint
- **类型检查**：tsgo
- **UI**：Vite + React (Control UI)
- **移动端**：SwiftUI (iOS/macOS), Kotlin (Android)
