import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '../../../.env') })
config({ path: path.resolve(__dirname, '../../../prompts.env'), override: false })

import { Worker } from 'bullmq'
import pino_ from 'pino'
import type { GenerationJobData } from '@aigc/types'
import { prisma, closePrisma } from './lib/prisma.js'
import { getAdapter } from './adapters/factory.js'
import { completePipeline } from './pipelines/complete.js'
import { failPipeline } from './pipelines/fail.js'
import { runTimeoutGuardian } from './jobs/timeout-guardian.js'
import { runPurgeOldRecords } from './jobs/purge-old-records.js'
import { runPurgeDeletedProjects } from './jobs/purge-deleted-projects.js'
import { transferWorker } from './workers/transfer.js'
import { getRedis, closeRedis } from './lib/redis.js'
import { startVideoPoller } from './pollers/video-poller.js'
import { startAvatarPoller } from './pollers/avatar-poller.js'
import { startActionImitationPoller } from './pollers/action-imitation-poller.js'

const pino = pino_ as any
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

// ─── Image Worker ────────────────────────────────────────────────────────────

const imageWorker = new Worker<GenerationJobData>(
  'image-queue',
  async (job) => {
    const data = job.data
    logger.info({ jobId: job.id, taskId: data.taskId }, 'Processing image job')

    // 标记任务为处理中
    await markTaskProcessing(data.taskId, job.id)

    try {
      const adapter = getAdapter(data.provider)
      const result = await adapter.generateImage({
        model: data.model,
        prompt: data.prompt,
        params: data.params,
      })

      if (result.success && result.outputUrl) {
        await completePipeline(data, result.outputUrl, data.estimatedCredits)
        logger.info({ jobId: job.id, taskId: data.taskId }, 'Image job completed')
      } else {
        await failPipeline(data, result.errorMessage ?? 'Unknown error')
        logger.warn({ jobId: job.id, taskId: data.taskId, error: result.errorMessage }, 'Image job failed')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await failPipeline(data, msg)
      logger.error({ jobId: job.id, taskId: data.taskId, err: msg }, 'Image job error')
    }
  },
  {
    connection: getRedis(),
    concurrency: 5,
  },
)

imageWorker.on('error', (err) => {
  logger.error({ err: err.message }, 'Image worker error')
})

// 标记任务为处理中
async function markTaskProcessing(taskId: string, jobId: string | undefined): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'processing',
      processing_started_at: new Date(),
      queue_job_id: jobId ?? null,
    },
  })
}

logger.info('Worker service started — listening on image-queue')
logger.info('Transfer worker started — listening on transfer-queue')

// ─── Timeout Guardian ──────────────────────────────────────────────────────────

const GUARDIAN_INTERVAL = 5 * 60 * 1000 // 5 minutes
// Delay first run by 1 minute to let workers warm up
setTimeout(() => {
  runTimeoutGuardian().catch((err) => logger.error({ err }, 'Timeout guardian error'))
}, 60_000)
const guardianTimer = setInterval(() => {
  runTimeoutGuardian().catch((err) => logger.error({ err }, 'Timeout guardian error'))
}, GUARDIAN_INTERVAL)

logger.info('Timeout guardian scheduled (every 5 minutes)')

// ─── Purge Old Records ────────────────────────────────────────────────────────

const PURGE_INTERVAL = 24 * 60 * 60 * 1000 // once a day
// Delay first run by 5 minutes
setTimeout(() => {
  runPurgeOldRecords().catch((err) => logger.error({ err }, 'Purge old records error'))
  runPurgeDeletedProjects().catch((err) => logger.error({ err }, 'Purge deleted projects error'))
}, 5 * 60 * 1000)
const purgeTimer = setInterval(() => {
  runPurgeOldRecords().catch((err) => logger.error({ err }, 'Purge old records error'))
  runPurgeDeletedProjects().catch((err) => logger.error({ err }, 'Purge deleted projects error'))
}, PURGE_INTERVAL)

// ─── Video Poller ─────────────────────────────────────────────────────────────

const videoPollerTimer = startVideoPoller()

// ─── Avatar Poller ────────────────────────────────────────────────────────────

const avatarPollerTimer = startAvatarPoller()

// ─── Action Imitation Poller ──────────────────────────────────────────────────

const actionImitationPollerTimer = startActionImitationPoller()

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

const shutdown = async () => {
  logger.info('Shutting down workers...')
  clearInterval(guardianTimer)
  clearInterval(purgeTimer)
  clearInterval(videoPollerTimer)
  clearInterval(avatarPollerTimer)
  clearInterval(actionImitationPollerTimer)
  await imageWorker.close()
  await transferWorker.close()
  await closeRedis()
  await closePrisma()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
