import { Queue } from 'bullmq'
import pino_ from 'pino'
import type { GenerationJobData } from '@aigc/types'
import { prisma } from '../lib/prisma.js'
import { failPipeline } from '../pipelines/fail.js'
import { getRedis } from '../lib/redis.js'

const pino = pino_ as any
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

let _imageQueue: Queue | null = null
function getImageQueue(): Queue {
  if (!_imageQueue) {
    _imageQueue = new Queue('image-queue', { connection: getRedis() })
  }
  return _imageQueue
}

const TIMEOUT_MS = 6 * 60 * 1000
const MAX_RETRIES = 0

export async function runTimeoutGuardian(): Promise<void> {
  const cutoff = new Date(Date.now() - TIMEOUT_MS)

  const stuckTasks = await prisma.task.findMany({
    where: {
      OR: [
        { status: 'pending', batch: { created_at: { lt: cutoff } } },
        { status: 'processing', processing_started_at: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      batch_id: true,
      user_id: true,
      retry_count: true,
      estimated_credits: true,
      queue_job_id: true,
      status: true,
      batch: {
        select: {
          provider: true,
          model: true,
          module: true,
          prompt: true,
          params: true,
          team_id: true,
          credit_account_id: true,
        },
      },
    },
  })

  if (stuckTasks.length === 0) return
  logger.info({ count: stuckTasks.length }, 'Found stuck tasks')

  for (const task of stuckTasks) {
    // 视频任务由 video-poller 管理，跳过
    if (task.batch?.module === 'video') {
      logger.debug({ taskId: task.id }, 'Skipping video task in timeout guardian (handled by video poller)')
      continue
    }

    if (!task.batch?.team_id || !task.batch?.credit_account_id) {
      logger.warn({ taskId: task.id }, 'Stuck task missing teamId or creditAccountId, marking failed')
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'failed', error_message: 'Missing team/credit context', completed_at: new Date() },
      })
      continue
    }

    const jobData: GenerationJobData = {
      taskId: task.id,
      batchId: task.batch_id,
      userId: task.user_id,
      teamId: task.batch.team_id,
      creditAccountId: task.batch.credit_account_id,
      provider: task.batch.provider,
      model: task.batch.model,
      prompt: task.batch.prompt,
      params: (typeof task.batch.params === 'string' ? JSON.parse(task.batch.params) : task.batch.params) as Record<string, unknown>,
      estimatedCredits: task.estimated_credits,
    }

    logger.warn({ taskId: task.id }, 'Task timed out, failing immediately (no retry)')
    try {
      await failPipeline(jobData, 'Task timed out')
    } catch (err) {
      logger.error({ taskId: task.id, error: err }, 'failPipeline threw during timeout handling — credits may be frozen')
    }
  }
}
