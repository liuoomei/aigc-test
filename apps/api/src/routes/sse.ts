import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { prisma } from '../lib/prisma.js'
import { signAssetUrl } from '../lib/storage.js'

type AssetRow = Awaited<ReturnType<typeof prisma.asset.findFirst>>

async function getBatchSnapshot(batchId: string) {
  const batch = await prisma.taskBatch.findFirst({
    where: { id: batchId },
  })

  if (!batch) return null

  const tasks = await prisma.task.findMany({
    where: { batch_id: batchId },
  })

  const assets = await prisma.asset.findMany({
    where: { batch_id: batchId },
  })

  const assetByTask = new Map<string, AssetRow>(
    assets.map((a) => [a.task_id, a] as [string, AssetRow])
  )

  return {
    id: batch.id,
    module: batch.module,
    provider: batch.provider,
    model: batch.model,
    prompt: batch.prompt,
    params: batch.params,
    quantity: batch.quantity,
    completed_count: batch.completed_count,
    failed_count: batch.failed_count,
    status: batch.status,
    estimated_credits: batch.estimated_credits,
    actual_credits: batch.actual_credits,
    created_at: batch.created_at instanceof Date ? batch.created_at.toISOString() : String(batch.created_at),
    tasks: await Promise.all(tasks.map(async (t) => {
      const asset = assetByTask.get(t.id)
      return {
        id: t.id,
        version_index: t.version_index,
        status: t.status,
        estimated_credits: t.estimated_credits,
        credits_cost: t.credits_cost,
        error_message: t.error_message,
        processing_started_at: t.processing_started_at instanceof Date ? t.processing_started_at.toISOString() : t.processing_started_at ?? null,
        completed_at: t.completed_at instanceof Date ? t.completed_at.toISOString() : t.completed_at ?? null,
        asset: asset
          ? {
              id: asset.id,
              type: asset.type,
              original_url: asset.original_url,
              storage_url: await signAssetUrl(asset.storage_url ?? ''),
              transfer_status: asset.transfer_status,
              file_size: asset.file_size,
              width: asset.width,
              height: asset.height,
            }
          : null,
      }
    })),
  }
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'partial_complete'
}

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/sse/batches/:id', async (request, reply) => {
    const { id: batchId } = request.params

    // 鉴权：验证用户有权访问该批次
    const batch = await prisma.taskBatch.findFirst({
      where: { id: batchId },
      select: { user_id: true, workspace_id: true },
    })

    if (!batch) {
      return reply.notFound('Batch not found')
    }

    if (batch.user_id !== request.user.id && request.user.role !== 'admin') {
      if (batch.workspace_id) {
        const wsMember = await prisma.workspaceMember.findFirst({
          where: { workspace_id: batch.workspace_id, user_id: request.user.id },
          select: { role: true },
        })
        if (!wsMember) {
          return reply.status(403).send({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Not authorized to view this batch' },
          })
        }
      } else {
        return reply.status(403).send({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Not authorized to view this batch' },
        })
      }
    }

    // 设置 SSE 响应头
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const sendEvent = (data: unknown) => {
      raw.write(`event: batch_update\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const sendPing = () => {
      raw.write(': ping\n\n')
    }

    // 发送初始快照
    const snapshot = await getBatchSnapshot(batchId)
    if (!snapshot) {
      raw.write(`event: error\ndata: ${JSON.stringify({ message: 'Batch not found' })}\n\n`)
      raw.end()
      return reply.hijack()
    }

    sendEvent(snapshot)

    // 已终态则直接关闭
    if (isTerminal(snapshot.status)) {
      raw.end()
      return reply.hijack()
    }

    // 订阅 Redis Pub/Sub
    const sub = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
    sub.on('error', () => {})
    const channel = `sse:batch:${batchId}`

    await sub.subscribe(channel)

    sub.on('message', async (_ch: string, _msg: string) => {
      try {
        const fresh = await getBatchSnapshot(batchId)
        if (fresh) {
          sendEvent(fresh)
          if (isTerminal(fresh.status)) {
            cleanup()
          }
        }
      } catch {
        // 忽略 SSE 期间的错误
      }
    })

    const heartbeat = setInterval(sendPing, 30_000)

    const cleanup = () => {
      clearInterval(heartbeat)
      sub.unsubscribe(channel).catch(() => {})
      sub.quit().catch(() => {})
      raw.end()
    }

    request.raw.on('close', cleanup)

    return reply.hijack()
  })
}
