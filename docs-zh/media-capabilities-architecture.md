# 媒体能力架构

> 模块路径：`src/media/`、`src/media-understanding/`、`src/media-generation/`、`src/image-generation/`、`src/video-generation/`、`src/music-generation/`、`src/tts/`、`src/web-search/`、`src/web-fetch/`

## 概述

OpenClaw 的媒体能力模块采用插件化架构，提供图像、音频、视频、音乐等多媒体内容的处理、分析和生成能力。系统通过统一的 Provider 接口集成多种 AI 服务，支持媒体理解（转录、描述）、媒体生成（图像、视频、音乐、语音）和媒体处理（输入输出、格式转换）三大核心功能。

---

## 1. 核心媒体模块 (`src/media/`)

### 职责

基础媒体处理、文件输入输出、格式转换、大小限制管理和安全策略。

### 关键类型

#### 媒体类型定义

```typescript
type MediaKind = "image" | "audio" | "video" | "document";
```

#### 输入文件源

```typescript
type InputFileSource =
  | { type: "base64"; data: string; mediaType?: string; filename?: string }
  | { type: "url"; url: string; mediaType?: string; filename?: string };
```

#### 输入文件限制

```typescript
type InputFileLimits = {
  allowUrl: boolean;
  allowedMimes: Set<string>;
  maxBytes: number;
  maxChars: number;
  maxRedirects: number;
  timeoutMs: number;
  pdf: InputPdfLimits;
};
```

### 关键函数

| 函数                              | 说明                                             |
| --------------------------------- | ------------------------------------------------ |
| `extractFileContentFromSource()`  | 从 base64 或 URL 提取文件内容                    |
| `extractImageContentFromSource()` | 提取图像内容                                     |
| `fetchWithGuard()`                | 带防护的 HTTP 获取（大小限制、超时、重定向控制） |
| `resolveInputFileLimits()`        | 解析输入文件限制配置                             |
| `validateMediaSize()`             | 验证媒体文件大小                                 |

### 设计要点

- **多层防护**：URL 获取有大小限制、超时、最大重定向数限制
- **格式验证**：基于 MIME 类型的白名单验证
- **安全隔离**：网络请求在沙箱环境中执行
- **性能优化**：base64 大小估计避免完整解码

---

## 2. 媒体理解模块 (`src/media-understanding/`)

### 职责

音频转录、图像描述、视频描述、文件内容提取和结构化信息抽取。

### 核心接口

#### `MediaUnderstandingProvider` 接口

```typescript
type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
  describeImages?: (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
  extractStructured?: (req: StructuredExtractionRequest) => Promise<StructuredExtractionResult>;
};
```

#### 媒体理解输出

```typescript
type MediaUnderstandingOutput = {
  kind: MediaUnderstandingKind; // "audio.transcription" | "video.description" | "image.description"
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
};
```

#### 音频转录请求

```typescript
type AudioTranscriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  model?: string;
  language?: string;
  prompt?: string;
  query?: Record<string, string | number | boolean>;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};
```

### 关键函数

| 函数                        | 说明                                   |
| --------------------------- | -------------------------------------- |
| `applyMediaUnderstanding()` | 媒体理解主入口，协调各能力执行         |
| `runCapability()`           | 运行特定能力（图像、音频、视频）       |
| `buildProviderRegistry()`   | 构建提供者注册表，支持插件和配置提供者 |
| `runAttachmentEntries()`    | 运行附件条目处理，支持多提供者重试     |
| `resolveModelEntries()`     | 解析模型条目，处理配置继承和默认值     |

### 提供者注册表

#### 注册表构建流程

```
1. 从插件加载提供者 (`resolvePluginCapabilityProviders()`)
2. 从配置自动注册图像能力提供者 (`resolveImageCapableConfigProviderIds()`)
3. 合并重写提供者 (`overrides` 参数)
4. 返回 `Map<string, MediaUnderstandingProvider>`
```

#### 能力发现机制

- `provider-capability-registry.ts` 管理提供者能力矩阵
- 支持自动选择最佳提供者（基于优先级、可用性、成本）
- 提供者降级机制：高优先级提供者失败时自动尝试低优先级提供者

### 错误处理与重试

#### 错误分类

| 错误类型                      | 说明                         | 处理策略           |
| ----------------------------- | ---------------------------- | ------------------ |
| `MediaUnderstandingSkipError` | 可跳过的错误（如文件太小）   | 静默跳过，记录决策 |
| 提供者错误                    | 网络超时、API 限制、认证失败 | 重试其他提供者     |
| 配置错误                      | 缺少认证、无效参数           | 返回错误，不重试   |

#### 重试策略

1. 按提供者优先级顺序尝试
2. 每个附件独立重试，不影响其他附件
3. 记录所有尝试到 `MediaUnderstandingDecision`

#### 决策记录

```typescript
type MediaUnderstandingDecision = {
  capability: MediaUnderstandingCapability;
  outcome: MediaUnderstandingDecisionOutcome; // "success" | "failed" | "skipped" | "disabled"
  attachments: MediaUnderstandingAttachmentDecision[];
};
```

### 性能优化

#### 缓存机制

| 缓存类型                            | 存储位置 | 生命周期           |
| ----------------------------------- | -------- | ------------------ |
| 二进制缓存 (`binaryCache`)          | 内存     | 进程生命周期       |
| 提供者探测缓存 (`geminiProbeCache`) | 内存     | 短期，避免重复探测 |
| 附件缓存 (`MediaAttachmentCache`)   | 内存     | 会话生命周期       |

#### 并发控制

- `runWithConcurrency()` 函数控制并发任务数量
- 默认并发数：图像 2，音频 1，视频 1
- 可配置：`cfg.tools.media.concurrency`

#### 大小限制优化

- 音频文件：小于 1MB 跳过转录
- 图像文件：智能尺寸检查，避免处理超大图像
- Base64 大小估计，避免完整解码

---

## 3. 媒体生成模块 (`src/media-generation/`)

### 职责

媒体生成目录管理、模型引用解析和标准化。

### 核心类型

#### 媒体生成目录条目

```typescript
type MediaGenerationCatalogEntry<TCapabilities = unknown> =
  UnifiedModelCatalogEntry<TCapabilities> & {
    kind: MediaGenerationCatalogKind;
    source: MediaGenerationCatalogSource;
  };
```

### 关键函数

| 函数                                | 说明               |
| ----------------------------------- | ------------------ |
| `resolveMediaGenerationCatalog()`   | 解析媒体生成目录   |
| `normalizeMediaGenerationRequest()` | 标准化媒体生成请求 |

---

## 4. 图像生成模块 (`src/image-generation/`)

### 职责

AI 图像生成、图像编辑、风格转换和分辨率调整。

### 核心接口

#### `ImageGenerationProvider` 接口

```typescript
type ImageGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: ImageGenerationProviderCapabilities;
  isConfigured?: (ctx: ImageGenerationProviderConfiguredContext) => boolean;
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};
```

#### 图像生成请求

```typescript
type ImageGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  inputImages?: ImageGenerationSourceImage[];
  providerOptions?: ImageGenerationProviderOptions;
  ssrfPolicy?: SsrFPolicy;
};
```

### 提供者实现

#### OpenAI 兼容提供者 (`openai-compatible-image-provider.ts`)

- 支持 DALL-E 2/3、Stable Diffusion 等模型
- 统一的 API 格式适配
- 自动重试和错误处理

#### 内置提供者

| 提供者 ID   | 支持模型               | 能力               |
| ----------- | ---------------------- | ------------------ |
| `openai`    | `dall-e-2`, `dall-e-3` | 标准图像生成、编辑 |
| `stability` | `stable-diffusion-xl`  | 高分辨率生成       |
| `replicate` | 多种社区模型           | 自定义模型支持     |

---

## 5. 视频生成模块 (`src/video-generation/`)

### 职责

AI 视频生成、图像转视频、视频编辑和特效添加。

### 核心接口

#### `VideoGenerationProvider` 接口

```typescript
type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  resolveModelCapabilities?: (
    ctx: VideoGenerationModelCapabilitiesContext,
  ) =>
    | VideoGenerationProviderCapabilities
    | undefined
    | Promise<VideoGenerationProviderCapabilities | undefined>;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
```

### 提供者实现

#### DashScope 兼容提供者 (`dashscope-compatible.ts`)

- 支持阿里云通义千问视频生成
- 长视频生成支持
- 多参数控制（帧率、分辨率、时长）

---

## 6. 音乐生成模块 (`src/music-generation/`)

### 职责

AI 音乐生成、歌词生成、音乐编辑和风格转换。

### 核心接口

#### `MusicGenerationProvider` 接口

```typescript
type MusicGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: MusicGenerationProviderCapabilities;
  isConfigured?: (ctx: MusicGenerationProviderConfiguredContext) => boolean;
  generateMusic: (req: MusicGenerationRequest) => Promise<MusicGenerationResult>;
};
```

### 音乐生成能力

| 能力      | 说明         |
| --------- | ------------ |
| `melody`  | 旋律生成     |
| `harmony` | 和声生成     |
| `rhythm`  | 节奏生成     |
| `lyrics`  | 歌词生成     |
| `full`    | 完整音乐生成 |

---

## 7. 文本转语音模块 (`src/tts/`)

### 职责

文本转语音、语音合成、语音配置管理和音色选择。

### 核心接口

#### 解析后的 TTS 配置

```typescript
type ResolvedTtsConfig = {
  auto: TtsAutoMode;
  mode: TtsMode;
  provider: TtsProvider;
  providerSource: "config" | "default";
  persona?: string;
  personas: Record<string, ResolvedTtsPersona>;
  summaryModel?: string;
  modelOverrides: ResolvedTtsModelOverrides;
  providerConfigs: Record<string, SpeechProviderConfig>;
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
  rawConfig?: TtsConfig;
  sourceConfig?: OpenClawConfig;
};
```

#### TTS 提供者接口

```typescript
type SpeechProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  voices?: SpeechVoice[];
  capabilities: SpeechProviderCapabilities;
  isConfigured?: (ctx: SpeechProviderConfiguredContext) => boolean;
  synthesizeSpeech: (req: SpeechSynthesisRequest) => Promise<SpeechSynthesisResult>;
};
```

### 提供者实现

#### OpenAI 兼容语音提供者 (`openai-compatible-speech-provider.ts`)

- 支持 TTS-1、TTS-1-HD 模型
- 多语言支持
- 语音风格控制（自然、兴奋、平静等）

#### 内置提供者

| 提供者 ID    | 支持模型              | 语音风格   | 最大文本长度 |
| ------------ | --------------------- | ---------- | ------------ |
| `openai`     | `tts-1`, `tts-1-hd`   | 6 种风格   | 4096 字符    |
| `elevenlabs` | 多种语音模型          | 30+ 种语音 | 5000 字符    |
| `google`     | `standard`, `wavenet` | 多语言     | 5000 字符    |

---

## 8. 网络搜索模块 (`src/web-search/`)

### 职责

网络搜索、搜索结果处理和摘要生成。

### 核心接口

#### 网络搜索运行参数

```typescript
type RunWebSearchParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
  args: Record<string, unknown>;
  signal?: AbortSignal;
};
```

### 搜索提供者

| 提供者类型   | 说明                               |
| ------------ | ---------------------------------- |
| 运行时提供者 | 通过插件系统动态加载的搜索提供者   |
| 配置提供者   | 在配置文件中定义的静态提供者       |
| 默认提供者   | 系统内置的 DuckDuckGo、Google 搜索 |

---

## 9. 网络抓取模块 (`src/web-fetch/`)

### 职责

网页抓取、内容提取和结构化信息抽取。

### 核心功能

#### 内容提取器 (`content-extractors.runtime.ts`)

- HTML 解析和清理
- 主要内容提取（去除广告、导航等）
- 结构化数据提取（文章标题、作者、发布时间）
- 图片和链接提取

#### 抓取策略

| 策略       | 说明                                     |
| ---------- | ---------------------------------------- |
| 智能提取   | 自动识别页面主要内容区域                 |
| 全文提取   | 提取所有文本内容                         |
| 结构化提取 | 提取特定结构化数据（产品信息、新闻文章） |

---

## 10. 媒体处理管道架构

### 三层处理模型

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│     输入层       │    │     处理层       │    │     输出层       │
│ • base64 解码   │───▶│ • 格式转换       │───▶│ • 标准化格式     │
│ • URL 获取      │    │ • 内容提取       │    │ • 缓存存储       │
│ • 本地文件读取   │    │ • 质量调整       │    │ • 结果返回       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### 管道执行流程

1. **输入验证**：验证输入源、MIME 类型、大小限制
2. **内容提取**：根据媒体类型调用相应提取器
3. **格式转换**：转换为标准内部格式（如音频转 WAV）
4. **能力应用**：调用相应媒体能力（理解/生成）
5. **结果处理**：标准化输出格式、缓存结果、返回给调用方

### 错误处理管道

```
输入错误 → 格式错误 → 提供者错误 → 结果错误
    │          │          │          │
    ▼          ▼          ▼          ▼
跳过/重试   转换替代   提供者降级   部分成功
```

---

## 11. Provider 系统架构

### 统一接口模式

所有媒体能力都通过统一的 Provider 接口实现：

| 能力类型   | Provider 接口                | 关键方法                                            |
| ---------- | ---------------------------- | --------------------------------------------------- |
| 媒体理解   | `MediaUnderstandingProvider` | `transcribeAudio`, `describeImage`, `describeVideo` |
| 图像生成   | `ImageGenerationProvider`    | `generateImage`                                     |
| 视频生成   | `VideoGenerationProvider`    | `generateVideo`                                     |
| 音乐生成   | `MusicGenerationProvider`    | `generateMusic`                                     |
| 文本转语音 | `SpeechProvider`             | `synthesizeSpeech`                                  |

### 插件化注册机制

#### 注册表构建

```typescript
// 1. 从插件加载
const pluginProviders = resolvePluginCapabilityProviders({
  key: "mediaUnderstandingProviders",
  cfg,
});

// 2. 从配置自动注册
const configProviders = resolveImageCapableConfigProviderIds(cfg);

// 3. 合并重写
const finalRegistry = mergeProviders(pluginProviders, configProviders, overrides);
```

#### 提供者发现

1. 扫描插件目录的 `providers/` 子目录
2. 读取配置文件的 `models.providers` 部分
3. 加载动态模块（`import()`）并检查导出接口
4. 验证提供者实现（必需方法、配置检查）

### 能力降级机制

#### 优先级顺序

1. 显式配置的提供者
2. 插件提供的提供者
3. 配置自动发现的提供者
4. 默认内置提供者

#### 降级策略

- 高优先级提供者失败时自动尝试下一优先级
- 记录降级决策到 `MediaUnderstandingDecision`
- 同一会话中缓存提供者可用性，避免重复失败

---

## 12. 配置管理系统

### 分层配置结构

```
全局配置 (OpenClawConfig)
    ├── tools.media.* (媒体工具配置)
    ├── models.providers.* (提供者配置)
    └── agents.* (Agent 特定配置)
```

### 配置解析流程

#### 媒体理解配置

```typescript
type MediaUnderstandingConfig = {
  enabled: boolean;
  image?: MediaUnderstandingImageConfig;
  audio?: MediaUnderstandingAudioConfig;
  video?: MediaUnderstandingVideoConfig;
  concurrency: number;
  fallback: boolean;
  cache: MediaUnderstandingCacheConfig;
};
```

#### 提供者配置

```typescript
type MediaProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
  enabled?: boolean;
  priority?: number;
};
```

### 动态配置更新

#### 热重载支持

- 配置文件变更时自动重新加载提供者配置
- 运行时 Provider 注册表更新
- Agent 级配置覆盖（每个 Agent 可自定义媒体配置）

#### 配置继承

1. 全局默认值
2. Agent 配置覆盖
3. 会话级临时配置
4. 运行时参数（最高优先级）

---

## 13. 性能优化策略

### 缓存机制

#### 多级缓存设计

| 缓存级别 | 存储位置 | 缓存内容                 | 失效策略       |
| -------- | -------- | ------------------------ | -------------- |
| 内存缓存 | 进程内存 | 提供者实例、配置解析结果 | 配置变更时失效 |
| 磁盘缓存 | 临时目录 | 媒体文件处理结果         | 会话结束时清理 |
| 网络缓存 | CDN/代理 | 远程媒体内容             | TTL 控制       |

#### 缓存键设计

- 基于内容哈希：`sha256(file_content + processing_params)`
- 基于配置指纹：`hash(provider_config + model_selection)`
- 会话感知：包含 `sessionId` 避免跨会话污染

### 并发控制

#### 资源感知调度

| 资源类型   | 并发限制      | 限制依据             |
| ---------- | ------------- | -------------------- |
| CPU 密集型 | 低并发（1-2） | 图像生成、视频编码   |
| I/O 密集型 | 中并发（3-5） | 网络请求、文件读取   |
| 内存密集型 | 严格控制      | 大文件处理、模型加载 |

#### 队列管理

- 优先级队列：用户交互任务优先于后台任务
- 公平调度：避免单个任务独占资源
- 超时控制：长时间任务自动取消

### 懒加载优化

#### 提供者懒加载

- 提供者类在首次使用时动态导入
- 配置解析延迟到实际需要时
- 模型文件按需下载

#### 资源预加载

- 高频提供者预热
- 常用模型预加载到内存
- 配置缓存预构建

---

## 14. 安全与隐私保护

### 输入验证

#### 媒体文件验证

- MIME 类型白名单验证
- 文件大小限制（防止内存耗尽）
- 内容安全检查（病毒扫描、恶意代码检测）

#### URL 安全策略

- 禁止私有 IP 地址访问
- 限制重定向次数
- 超时控制（防止慢速攻击）

### 数据传输安全

#### 加密传输

- 所有 API 请求使用 HTTPS
- 敏感配置加密存储
- 临时文件加密存储

#### 认证管理

- API Key 安全存储（密钥环、环境变量）
- 短期令牌自动刷新
- 认证失败自动重试（有限次数）

### 隐私保护

#### 数据匿名化

- 用户标识信息脱敏
- 媒体内容元数据清理
- 日志记录隐私过滤

#### 临时文件清理

- 处理完成后自动删除临时文件
- 会话结束时清理所有关联文件
- 定期清理过期缓存

---

## 15. 监控与调试

### 指标收集

#### 性能指标

| 指标名称                    | 类型   | 说明             |
| --------------------------- | ------ | ---------------- |
| `media_processing_duration` | 直方图 | 媒体处理耗时分布 |
| `provider_success_rate`     | 百分比 | 提供者调用成功率 |
| `cache_hit_rate`            | 百分比 | 缓存命中率       |
| `concurrent_tasks`          | 计数器 | 并发任务数       |

#### 业务指标

| 指标名称               | 类型   | 说明                 |
| ---------------------- | ------ | -------------------- |
| `media_kind_processed` | 计数器 | 按媒体类型统计处理量 |
| `provider_usage`       | 计数器 | 提供者使用次数       |
| `error_by_category`    | 计数器 | 按错误类别统计       |

### 日志系统

#### 结构化日志

```typescript
type MediaProcessingLog = {
  timestamp: string;
  sessionId: string;
  mediaKind: MediaKind;
  provider: string;
  model?: string;
  duration: number;
  success: boolean;
  error?: string;
  cacheHit: boolean;
  fileSize?: number;
};
```

#### 调试日志级别

| 级别  | 记录内容               | 使用场景 |
| ----- | ---------------------- | -------- |
| ERROR | 错误详情、堆栈跟踪     | 问题诊断 |
| WARN  | 降级决策、性能警告     | 运维监控 |
| INFO  | 处理摘要、关键决策     | 日常监控 |
| DEBUG | 详细处理步骤、中间状态 | 开发调试 |

### 追踪系统

#### 分布式追踪

- 请求级追踪：从输入到输出的完整处理链路
- 跨组件追踪：媒体模块与其他模块的交互
- 异步任务追踪：并发任务的执行关系

#### 追踪标识

- `traceId`: 全局唯一请求标识
- `spanId`: 单个处理步骤标识
- `parentSpanId`: 父步骤标识（构建调用树）

---

## 跨模块关系

```
                    ┌─────────────────────┐
                    │    媒体能力入口        │
                    │  (applyMediaUnderstanding) │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    能力协调器         │
                    │  (runCapability)    │
                    └──────────┬──────────┘
             ┌─────────────────┼─────────────────┐
    ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼──────┐
    │   图像理解       │ │   音频理解    │ │   视频理解    │
    │  (describeImage)│ │(transcribeAudio)│ │(describeVideo)│
    └────────┬────────┘ └──────┬──────┘ └───────┬──────┘
             │                  │                 │
    ┌────────▼─────────────────────────────────────▼──────┐
    │             提供者系统 (Provider Registry)           │
    │  • 统一接口适配                                      │
    │  • 插件化注册                                        │
    │  • 自动发现和降级                                    │
    └─────────────────────────────────────────────────────┘
             │                  │                 │
    ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼──────┐
    │   图像生成       │ │   音频生成    │ │   视频生成    │
    │ (generateImage) │ │(generateMusic)│ │(generateVideo)│
    └─────────────────┘ └──────────────┘ └──────────────┘
             │                  │                 │
    ┌────────▼─────────────────────────────────────▼──────┐
    │             媒体处理管道 (Media Pipeline)           │
    │  • 输入验证                                        │
    │  • 格式转换                                        │
    │  • 结果标准化                                      │
    └─────────────────────────────────────────────────────┘
```

## 设计模式总结

1. **插件化架构**：通过统一的 Provider 接口支持多种 AI 服务集成
2. **分层处理**：输入层、处理层、输出层清晰分离，每层可独立扩展
3. **降级机制**：多提供者优先级和自动降级，保证服务可用性
4. **配置驱动**：分层配置系统支持多环境、多租户部署
5. **性能优化**：多级缓存、并发控制、懒加载综合优化
6. **安全防护**：输入验证、传输加密、隐私保护全方位安全
7. **可观测性**：指标、日志、追踪三位一体的监控体系

该架构为 OpenClaw 提供了强大、灵活、可靠的媒体处理能力，支持从简单的图像描述到复杂的视频生成等多种应用场景。
