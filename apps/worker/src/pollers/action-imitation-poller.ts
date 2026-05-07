import pino_ from 'pino'
import { prisma } from '../lib/prisma.js'
import { getPubRedis, getRedis } from '../lib/redis.js'
import { Queue } from 'bullmq'
import { buildSignedRequest } from '../lib/volcengine-visual-sign.js'

const pino = pino_ as any
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

let _transferQueue: Queue | null = null
function getTransferQueue(): Queue {
  if (!_transferQueue) {
    _transferQueue = new Queue('transfer-queue', { connection: getRedis() })
  }
  return _transferQueue
}

const pollErrorCounts = new Map<string, number>()
const MAX_CONSECUTIVE_POLL_ERRORS = 5
const MAX_AGE_MS = 35 * 60 * 1000

const ACTION_REQ_KEY = 'jimeng_dreamactor_m20_gen_video'
const ACTION_API_VERSION = '2022-08-31'

interface ActionTaskRow {
  taskId: string
  batchId: string
  userId: string
  teamId: string
  creditAccountId: string
  estimatedCredits: number
  externalTaskId: string
  processingStartedAt: string | null
}

async function checkActionTask(externalTaskId: string): Promise<{
  status: 'SUCCESS' | 'FAILURE' | 'IN_PROGRESS' | 'POLL_ERROR'
  videoUrl?: string
  failReason?: string
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const { url, headers, body } = buildSignedRequest('CVSync2AsyncGetResult', ACTION_API_VERSION, {
      req_key: ACTION_REQ_KEY,
      task_id: externalTaskId,
    })
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    if (!res.ok) return { status: 'POLL_ERROR' }

    const json = (await res.json()) as {
      code: number
      data?: { status?: string; video_url?: string }
      message?: string
    }

    if (json.code !== 10000) {
      if ([50411, 50412, 50413, 50513].includes(json.code)) {
        return { status: 'FAILURE', failReason: `审核未通过 (${json.code}): ${json.message}` }
      }
      return { status: 'POLL_ERROR' }
    }

    const taskStatus = json.data?.status
    if (taskStatus === 'done') {
      if (json.data?.video_url) return { status: 'SUCCESS', videoUrl: json.data.video_url }
      return { status: 'FAILURE', failReason: 'Task done but no video_url returned' }
    }
    if (taskStatus === 'not_found' || taskStatus === 'expired') {
      return { status: 'FAILURE', failReason: `任务状态: ${taskStatus}` }
    }
    return { status: 'IN_PROGRESS' }
  } catch {
    return { status: 'POLL_ERROR' }
  } finally {
    clearTimeout(timer)
  }
}

async function handleActionSuccess(task: ActionTaskRow, videoUrl: string): Promise<void> {
  const { taskId, batchId, userId, creditAccountId, estimatedCredits } = task

  await prisma.$transaction(async (trx) => {
    const updated = await trx.task.updateMany({
      where: { id: taskId, status: { notIn: ['completed', 'failed'] } },
      data: { status: 'completed', credits_cost: estimatedCredits, completed_at: new Date() },
    })
    if (updated.count === 0) return

    await trx.asset.create({
      data: { task_id: taskId, batch_id: batchId, user_id: userId, type: 'video', original_url: videoUrl, transfer_status: 'pending' },
    })

    await trx.creditAccount.update({
      where: { id: creditAccountId },
      data: {
        frozen_credits: { decrement: estimatedCredits },
        total_spent: { increment: estimatedCredits },
        balance: { decrement: estimatedCredits },
      },
    })

    await trx.creditsLedger.create({
      data: {
        credit_account_id: creditAccountId, user_id: userId,
        amount: -estimatedCredits, type: 'confirm',
        task_id: taskId, batch_id: batchId,
        description: 'Action Imitation generation confirmed',
      },
    })

    await trx.taskBatch.update({
      where: { id: batchId },
      data: { status: 'completed', completed_count: { increment: 1 }, actual_credits: { increment: estimatedCredits } },
    })
  })

  await getPubRedis().publish(`sse:batch:${batchId}`, JSON.stringify({ event: 'batch_update' }))

  const assetRow = await prisma.asset.findFirst({ where: { task_id: taskId }, select: { id: true } })
  if (assetRow) {
    await getTransferQueue().add('transfer', { taskId, assetId: assetRow.id, originalUrl: videoUrl, assetType: 'video' })
  }

  logger.info({ taskId, batchId, videoUrl }, 'Action Imitation task completed')
}

async function handleActionFailure(task: ActionTaskRow, errorMessage: string): Promise<void> {
  const { taskId, batchId, userId, teamId, creditAccountId, estimatedCredits } = task

  await prisma.$transaction(async (trx) => {
    const updated = await trx.task.updateMany({
      where: { id: taskId, status: { notIn: ['completed', 'failed'] } },
      data: { status: 'failed', error_message: errorMessage.slice(0, 1000), completed_at: new Date() },
    })
    if (updated.count === 0) return

    await trx.creditAccount.update({
      where: { id: creditAccountId },
      data: { frozen_credits: { decrement: estimatedCredits } },
    })

    await trx.teamMember.updateMany({
      where: { team_id: teamId, user_id: userId },
      data: { credit_used: { decrement: estimatedCredits } },
    })

    await trx.creditsLedger.create({
      data: {
        credit_account_id: creditAccountId, user_id: userId,
        amount: estimatedCredits, type: 'refund',
        task_id: taskId, batch_id: batchId,
        description: `Action Imitation failed: ${errorMessage.slice(0, 200)}`,
      },
    })

    await trx.taskBatch.update({
      where: { id: batchId },
      data: { status: 'failed', failed_count: { increment: 1 } },
    })
  })

  await getPubRedis().publish(`sse:batch:${batchId}`, JSON.stringify({ event: 'batch_update' }))
  logger.warn({ taskId, batchId, errorMessage }, 'Action Imitation task failed')
}

async function pollActionTasks(): Promise<void> {
  const rows = await prisma.task.findMany({
    where: {
      status: 'processing',
      external_task_id: { not: null },
      batch: { module: 'action_imitation' },
    },
    select: {
      id: true,
      external_task_id: true,
      batch_id: true,
      estimated_credits: true,
      processing_started_at: true,
      batch: { select: { team_id: true, user_id: true, credit_account_id: true } },
    },
  })

  const tasks: ActionTaskRow[] = rows
    .filter((r) => r.batch?.team_id && r.batch?.credit_account_id)
    .map((r) => ({
      taskId: r.id,
      externalTaskId: r.external_task_id!,
      batchId: r.batch_id,
      estimatedCredits: r.estimated_credits,
      processingStartedAt: r.processing_started_at?.toISOString() ?? null,
      teamId: r.batch!.team_id!,
      userId: r.batch!.user_id,
      creditAccountId: r.batch!.credit_account_id!,
    }))

  if (tasks.length === 0) return
  logger.debug({ count: tasks.length }, 'Polling action imitation tasks')

  for (const task of tasks) {
    try {
      const ageMs = task.processingStartedAt
        ? Date.now() - new Date(task.processingStartedAt).getTime()
        : MAX_AGE_MS + 1

      if (ageMs > MAX_AGE_MS) {
        await handleActionFailure(task, '动作模仿生成超时（35分钟），请重新提交')
        continue
      }

      const result = await checkActionTask(task.externalTaskId)

      if (result.status === 'SUCCESS' && result.videoUrl) {
        pollErrorCounts.delete(task.taskId)
        await handleActionSuccess(task, result.videoUrl)
      } else if (result.status === 'FAILURE') {
        pollErrorCounts.delete(task.taskId)
        await handleActionFailure(task, result.failReason ?? '动作模仿生成失败')
      } else if (result.status === 'POLL_ERROR') {
        const count = (pollErrorCounts.get(task.taskId) ?? 0) + 1
        pollErrorCounts.set(task.taskId, count)
        if (count >= MAX_CONSECUTIVE_POLL_ERRORS) {
          pollErrorCounts.delete(task.taskId)
          await handleActionFailure(task, '生成过程中出现异常，请重新发起请求')
        }
      } else {
        pollErrorCounts.delete(task.taskId)
      }
    } catch (err) {
      logger.error({ taskId: task.taskId, err }, 'Error processing action imitation task')
    }
  }
}

export function startActionImitationPoller(): NodeJS.Timeout {
  const POLL_INTERVAL = 15_000

  setTimeout(() => {
    pollActionTasks().catch((err) => logger.error({ err }, 'Action imitation poller error'))
  }, 30_000)

  const timer = setInterval(() => {
    pollActionTasks().catch((err) => logger.error({ err }, 'Action imitation poller error'))
  }, POLL_INTERVAL)

  logger.info('Action imitation poller started (every 15 seconds)')
  return timer
}
