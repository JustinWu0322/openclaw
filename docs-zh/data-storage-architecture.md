# 数据存储架构

## 概述

OpenClaw的数据存储架构采用**混合存储策略**，根据数据类型和访问模式选择最合适的存储引擎。核心设计原则是**关注点分离**、**接口抽象**和**可靠性优先**。架构中没有统一的`src/storage/`或`src/persistence/`目录，而是按照功能领域分散在多个模块中。

### 设计目标

1. **数据一致性**：关键元数据支持ACID事务
2. **高性能访问**：运行时状态使用内存缓存
3. **可靠性优先**：强调事务安全和错误恢复
4. **渐进式增强**：从简单文件存储开始，根据需要引入SQLite
5. **安全隔离**：严格的文件权限和加密需求

## 存储模块架构

### 1. 会话存储 (Session Storage)

**目录路径**: `src/config/sessions/`

会话存储管理用户会话的持久化，基于JSON文件系统存储，每个会话一个独立文件。

#### 核心组件

- **store.ts**: 主存储接口，提供会话CRUD操作
- **store-load.ts**: 会话加载和反序列化
- **store-writer.ts**: 原子写入和并发控制
- **store-cache.ts**: 内存缓存提升读取性能
- **types.ts**: 会话数据模型定义

#### 数据模型

```typescript
// src/config/sessions/types.ts
export type SessionEntry = {
  sessionKey: string; // 会话唯一标识
  scope: SessionScope; // 会话范围（用户、设备、全局）
  channelId: SessionChannelId; // 通道标识
  origin: SessionOrigin; // 会话来源
  acpMeta?: SessionAcpMeta; // ACP元数据
  modelOverride?: string; // 模型覆盖配置
  deliveryContext?: DeliveryContext; // 交付上下文
  updatedAt: number; // 最后更新时间戳
  createdAt: number; // 创建时间戳
  lastActivityAt: number; // 最后活动时间
  // ... 更多字段
};
```

#### 存储策略

- **文件结构**: `~/.openclaw/sessions/<sessionKey>.json`
- **原子写入**: 临时文件+重命名模式确保写入原子性
- **内存缓存**: LRU缓存减少文件IO
- **磁盘预算**: 自动清理旧会话文件
- **并发控制**: 文件锁防止竞争条件

### 2. 插件状态存储 (Plugin State Storage)

**目录路径**: `src/plugin-state/`

插件状态存储使用SQLite数据库，为插件提供键值存储能力，支持TTL和命名空间隔离。

#### 核心组件

- **plugin-state-store.sqlite.ts**: SQLite存储实现
- **plugin-state-store.types.ts**: 类型定义和接口
- **plugin-state-store.paths.ts**: 路径解析

#### 数据库模式

```sql
-- 插件状态表结构
CREATE TABLE IF NOT EXISTS plugin_state_entries (
  plugin_id  TEXT    NOT NULL,     -- 插件ID
  namespace  TEXT    NOT NULL,     -- 命名空间
  entry_key  TEXT    NOT NULL,     -- 条目键
  value_json TEXT    NOT NULL,     -- JSON序列化值
  created_at INTEGER NOT NULL,     -- 创建时间戳
  expires_at INTEGER,              -- 过期时间戳（可选）
  PRIMARY KEY (plugin_id, namespace, entry_key)
);

-- 过期索引
CREATE INDEX idx_plugin_state_expiry
  ON plugin_state_entries(expires_at)
  WHERE expires_at IS NOT NULL;

-- 查询索引
CREATE INDEX idx_plugin_state_listing
  ON plugin_state_entries(plugin_id, namespace, created_at, entry_key);
```

#### 事务处理

```typescript
// 立即事务防止并发写冲突
function runWriteTransaction<T>(
  operation: PluginStateStoreOperation,
  write: (store: PluginStateDatabase) => T,
): T {
  const store = openPluginStateDatabase(operation);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = write(store);
    store.db.exec("COMMIT");
    return result;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
```

#### 特性

- **TTL支持**: 自动清理过期条目
- **命名空间隔离**: 插件间数据安全隔离
- **大小限制**: 每个插件最多1000个条目，每个值最大64KB
- **WAL模式**: Write-Ahead Logging提升并发性能
- **模式版本控制**: 使用`PRAGMA user_version`管理模式迁移

### 3. 密钥和认证存储 (Secrets and Authentication Storage)

**目录路径**: `src/secrets/`

密钥存储管理敏感数据如API密钥、OAuth令牌等，使用加密的JSON文件存储。

#### 核心组件

- **storage-scan.ts**: 存储扫描和验证
- **auth-store-paths.ts**: 认证存储路径管理
- **runtime.ts**: 运行时密钥管理

#### 存储结构

```
~/.openclaw/credentials/
├── providers/              # 提供商认证配置
│   ├── openai.json        # OpenAI密钥
│   ├── anthropic.json     # Anthropic密钥
│   └── ...
├── agents/                # Agent认证配置
│   └── <agentId>/
│       └── auth-profiles.json
└── channels/              # 通道认证配置
    └── <channelId>/
        └── credentials.json
```

#### 安全特性

- **文件权限**: 目录0700，文件0600
- **加密存储**: 敏感字段加密存储
- **内存安全**: 密钥在内存中加密存储
- **自动轮换**: 支持密钥自动轮换策略

### 4. 交付队列存储 (Delivery Queue Storage)

**目录路径**: `src/infra/outbound/`

交付队列存储使用文件系统队列实现消息的可靠投递，支持失败重试和恢复。

#### 核心组件

- **delivery-queue-storage.ts**: 队列存储实现
- **delivery-queue.ts**: 队列管理和操作
- **delivery-queue-recovery.ts**: 失败恢复机制

#### 队列结构

```typescript
export type QueuedDelivery = {
  id: string; // 队列条目ID
  enqueuedAt: number; // 入队时间
  retryCount: number; // 重试次数
  lastAttemptAt?: number; // 最后尝试时间
  lastError?: string; // 最后错误信息
  channel: Exclude<OutboundChannel, "none">; // 目标通道
  to: string; // 接收方标识
  payloads: ReplyPayload[]; // 消息负载
  // ... 更多字段
};
```

#### 存储操作

```typescript
// 使用@openclaw/fs-safe/store库的原子操作
import {
  writeJsonDurableQueueEntry,
  ackJsonDurableQueueEntry,
  moveJsonDurableQueueEntryToFailed,
  loadPendingJsonDurableQueueEntries,
} from "@openclaw/fs-safe/store";

// 写入队列条目
async function writeQueueEntry(filePath: string, entry: QueuedDelivery): Promise<void> {
  await writeJsonDurableQueueEntry({
    filePath,
    entry,
    tempPrefix: QUEUE_TEMP_PREFIX,
  });
}
```

#### 可靠性特性

- **原子操作**: 临时文件+重命名确保原子性
- **失败隔离**: 失败条目移动到单独目录
- **重试策略**: 指数退避重试机制
- **队列恢复**: 启动时恢复未完成投递

### 5. 任务注册表存储 (Task Registry Storage)

**目录路径**: `src/tasks/`

任务注册表存储使用SQLite数据库管理任务状态和交付历史。

#### 核心组件

- **task-registry.store.sqlite.ts**: SQLite存储实现
- **task-registry.store.ts**: 存储接口定义
- **task-flow-registry.store.sqlite.ts**: 任务流存储

#### 数据模型

```typescript
// src/tasks/task-registry.types.ts
export type TaskRecord = {
  taskId: string; // 任务唯一标识
  runtime: "immediate" | "cron" | "delayed"; // 运行时类型
  taskKind: string; // 任务种类
  sourceId?: string; // 源标识
  status: "pending" | "running" | "completed" | "failed" | "canceled"; // 状态
  deliveryStatus: "pending" | "sent" | "failed"; // 交付状态
  scheduledAt?: number; // 计划执行时间
  startedAt?: number; // 开始执行时间
  completedAt?: number; // 完成时间
  // ... 更多字段
};
```

#### 存储接口

```typescript
export type TaskRegistryStore = {
  loadSnapshot: () => TaskRegistryStoreSnapshot;
  saveSnapshot: (snapshot: TaskRegistryStoreSnapshot) => void;
  upsertTaskWithDeliveryState?: (params: {
    task: TaskRecord;
    deliveryState?: TaskDeliveryState;
  }) => void;
  deleteTask?: (taskId: string) => void;
  close?: () => void;
};
```

### 6. Cron作业存储 (Cron Job Storage)

**目录路径**: `src/cron/`

Cron存储管理定时作业配置和状态，使用JSON文件存储。

#### 核心组件

- **store.ts**: 存储实现
- **types.ts**: 类型定义

#### 存储格式

```json
{
  "jobs": [
    {
      "id": "daily-backup",
      "schedule": "0 2 * * *",
      "command": "backup --full",
      "lastRun": 1698765432,
      "nextRun": 1698851832,
      "enabled": true
    }
  ],
  "version": 1
}
```

### 7. 媒体文件存储 (Media File Storage)

**目录路径**: `src/media/`

媒体文件存储管理上传的图像、音频、视频等大文件。

#### 核心组件

- **store.ts**: 媒体文件存储接口

#### 存储策略

- **文件分片**: 大文件分片存储
- **元数据分离**: 文件元数据与内容分离
- **清理策略**: 基于时间和空间的自动清理
- **格式转换**: 按需格式转换和优化

### 8. 内存主机SDK存储 (Memory Host SDK Storage)

**目录路径**: `packages/memory-host-sdk/src/host/`

内存主机SDK提供SQLite和文件系统存储抽象，用于Agent记忆存储。

#### 核心组件

- **sqlite.ts**: SQLite封装和WAL维护
- **session-files.ts**: 会话文件管理
- **engine-storage.ts**: 存储引擎接口

#### 存储抽象

```typescript
export type MemoryStorageEngine = {
  // 记忆操作
  storeMemory: (memory: MemoryEntry) => Promise<void>;
  retrieveMemories: (query: MemoryQuery) => Promise<MemoryEntry[]>;

  // 会话管理
  createSession: (session: Session) => Promise<string>;
  getSession: (sessionId: string) => Promise<Session | null>;

  // 清理和维护
  cleanupExpired: () => Promise<number>;
  compact: () => Promise<void>;
};
```

## 存储引擎架构

### SQLite引擎

#### 核心实现

```typescript
// src/infra/node-sqlite.ts
export function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite");
  } catch (error) {
    throw new Error(
      `Failed to load node:sqlite. ` +
        `Ensure Node.js 22+ with SQLite support. ` +
        `Original error: ${error}`,
    );
  }
}
```

#### WAL配置

```typescript
// src/infra/sqlite-wal.js
export function configureSqliteWalMaintenance(
  db: DatabaseSync,
  dbPath: string,
): SqliteWalMaintenance {
  // 启用WAL模式
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  return {
    checkpoint: () => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"),
    // ... 更多维护操作
  };
}
```

### 文件系统引擎

#### 原子写入

```typescript
// src/infra/json-files.js
export async function writeTextAtomic(options: {
  filePath: string;
  content: string;
  tempPrefix?: string;
}): Promise<void> {
  const tempPath = `${options.filePath}.${options.tempPrefix || "tmp"}`;
  await fs.writeFile(tempPath, options.content, "utf-8");
  await fs.rename(tempPath, options.filePath);
}
```

#### 文件存储抽象

```typescript
// src/infra/file-store.ts
export type FileStore = {
  write: (options: FileStoreWriteOptions) => Promise<void>;
  read: (filePath: string) => Promise<Buffer>;
  prune: (options: FileStorePruneOptions) => Promise<void>;
  stat: (filePath: string) => Promise<FileStoreStat>;
};
```

## 数据一致性模式

### 1. 事务处理模式

#### SQLite事务

```typescript
function withTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
```

#### 文件系统事务

```typescript
async function withFileTransaction<T>(
  filePath: string,
  operation: (tempPath: string) => Promise<T>,
): Promise<T> {
  const tempPath = `${filePath}.tmp-${Date.now()}`;
  try {
    const result = await operation(tempPath);
    await fs.rename(tempPath, filePath);
    return result;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}
```

### 2. 并发控制模式

#### 文件锁机制

```typescript
// src/config/sessions/store-writer.js
export async function runExclusiveSessionStoreWrite(
  sessionKey: string,
  write: (entry: SessionEntry) => Promise<void>,
): Promise<void> {
  const lockPath = getSessionLockPath(sessionKey);
  const lock = await acquireFileLock(lockPath);
  try {
    await write(loadSession(sessionKey));
  } finally {
    await releaseFileLock(lock);
  }
}
```

#### 乐观并发控制

```typescript
function optimisticUpdate(key: string, update: (current: any) => any, retries = 3): boolean {
  for (let i = 0; i < retries; i++) {
    const current = loadValue(key);
    const updated = update(current);
    if (compareAndSwap(key, current, updated)) {
      return true;
    }
  }
  return false;
}
```

### 3. 错误恢复模式

#### 存储探针

```typescript
// src/plugin-state/plugin-state-store.sqlite.ts
export function probePluginStateStore(): PluginStateStoreProbeResult {
  const steps: PluginStateStoreProbeStep[] = [];

  // 1. 检查状态目录
  steps.push(checkDirectoryExists(resolvePluginStateDir()));

  // 2. 加载SQLite模块
  steps.push(checkSqliteModuleAvailable());

  // 3. 打开数据库
  steps.push(checkDatabaseOpen());

  // 4. 验证模式
  steps.push(checkSchemaVersion());

  // 5. 执行测试CRUD操作
  steps.push(testCrudOperations());

  // 6. 执行检查点
  steps.push(runCheckpoint());

  return { ok: steps.every((step) => step.ok), steps };
}
```

#### 损坏数据隔离

```typescript
function loadWithCorruptionHandling<T>(
  filePath: string,
  parser: (content: string) => T,
  defaultValue: T,
): T {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parser(content);
  } catch (error) {
    // 隔离损坏文件
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    fs.renameSync(filePath, corruptPath);

    // 记录错误
    logCorruption(filePath, error);

    return defaultValue;
  }
}
```

## 存储策略矩阵

| 数据类型     | 存储引擎          | 选择理由                             | 关键特性                     |
| ------------ | ----------------- | ------------------------------------ | ---------------------------- |
| **插件状态** | SQLite            | 需要TTL、命名空间隔离、复杂查询      | ACID事务、索引查询、WAL模式  |
| **会话数据** | 文件系统          | 大对象、独立文件便于备份迁移         | 原子写入、文件锁、内存缓存   |
| **任务队列** | SQLite + 文件队列 | 任务元数据用SQLite，大负载用文件队列 | 混合存储、重试机制、失败恢复 |
| **认证密钥** | 加密文件系统      | 安全隔离、简单加密需求               | 文件权限、字段加密、内存安全 |
| **媒体文件** | 文件系统          | 大文件存储、流式访问                 | 分片存储、格式转换、清理策略 |
| **Cron作业** | JSON文件          | 简单配置、人工可读                   | 原子更新、版本控制           |
| **交付队列** | 文件队列          | 高吞吐量、可靠投递                   | 原子操作、失败隔离、重试策略 |

## 性能优化策略

### 1. 缓存策略

#### 内存缓存

```typescript
// src/config/sessions/store-cache.ts
export class SessionStoreCache {
  private cache = new LRUCache<string, SessionEntry>({
    max: 1000, // 最大缓存条目
    ttl: 5 * 60 * 1000, // 5分钟TTL
  });

  get(sessionKey: string): SessionEntry | undefined {
    return this.cache.get(sessionKey);
  }

  set(sessionKey: string, entry: SessionEntry): void {
    this.cache.set(sessionKey, entry);
  }

  delete(sessionKey: string): void {
    this.cache.delete(sessionKey);
  }
}
```

#### 数据库连接池

```typescript
// SQLite连接单例缓存
let cachedDatabase: PluginStateDatabase | null = null;

function getOrCreateDatabase(): PluginStateDatabase {
  if (!cachedDatabase) {
    cachedDatabase = openPluginStateDatabase();
  }
  return cachedDatabase;
}
```

### 2. 批量操作

#### 批量插入

```typescript
function batchInsertEntries(db: DatabaseSync, entries: PluginStateEntry[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = db.prepare(`
      INSERT INTO plugin_state_entries 
      (plugin_id, namespace, entry_key, value_json, created_at, expires_at)
      VALUES (@plugin_id, @namespace, @entry_key, @value_json, @created_at, @expires_at)
    `);

    for (const entry of entries) {
      stmt.run({
        plugin_id: entry.pluginId,
        namespace: entry.namespace,
        entry_key: entry.key,
        value_json: JSON.stringify(entry.value),
        created_at: entry.createdAt,
        expires_at: entry.expiresAt,
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
```

### 3. 异步写入

#### 延迟写入队列

```typescript
// src/config/sessions/store-writer.js
export class SessionStoreWriter {
  private queue = new AsyncQueue<WriteTask>();
  private worker: Promise<void>;

  constructor() {
    this.worker = this.processQueue();
  }

  async write(sessionKey: string, entry: SessionEntry): Promise<void> {
    await this.queue.enqueue({ sessionKey, entry });
  }

  private async processQueue(): Promise<void> {
    while (true) {
      const task = await this.queue.dequeue();
      await this.performWrite(task);
    }
  }
}
```

## 安全设计

### 1. 文件权限控制

#### 目录和文件权限

```typescript
function ensureSecurePermissions(pathname: string, isDir: boolean): void {
  const mode = isDir ? 0o700 : 0o600; // 目录0700，文件0600
  chmodSync(pathname, mode);

  if (isDir) {
    // 确保父目录也有安全权限
    const parent = path.dirname(pathname);
    if (parent !== pathname) {
      ensureSecurePermissions(parent, true);
    }
  }
}
```

### 2. 数据加密

#### 字段级加密

```typescript
function encryptSensitiveField(value: string, keyId: string): string {
  const encryptionKey = getEncryptionKey(keyId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);

  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);

  const tag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: tag.toString("base64"),
    keyId,
  });
}
```

### 3. 内存安全

#### 安全缓冲区清理

```typescript
function withSecureBuffer<T>(sensitiveData: string, operation: (buffer: Buffer) => T): T {
  const buffer = Buffer.from(sensitiveData, "utf-8");
  try {
    return operation(buffer);
  } finally {
    // 清理内存中的敏感数据
    buffer.fill(0);
  }
}
```

## 测试策略

### 1. 单元测试

#### 存储模拟

```typescript
// 测试中的内存存储模拟
export function createMockPluginStateStore(): PluginStateKeyedStore {
  const store = new Map<string, PluginStateEntry>();

  return {
    register: (params) => {
      const key = `${params.pluginId}:${params.namespace}:${params.key}`;
      store.set(key, {
        key: params.key,
        value: params.value,
        createdAt: Date.now(),
        expiresAt: params.expiresAt,
      });
    },

    lookup: (params) => {
      const key = `${params.pluginId}:${params.namespace}:${params.key}`;
      return store.get(key)?.value;
    },

    // ... 更多方法
  };
}
```

### 2. 集成测试

#### 真实存储测试

```typescript
describe("PluginStateStore SQLite integration", () => {
  let tempDir: string;
  let store: PluginStateStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-state-test-"));
    process.env.OPENCLAW_PLUGIN_STATE_DIR = tempDir;
    store = createPluginStateStore();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("should persist entries across restarts", async () => {
    // 测试数据持久化
    await store.register({
      pluginId: "test-plugin",
      namespace: "test-ns",
      key: "test-key",
      value: { foo: "bar" },
    });

    // 模拟重启
    const newStore = createPluginStateStore();
    const value = await newStore.lookup({
      pluginId: "test-plugin",
      namespace: "test-ns",
      key: "test-key",
    });

    expect(value).toEqual({ foo: "bar" });
  });
});
```

### 3. 压力测试

#### 并发访问测试

```typescript
test("should handle concurrent writes", async () => {
  const promises = [];

  for (let i = 0; i < 100; i++) {
    promises.push(
      store.register({
        pluginId: "concurrent-plugin",
        namespace: "test-ns",
        key: `key-${i}`,
        value: { index: i },
      }),
    );
  }

  // 所有并发写入应该成功
  await Promise.all(promises);

  // 验证所有数据都存在
  for (let i = 0; i < 100; i++) {
    const value = await store.lookup({
      pluginId: "concurrent-plugin",
      namespace: "test-ns",
      key: `key-${i}`,
    });
    expect(value).toEqual({ index: i });
  }
});
```

## 监控和维护

### 1. 健康检查

#### 存储健康探针

```typescript
export async function checkStorageHealth(): Promise<HealthCheckResult> {
  const checks = [
    checkSessionStoreHealth(),
    checkPluginStateStoreHealth(),
    checkSecretsStoreHealth(),
    checkDeliveryQueueHealth(),
  ];

  const results = await Promise.allSettled(checks);

  return {
    healthy: results.every((r) => r.status === "fulfilled" && r.value.healthy),
    details: results.map((r) =>
      r.status === "fulfilled" ? r.value : { healthy: false, error: r.reason },
    ),
    timestamp: Date.now(),
  };
}
```

### 2. 指标收集

#### 存储指标

```typescript
export type StorageMetrics = {
  // 容量指标
  totalEntries: number;
  totalSizeBytes: number;
  freeSpaceBytes: number;

  // 性能指标
  readLatencyMs: number[];
  writeLatencyMs: number[];
  transactionRate: number;

  // 错误指标
  corruptionCount: number;
  writeErrors: number;
  recoveryAttempts: number;

  // 缓存指标
  cacheHitRate: number;
  cacheSize: number;
  cacheEvictions: number;
};
```

### 3. 自动维护

#### 定期清理

```typescript
export async function runStorageMaintenance(): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    startTime: Date.now(),
    operations: [],
    errors: [],
  };

  try {
    // 清理过期会话
    const sessionCleanup = await cleanupExpiredSessions();
    report.operations.push({
      type: "session_cleanup",
      count: sessionCleanup.deleted,
      duration: sessionCleanup.duration,
    });

    // 清理过期插件状态
    const pluginStateCleanup = await cleanupExpiredPluginState();
    report.operations.push({
      type: "plugin_state_cleanup",
      count: pluginStateCleanup.deleted,
      duration: pluginStateCleanup.duration,
    });

    // 执行SQLite检查点
    const checkpoint = await runSqliteCheckpoint();
    report.operations.push({
      type: "sqlite_checkpoint",
      walSizeBefore: checkpoint.walSizeBefore,
      walSizeAfter: checkpoint.walSizeAfter,
      duration: checkpoint.duration,
    });
  } catch (error) {
    report.errors.push({
      operation: "storage_maintenance",
      error: String(error),
      timestamp: Date.now(),
    });
  }

  report.endTime = Date.now();
  report.duration = report.endTime - report.startTime;

  return report;
}
```

## 未来扩展

### 1. 云存储集成

#### 抽象存储接口

```typescript
export type CloudStorageAdapter = {
  type: "s3" | "gcs" | "azure";

  upload: (key: string, data: Buffer, options?: UploadOptions) => Promise<void>;
  download: (key: string) => Promise<Buffer>;
  delete: (key: string) => Promise<void>;
  list: (prefix: string) => Promise<string[]>;

  // 高级功能
  multipartUpload?: (key: string, stream: Readable) => Promise<void>;
  presignedUrl?: (key: string, expiresIn: number) => Promise<string>;
};
```

### 2. 分布式存储

#### 分片策略

```typescript
export type StorageShardingStrategy = {
  getShard: (key: string) => string;

  // 分片管理
  addShard: (shardId: string, config: ShardConfig) => Promise<void>;
  removeShard: (shardId: string) => Promise<void>;
  rebalance: () => Promise<RebalanceReport>;

  // 一致性
  replicationFactor: number;
  consistencyLevel: "strong" | "eventual" | "causal";
};
```

### 3. 数据迁移工具

#### 版本化迁移

```typescript
export type StorageMigration = {
  version: number;
  description: string;

  up: (db: DatabaseSync) => Promise<void>;
  down: (db: DatabaseSync) => Promise<void>;

  // 验证
  validate: (db: DatabaseSync) => Promise<ValidationResult>;
  rollbackSafety: "safe" | "risky" | "destructive";
};
```

## 总结

OpenClaw的数据存储架构体现了**实用主义设计哲学**：

1. **混合存储策略**：根据数据特性选择最佳存储引擎
2. **渐进式增强**：从简单实现开始，按需引入复杂功能
3. **可靠性优先**：强调数据一致性和错误恢复
4. **安全隔离**：严格的数据隔离和访问控制
5. **可观测性**：全面的监控和健康检查

该架构平衡了性能、可靠性和开发效率，通过清晰的抽象层支持未来的存储引擎扩展，为OpenClaw的稳定运行提供了坚实的数据基础。

---

**相关文件路径**:

- `/Users/yiche/workspace/opensource/openclaw/src/config/sessions/` - 会话存储
- `/Users/yiche/workspace/opensource/openclaw/src/plugin-state/` - 插件状态存储
- `/Users/yiche/workspace/opensource/openclaw/src/secrets/` - 密钥存储
- `/Users/yiche/workspace/opensource/openclaw/src/infra/outbound/` - 交付队列存储
- `/Users/yiche/workspace/opensource/openclaw/src/tasks/` - 任务注册表存储
- `/Users/yiche/workspace/opensource/openclaw/src/cron/` - Cron作业存储
- `/Users/yiche/workspace/opensource/openclaw/src/infra/node-sqlite.ts` - SQLite引擎封装
- `/Users/yiche/workspace/opensource/openclaw/packages/memory-host-sdk/src/host/` - 内存主机SDK存储
