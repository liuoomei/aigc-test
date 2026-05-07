import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { signAssetUrl, signAssetUrls, encryptProxyUrl } from '../lib/storage.js'

export async function batchRoutes(app: FastifyInstance): Promise<void> {
  // GET /batches/:id — batch detail with tasks + assets
  app.get<{ Params: { id: string } }>('/batches/:id', async (request, reply) => {
    const { id } = request.params

    const batch = await prisma.taskBatch.findFirst({
      where: { id, is_deleted: false },
    })

    if (!batch) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: '生成记录未找到' },
      })
    }

    // Authorization: user must own the batch, be a workspace member, or be admin
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

    const tasks = await prisma.task.findMany({
      where: { batch_id: id },
      orderBy: { version_index: 'asc' },
    })

    const assets = await prisma.asset.findMany({
      where: { batch_id: id, is_deleted: false },
    })

    const assetByTask: Map<string, any> = new Map(assets.map((a: any) => [a.task_id, a]))

    // Sign asset URLs
    for (const asset of assets) {
      if ((asset as any).storage_url) {
        (asset as any).storage_url = await signAssetUrl((asset as any).storage_url)
      }
    }

    // Fetch batch creator info
    const creator = await prisma.user.findUnique({
      where: { id: batch.user_id },
      select: { id: true, username: true, avatar_url: true },
    })

    let queuePosition: number | null = null
    if (batch.status === 'pending') {
      const count = await prisma.taskBatch.count({
        where: {
          is_deleted: false,
          status: 'pending',
          provider: batch.provider,
          created_at: { lt: batch.created_at },
        },
      })
      queuePosition = count
    }

    return reply.send({
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
      created_at: batch.created_at.toISOString?.() ?? String(batch.created_at),
      queue_position: queuePosition,
      user: creator ? { id: creator.id, username: creator.username, avatar_url: creator.avatar_url ?? null } : undefined,
      tasks: await Promise.all(tasks.map(async (t: any) => {
        const asset = assetByTask.get(t.id)
        return {
          id: t.id,
          version_index: t.version_index,
          status: t.status,
          estimated_credits: t.estimated_credits,
          credits_cost: t.credits_cost,
          error_message: t.error_message,
          processing_started_at: t.processing_started_at?.toISOString?.() ?? t.processing_started_at ?? null,
          completed_at: t.completed_at?.toISOString?.() ?? t.completed_at ?? null,
          asset: asset
            ? {
                id: asset.id,
                type: asset.type,
                original_url: await signAssetUrl(asset.original_url),
                storage_url: await signAssetUrl(asset.storage_url),
                raw_storage_url: asset.storage_url ?? asset.original_url ?? null,
                transfer_status: asset.transfer_status,
                file_size: asset.file_size,
                width: asset.width,
                height: asset.height,
              }
            : null,
        }
      })),
    })
  })

  // GET /batches — list with cursor pagination
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/batches',
    async (request, reply) => {
      const userId = request.user.id

      const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100)
      const cursor = request.query.cursor

      let decodedCursor: { created_at: string; id: string } | null = null
      if (cursor) {
        try {
          decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'))
        } catch {
          return reply.badRequest('Invalid cursor')
        }
      }

      // Optional workspace filter
      const workspaceId = (request.query as any).workspace_id
      if (workspaceId) {
        // If workspace_id provided, verify membership then show ALL batches in that workspace
        if (request.user.role !== 'admin') {
          const wsMember = await prisma.workspaceMember.findFirst({
            where: { workspace_id: workspaceId, user_id: userId },
            select: { role: true },
          })
          if (!wsMember) {
            return reply.status(403).send({
              success: false,
              error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' },
            })
          }
        }
      }

      // Build where clause conditions
      const whereConditions: Prisma.TaskBatchWhereInput = {
        is_deleted: false,
        is_hidden: false,
        canvas_id: null,
        video_studio_project_id: null,
      }

      if (workspaceId) {
        whereConditions.workspace_id = workspaceId
      } else {
        // No workspace filter — admin sees all, normal users see only their own
        if (request.user.role !== 'admin') {
          whereConditions.user_id = userId
        }
      }

      if (decodedCursor) {
        whereConditions.AND = [
          {
            OR: [
              { created_at: { lt: new Date(decodedCursor.created_at) } },
              {
                AND: [
                  { created_at: { equals: new Date(decodedCursor.created_at) } },
                  { id: { lt: decodedCursor.id } },
                ],
              },
            ],
          },
        ]
      }

      const rows = await prisma.taskBatch.findMany({
        where: whereConditions,
        select: {
          id: true,
          module: true,
          provider: true,
          model: true,
          prompt: true,
          params: true,
          quantity: true,
          completed_count: true,
          failed_count: true,
          status: true,
          estimated_credits: true,
          actual_credits: true,
          created_at: true,
          user_id: true,
          workspace_id: true,
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1, // fetch one extra to determine if there's a next page
      })

      const hasMore = rows.length > limit
      const batches = hasMore ? rows.slice(0, limit) : rows

      // Fetch thumbnail URLs for all batches — sign in parallel to avoid sequential await bottleneck
      const batchIds = batches.map((b) => b.id)
      const thumbnailMap = new Map<string, string[]>()
      if (batchIds.length > 0) {
        const assets = await prisma.asset.findMany({
          where: { batch_id: { in: batchIds }, is_deleted: false },
          select: { batch_id: true, storage_url: true, original_url: true, type: true },
        })

        const signed = await Promise.all(assets.map(async (a) => {
          const rawUrl: string | null = (a as any).storage_url ?? (a as any).original_url
          if (!rawUrl) return null
          const isVideo = (a as any).type === 'video'
          let thumbnailUrl: string
          if (rawUrl.startsWith('http://')) {
            // Encrypt URL to hide storage server IP from browser network tab
            const token = encryptProxyUrl(rawUrl)
            thumbnailUrl = `/api/v1/assets/proxy?token=${token}${isVideo ? '' : '&w=128'}`
          } else {
            const s = await signAssetUrl(rawUrl)
            if (!s) return null
            thumbnailUrl = s
          }
          return { batchId: (a as any).batch_id as string, thumbnailUrl }
        }))

        for (const entry of signed) {
          if (!entry) continue
          const list = thumbnailMap.get(entry.batchId) ?? []
          list.push(entry.thumbnailUrl)
          thumbnailMap.set(entry.batchId, list)
        }
      }

      // Fetch user info for all batch creators in one query
      const userIds = [...new Set(batches.map((b: any) => b.user_id))]
      const userMap = new Map<string, { id: string; username: string; avatar_url: string | null }>()
      if (userIds.length > 0) {
        const users = await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, avatar_url: true },
        })
        for (const u of users) {
          userMap.set(u.id, { id: u.id, username: u.username, avatar_url: (u as any).avatar_url ?? null })
        }
      }

      // Fetch one representative error_message per failed/partial_complete batch
      const failedBatchIds = batches
        .filter((b: any) => b.status === 'failed' || b.status === 'partial_complete')
        .map((b: any) => b.id)
      const errorMap = new Map<string, string>()
      if (failedBatchIds.length > 0) {
        const errorRows = await prisma.task.findMany({
          where: { batch_id: { in: failedBatchIds }, status: 'failed', error_message: { not: null } },
          select: { batch_id: true, error_message: true },
        })
        for (const row of errorRows) {
          if (!errorMap.has(row.batch_id)) {
            errorMap.set(row.batch_id, row.error_message!)
          }
        }
      }

      const nextCursor = hasMore && batches.length > 0
        ? Buffer.from(
            JSON.stringify({
              created_at: batches[batches.length - 1].created_at.toISOString?.() ?? String(batches[batches.length - 1].created_at),
              id: batches[batches.length - 1].id,
            }),
          ).toString('base64')
        : null

      return reply.send({
        data: batches.map((b: any) => ({
          id: b.id,
          module: b.module,
          provider: b.provider,
          model: b.model,
          prompt: b.prompt,
          params: b.params ?? {},
          quantity: b.quantity,
          completed_count: b.completed_count,
          failed_count: b.failed_count,
          status: b.status,
          estimated_credits: b.estimated_credits,
          actual_credits: b.actual_credits,
          created_at: b.created_at.toISOString?.() ?? String(b.created_at),
          tasks: [],
          thumbnail_urls: thumbnailMap.get(b.id) ?? [],
          error_message: errorMap.get(b.id) ?? null,
          user: userMap.get(b.user_id) ?? undefined,
        })),
        cursor: nextCursor,
      })
    },
  )

  // Helper: build the batch list query (shared by GET /batches and GET /batches/hidden)
  function buildBatchListQuery(isHidden: boolean) {
    return {
      where: {
        is_deleted: false,
        is_hidden: isHidden,
        canvas_id: null,
        video_studio_project_id: null,
      },
      select: {
        id: true,
        module: true,
        provider: true,
        model: true,
        prompt: true,
        params: true,
        quantity: true,
        completed_count: true,
        failed_count: true,
        status: true,
        estimated_credits: true,
        actual_credits: true,
        created_at: true,
        user_id: true,
        workspace_id: true,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    }
  }

  // PATCH /batches/:id/hide — hide a batch from history
  app.patch<{ Params: { id: string } }>('/batches/:id/hide', async (request, reply) => {
    const { id } = request.params
    const userId = request.user.id

    const batch = await prisma.taskBatch.findFirst({
      where: { id, is_deleted: false },
      select: { id: true, user_id: true, workspace_id: true },
    })

    if (!batch) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '记录未找到' } })

    if (batch.user_id !== userId && request.user.role !== 'admin') {
      if (batch.workspace_id) {
        const wsMember = await prisma.workspaceMember.findFirst({
          where: { workspace_id: batch.workspace_id, user_id: userId },
          select: { role: true },
        })
        if (!wsMember) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorized' } })
      } else {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorized' } })
      }
    }

    await prisma.taskBatch.update({
      where: { id },
      data: { is_hidden: true },
    })
    return { success: true }
  })

  // PATCH /batches/:id/unhide — restore a hidden batch
  app.patch<{ Params: { id: string } }>('/batches/:id/unhide', async (request, reply) => {
    const { id } = request.params
    const userId = request.user.id

    const batch = await prisma.taskBatch.findFirst({
      where: { id, is_deleted: false, is_hidden: true },
      select: { id: true, user_id: true, workspace_id: true },
    })

    if (!batch) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '记录未找到' } })

    if (batch.user_id !== userId && request.user.role !== 'admin') {
      if (batch.workspace_id) {
        const wsMember = await prisma.workspaceMember.findFirst({
          where: { workspace_id: batch.workspace_id, user_id: userId },
          select: { role: true },
        })
        if (!wsMember) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorized' } })
      } else {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorized' } })
      }
    }

    await prisma.taskBatch.update({
      where: { id },
      data: { is_hidden: false },
    })
    return { success: true }
  })

  // GET /batches/hidden — list hidden batches (same pagination as GET /batches)
  app.get<{ Querystring: { workspace_id?: string; cursor?: string; limit?: string } }>(
    '/batches/hidden',
    async (request, reply) => {
      const userId = request.user.id
      const limit = Math.min(parseInt(request.query.limit ?? '10', 10) || 10, 50)
      const cursor = request.query.cursor

      let decodedCursor: { created_at: string; id: string } | null = null
      if (cursor) {
        try {
          decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'))
        } catch {
          return reply.badRequest('Invalid cursor')
        }
      }

      const workspaceId = request.query.workspace_id
      if (workspaceId) {
        if (request.user.role !== 'admin') {
          const wsMember = await prisma.workspaceMember.findFirst({
            where: { workspace_id: workspaceId, user_id: userId },
            select: { role: true },
          })
          if (!wsMember) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' } })
        }
      }

      // Build where clause conditions
      const whereConditions: Prisma.TaskBatchWhereInput = {
        is_deleted: false,
        is_hidden: true,
        canvas_id: null,
        video_studio_project_id: null,
      }

      if (workspaceId) {
        whereConditions.workspace_id = workspaceId
      } else {
        if (request.user.role !== 'admin') {
          whereConditions.user_id = userId
        }
      }

      if (decodedCursor) {
        whereConditions.AND = [
          {
            OR: [
              { created_at: { lt: new Date(decodedCursor.created_at) } },
              {
                AND: [
                  { created_at: { equals: new Date(decodedCursor.created_at) } },
                  { id: { lt: decodedCursor.id } },
                ],
              },
            ],
          },
        ]
      }

      const rows = await prisma.taskBatch.findMany({
        where: whereConditions,
        select: {
          id: true,
          module: true,
          provider: true,
          model: true,
          prompt: true,
          params: true,
          quantity: true,
          completed_count: true,
          failed_count: true,
          status: true,
          estimated_credits: true,
          actual_credits: true,
          created_at: true,
          user_id: true,
          workspace_id: true,
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      })

      const hasMore = rows.length > limit
      const batches = hasMore ? rows.slice(0, limit) : rows

      const batchIds = batches.map((b) => b.id)
      const thumbnailMap = new Map<string, string[]>()
      if (batchIds.length > 0) {
        const assets = await prisma.asset.findMany({
          where: { batch_id: { in: batchIds }, is_deleted: false },
          select: { batch_id: true, storage_url: true, original_url: true, type: true },
        })
        const signed = await Promise.all(assets.map(async (a) => ({
          batch_id: (a as any).batch_id,
          url: (a as any).storage_url ? await signAssetUrl((a as any).storage_url) : ((a as any).original_url ?? null),
          type: (a as any).type,
        })))
        for (const s of signed) {
          if (!s.url) continue
          const list = thumbnailMap.get(s.batch_id) ?? []
          if (list.length < 4) { list.push(s.url); thumbnailMap.set(s.batch_id, list) }
        }
      }

      const nextCursor = hasMore && batches.length > 0
        ? Buffer.from(JSON.stringify({
            created_at: batches[batches.length - 1].created_at.toISOString?.() ?? String(batches[batches.length - 1].created_at),
            id: batches[batches.length - 1].id,
          })).toString('base64')
        : null

      return reply.send({
        data: batches.map((b: any) => ({
          id: b.id, module: b.module, provider: b.provider, model: b.model,
          prompt: b.prompt, params: b.params ?? {}, quantity: b.quantity,
          completed_count: b.completed_count, failed_count: b.failed_count,
          status: b.status, estimated_credits: b.estimated_credits, actual_credits: b.actual_credits,
          created_at: b.created_at.toISOString?.() ?? String(b.created_at),
          tasks: [], thumbnail_urls: thumbnailMap.get(b.id) ?? [],
        })),
        cursor: nextCursor,
      })
    },
  )
}
