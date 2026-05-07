import { Queue, Worker, ConnectionOptions } from 'bullmq'

/**
 * Redis 连接配置
 * BullMQ 5 使用 ConnectionOptions 类型
 */
function getRedisConnection(): ConnectionOptions {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const url = new URL(redisUrl)

  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  }
}

// Redis 连接实例（共享）
const redisConnection = getRedisConnection()

// ── 任务队列 ──────────────────────────────────────────────────────────────────

let _imageQueue: Queue | null = null
let _transferQueue: Queue | null = null

/**
 * 图片生成任务队列
 */
export function getImageQueue(): Queue {
  if (!_imageQueue) {
    _imageQueue = new Queue('image-queue', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // 1小时后清理
          count: 1000, // 最多保留1000条
        },
        removeOnFail: {
          age: 86400, // 失败记录保留1天
        },
      },
    })
  }
  return _imageQueue
}

/**
 * 资产转存任务队列
 */
export function getTransferQueue(): Queue {
  if (!_transferQueue) {
    _transferQueue = new Queue('transfer-queue', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          age: 3600,
          count: 500,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }
  return _transferQueue
}

// ── 导出连接配置（供 Worker 使用）──────────────────────────────────────────────

export { redisConnection }

// ── 任务类型定义 ──────────────────────────────────────────────────────────────

export interface ImageJobData {
  taskId: string
  batchId: string
  userId: string
  provider: string
  model: string
  prompt: string
  params: Record<string, unknown>
  creditAccountId: string
  estimatedCredits: number
}

export interface TransferJobData {
  assetId: string
  taskId: string
  originalUrl: string
  storageKey: string
  type: 'image' | 'video'
}