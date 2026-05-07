import type { FastifyInstance } from 'fastify'
import { createWriteStream, createReadStream } from 'node:fs'
import { unlink, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '../lib/prisma.js'
import { signAssetUrl, signAssetUrls, uploadToS3 } from '../lib/storage.js'
import { purgeCanvasProject, restoreProjectAssets, softDeleteProjectAssets } from '../lib/project-purge.js'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

const CANVAS_UPLOAD_DIR = '/tmp/canvas-uploads'
const CANVAS_UPLOAD_MAX_AGE_MS = 10 * 60 * 1000 // 10 min — enough for external storage to fetch
const SAFE_CANVAS_ID = /^[\w-]+\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/

async function assertCanvasEnabledForWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId },
    include: { team: { select: { team_type: true } } },
  })

  if (!workspace || workspace.team?.team_type !== 'avatar_enabled') {
    throw new Error('CANVAS_DISABLED')
  }
}

function hasS3UploadConfig(): boolean {
  return Boolean(
    process.env.STORAGE_ENDPOINT
    && process.env.STORAGE_ACCESS_KEY
    && process.env.STORAGE_SECRET_KEY
    && process.env.STORAGE_PUBLIC_URL
  )
}

function rewriteExternalStorageUrl(url: string): string {
  const base = process.env.EXTERNAL_STORAGE_BASE
  if (!base) return url
  try {
    const parsed = new URL(url)
    const internal = new URL(base)
    parsed.protocol = internal.protocol
    parsed.host = internal.host
    return parsed.toString()
  } catch {
    return url
  }
}

async function uploadViaLocalTemp(fileId: string, mimeType: string): Promise<string> {
  const externalStorageUrl = process.env.EXTERNAL_STORAGE_URL
  if (!externalStorageUrl) throw new Error('上传存储服务未配置')

  const baseUrl = process.env.AI_UPLOAD_BASE_URL ?? process.env.INTERNAL_API_URL ?? ''
  const publicUrl = `${baseUrl}/api/v1/canvases/uploads/${fileId}`
  const fileType = mimeType.startsWith('video/') ? 'mp4' : 'jpg'

  const res = await fetch(externalStorageUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid: randomUUID(), url: publicUrl, type: fileType }),
  })

  if (!res.ok) throw new Error(`外部存储服务异常(${res.status})`)

  const payload = await res.json() as any
  if (payload?.code !== 10000 || !payload?.data?.url) {
    throw new Error(payload?.msg ?? '外部存储返回异常')
  }

  return rewriteExternalStorageUrl(payload.data.url)
}

export async function canvasRoutes(app: FastifyInstance): Promise<void> {
  await mkdir(CANVAS_UPLOAD_DIR, { recursive: true })

  // GET /canvases/uploads/:id — serve temp files publicly (no auth) for external storage to fetch
  app.get<{ Params: { id: string } }>('/canvases/uploads/:id', async (request, reply) => {
    const { id } = request.params
    if (!SAFE_CANVAS_ID.test(id)) return reply.status(404).send()
    const filePath = join(CANVAS_UPLOAD_DIR, id)
    try {
      const s = await stat(filePath)
      if (Date.now() - s.mtimeMs > CANVAS_UPLOAD_MAX_AGE_MS) {
        await unlink(filePath).catch(() => {})
        return reply.status(404).send()
      }
      const ext = id.split('.').pop()!
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
        gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      }
      reply.header('Content-Type', mimeMap[ext] ?? 'application/octet-stream')
      reply.header('Content-Length', s.size)
      reply.header('Cache-Control', 'no-store')
      reply.header('X-Robots-Tag', 'noindex')
      return reply.send(createReadStream(filePath))
    } catch {
      return reply.status(404).send()
    }
  })

  // GET /canvases — list user's canvases, optionally filtered by workspace_id
  app.get<{ Querystring: { workspace_id?: string } }>('/canvases', async (request, reply) => {
    const userId = request.user.id
    const filterWsId = (request.query as any).workspace_id as string | undefined

    // Get all workspace IDs the user belongs to and that have canvas enabled
    const memberships = await prisma.workspaceMember.findMany({
      where: {
        user_id: userId,
        workspace: {
          team: { team_type: 'avatar_enabled' },
        },
      },
      select: { workspace_id: true },
    })

    const wsIds = memberships.map((m) => m.workspace_id)
    if (wsIds.length === 0) return reply.send([])

    // If workspace_id filter provided, verify membership then narrow
    const targetWsIds = filterWsId
      ? wsIds.filter((id) => id === filterWsId)
      : wsIds
    if (targetWsIds.length === 0) return reply.send([])

    const canvases = await prisma.canvas.findMany({
      where: {
        workspace_id: { in: targetWsIds },
        is_deleted: false,
      },
      select: { id: true, name: true, thumbnail_url: true, created_at: true, updated_at: true },
      orderBy: { updated_at: 'desc' },
    })

    // For canvases with a thumbnail_url, use it directly.
    // Only query canvas_node_outputs for canvases that have no thumbnail yet.
    const canvasesWithThumb = canvases.filter((c) => c.thumbnail_url)
    const canvasesNeedPreview = canvases.filter((c) => !c.thumbnail_url)

    const previewMap: Record<string, string[]> = {}

    if (canvasesNeedPreview.length > 0) {
      const needIds = canvasesNeedPreview.map((c) => c.id)
      const rows = await prisma.canvasNodeOutput.findMany({
        where: { canvas_id: { in: needIds } },
        select: { canvas_id: true, output_urls: true },
        orderBy: { created_at: 'desc' },
      })

      for (const row of rows) {
        const cid = row.canvas_id as string
        if (!previewMap[cid]) previewMap[cid] = []
        if (previewMap[cid].length >= 2) continue

        const url = (row.output_urls as string[] | null)?.[0]
        if (!url) continue
        if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) continue

        previewMap[cid].push(url)
      }
    }

    // Sign all URLs in parallel
    await Promise.all([
      ...canvasesWithThumb.map((c) =>
        signAssetUrls([c.thumbnail_url!]).then((signed) => { previewMap[c.id] = signed })
      ),
      ...Object.keys(previewMap)
        .filter((cid) => !canvasesWithThumb.find((c) => c.id === cid))
        .map((cid) =>
          signAssetUrls(previewMap[cid]).then((signed) => { previewMap[cid] = signed })
        ),
    ])

    return reply.send(canvases.map((c) => ({ ...c, preview_urls: previewMap[c.id] ?? [] })))
  })

  // POST /canvases — create new canvas
  app.post<{ Body: { name?: string; workspace_id?: string } }>('/canvases', async (request, reply) => {
    const userId = request.user.id
    const { name = '未命名画布', workspace_id } = request.body ?? {}

    // Resolve workspace: use provided or pick first membership
    let wsId = workspace_id
    if (!wsId) {
      const membership = await prisma.workspaceMember.findFirst({
        where: { user_id: userId },
        orderBy: { created_at: 'asc' },
        select: { workspace_id: true },
      })
      if (!membership) {
        return reply.status(400).send({ success: false, error: { code: 'NO_WORKSPACE', message: '用户没有可用的工作空间' } })
      }
      wsId = membership.workspace_id
    }

    // Verify membership
    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: wsId, user_id: userId },
      select: { role: true },
    })
    if (!member) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该工作空间' } })
    }

    try {
      await assertCanvasEnabledForWorkspace(wsId)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    const canvas = await prisma.canvas.create({
      data: {
        workspace_id: wsId,
        user_id: userId,
        name,
        structure_data: { nodes: [], edges: [] },
      },
    })

    return reply.status(201).send(canvas)
  })

  // GET /canvases/:id — load canvas with structure_data
  app.get<{ Params: { id: string } }>('/canvases/:id', async (request, reply) => {
    const canvas = await prisma.canvas.findFirst({
      where: { id: request.params.id, is_deleted: false },
    })

    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    // Auth: must be workspace member
    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    return reply.send(canvas)
  })

  // PATCH /canvases/:id — save structure_data (with optimistic lock)
  app.patch<{
    Params: { id: string }
    Body: { name?: string; structure_data?: any; version: number; thumbnail_url?: string }
  }>('/canvases/:id', async (request, reply) => {
    const { id } = request.params
    const { name, structure_data, version, thumbnail_url } = request.body

    // Guard: reject oversized structure_data (2 MB)
    if (structure_data !== undefined) {
      const size = JSON.stringify(structure_data).length
      if (size > 2 * 1024 * 1024) {
        return reply.status(413).send({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'structure_data 超过 2MB 限制' } })
      }
    }

    const canvas = await prisma.canvas.findFirst({
      where: { id, is_deleted: false },
      select: { workspace_id: true, version: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权修改该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    // Optimistic lock
    const updated = await prisma.canvas.updateMany({
      where: { id, version },
      data: {
        version: { increment: 1 },
        updated_at: new Date(),
        ...(name !== undefined ? { name } : {}),
        ...(structure_data !== undefined ? { structure_data } : {}),
        ...(thumbnail_url !== undefined ? { thumbnail_url } : {}),
      },
    })

    if (updated.count === 0) {
      return reply.status(409).send({ success: false, error: { code: 'CONFLICT', message: '画布已被其他设备修改，请刷新后重试' } })
    }

    const fresh = await prisma.canvas.findFirst({
      where: { id },
      select: { id: true, version: true },
    })

    return reply.send({ id: fresh!.id, version: fresh!.version })
  })

  // DELETE /canvases/:id
  app.delete<{ Params: { id: string } }>('/canvases/:id', async (request, reply) => {
    const canvas = await prisma.canvas.findFirst({
      where: { id: request.params.id, is_deleted: false },
      select: { workspace_id: true, user_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    // Only creator or workspace admin can delete
    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member || (canvas.user_id !== request.user.id && member.role !== 'admin')) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权删除该画布' } })
    }

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    await prisma.$transaction([
      prisma.canvas.update({
        where: { id: request.params.id },
        data: { is_deleted: true, deleted_at: new Date(), updated_at: new Date() },
      }),
    ])
    await softDeleteProjectAssets('canvas_id', request.params.id)
    return reply.send({ success: true })
  })

  // GET /canvases/trash — list deleted canvases
  app.get<{ Querystring: { workspace_id?: string } }>('/canvases/trash', async (request, reply) => {
    const userId = request.user.id
    const filterWsId = request.query.workspace_id

    const memberships = await prisma.workspaceMember.findMany({
      where: {
        user_id: userId,
        workspace: {
          team: { team_type: 'avatar_enabled' },
        },
      },
      select: { workspace_id: true, role: true },
    })

    const targetWsIds = memberships.map((m) => m.workspace_id).filter((id) => !filterWsId || id === filterWsId)
    if (targetWsIds.length === 0) return reply.send([])

    const adminWsIds = memberships.filter((m) => m.role === 'admin').map((m) => m.workspace_id)

    const canvases = await prisma.canvas.findMany({
      where: {
        workspace_id: { in: targetWsIds },
        is_deleted: true,
        OR: [
          { user_id: userId },
          { workspace_id: { in: adminWsIds } },
        ],
      },
      select: {
        id: true, name: true, thumbnail_url: true, created_at: true,
        updated_at: true, deleted_at: true, user_id: true, workspace_id: true,
      },
      orderBy: { deleted_at: 'desc' },
    })

    return reply.send(canvases)
  })

  // POST /canvases/:id/restore
  app.post<{ Params: { id: string } }>('/canvases/:id/restore', async (request, reply) => {
    const canvas = await prisma.canvas.findFirst({
      where: { id: request.params.id, is_deleted: true },
      select: { workspace_id: true, user_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member || (canvas.user_id !== request.user.id && member.role !== 'admin')) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权恢复该画布' } })
    }

    await prisma.$transaction([
      prisma.canvas.update({
        where: { id: request.params.id },
        data: { is_deleted: false, deleted_at: null, updated_at: new Date() },
      }),
    ])
    await restoreProjectAssets('canvas_id', request.params.id)

    return reply.send({ success: true })
  })

  // DELETE /canvases/:id/permanent
  app.delete<{ Params: { id: string } }>('/canvases/:id/permanent', async (request, reply) => {
    const canvas = await prisma.canvas.findFirst({
      where: { id: request.params.id, is_deleted: true },
      select: { workspace_id: true, user_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member || (canvas.user_id !== request.user.id && member.role !== 'admin')) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权永久删除该画布' } })
    }

    await purgeCanvasProject(prisma, request.params.id)
    return reply.send({ success: true })
  })

  // GET /canvases/:id/active-tasks — polling endpoint for execution progress
  app.get<{ Params: { id: string } }>('/canvases/:id/active-tasks', {
    config: {
      rateLimit: {
        max: 240,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { id } = request.params

    const canvas = await prisma.canvas.findFirst({
      where: { id, is_deleted: false },
      select: { workspace_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    // Get dirty version from Redis
    const redis = (app as any).redis
    let dirtyVersion = 0
    try {
      dirtyVersion = parseInt(await redis.get(`canvas:dirty:${id}`) ?? '0', 10)
    } catch (error) {
      request.log.warn({ err: error, canvasId: id }, 'Failed to read canvas dirty version')
    }

    // Fetch active batches for this canvas
    const activeRows = await prisma.taskBatch.findMany({
      where: {
        canvas_id: id,
        status: { in: ['pending', 'processing'] },
        is_deleted: false,
      },
      select: {
        id: true, canvas_node_id: true, status: true, quantity: true,
        completed_count: true, failed_count: true, provider: true, created_at: true,
      },
    })

    const batches = await Promise.all(activeRows.map(async (batch) => {
      const queuePosition = batch.status === 'pending'
        ? await prisma.taskBatch.count({
            where: {
              is_deleted: false,
              status: 'pending',
              provider: batch.provider,
              created_at: { lt: batch.created_at },
            },
          })
        : null
      const processing = await prisma.task.findFirst({
        where: { batch_id: batch.id, processing_started_at: { not: null } },
        select: { processing_started_at: true },
        orderBy: { processing_started_at: 'asc' },
      })
      return {
        id: batch.id,
        canvas_node_id: batch.canvas_node_id,
        status: batch.status,
        quantity: batch.quantity,
        completed_count: batch.completed_count,
        failed_count: batch.failed_count,
        queue_position: queuePosition,
        processing_started_at: processing?.processing_started_at ?? null,
      }
    }))

    return reply.send({ version: dirtyVersion, batches })
  })

  // POST /canvases/:id/node-outputs/:nodeId — write pre-generated outputs (e.g. from video studio export)
  app.post<{ Params: { id: string; nodeId: string }; Body: { output_urls: string[]; is_selected?: boolean } }>(
    '/canvases/:id/node-outputs/:nodeId',
    async (request, reply) => {
      const { id, nodeId } = request.params
      const { output_urls, is_selected = true } = request.body

      const canvas = await prisma.canvas.findFirst({
        where: { id },
        select: { workspace_id: true },
      })
      if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

      const member = await prisma.workspaceMember.findFirst({
        where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
        select: { role: true },
      })
      if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该画布' } })

      const row = await prisma.canvasNodeOutput.create({
        data: {
          canvas_id: id,
          node_id: nodeId,
          user_id: request.user.id,
          output_urls,
          is_selected,
        },
        select: { id: true },
      })

      return reply.status(201).send({ id: row.id })
    }
  )

  // GET /canvases/:id/node-outputs/:nodeId — load history outputs for a node
  app.get<{ Params: { id: string; nodeId: string } }>('/canvases/:id/node-outputs/:nodeId', {
    config: {
      rateLimit: {
        max: 480,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { id, nodeId } = request.params

    const canvas = await prisma.canvas.findFirst({
      where: { id, is_deleted: false },
      select: { workspace_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    const outputs = await prisma.canvasNodeOutput.findMany({
      where: { canvas_id: id, node_id: nodeId },
      select: {
        id: true,
        output_urls: true,
        is_selected: true,
        created_at: true,
        batch_id: true,
      },
      orderBy: { created_at: 'desc' },
    })

    // Sign each output_urls array
    const signed = await Promise.all(
      outputs.map(async (row) => ({
        id: row.id,
        output_urls: await signAssetUrls((row.output_urls as string[]) ?? []),
        is_selected: row.is_selected,
        created_at: row.created_at,
        asset_type: null,
      }))
    )

    return reply.send(signed)
  })

  // GET /canvases/:id/all-node-outputs — batch load outputs for all nodes in one request
  app.get<{ Params: { id: string } }>('/canvases/:id/all-node-outputs', {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { id } = request.params

    const canvas = await prisma.canvas.findFirst({
      where: { id, is_deleted: false },
      select: { workspace_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    const outputs = await prisma.canvasNodeOutput.findMany({
      where: { canvas_id: id },
      select: {
        id: true,
        node_id: true,
        output_urls: true,
        is_selected: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    })

    // Group by node_id and sign URLs
    const grouped: Record<string, unknown[]> = {}
    for (const row of outputs) {
      const nodeId = row.node_id as string
      if (!grouped[nodeId]) grouped[nodeId] = []
      grouped[nodeId].push(row)
    }

    for (const nodeId of Object.keys(grouped)) {
      grouped[nodeId] = await Promise.all(
        (grouped[nodeId] as typeof outputs).map(async (row) => ({
          id: row.id,
          node_id: row.node_id,
          output_urls: await signAssetUrls((row.output_urls as string[]) ?? []),
          is_selected: row.is_selected,
          created_at: row.created_at,
          asset_type: null,
        }))
      )
    }

    return reply.send(grouped)
  })

  // POST /canvases/:id/node-outputs/:nodeId/select — set selected output for a node
  app.post<{
    Params: { id: string; nodeId: string }
    Body: { output_id?: string }
  }>('/canvases/:id/node-outputs/:nodeId/select', {
    config: {
      rateLimit: {
        max: 300,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { id, nodeId } = request.params
    const { output_id } = request.body ?? {}

    if (!output_id) {
      return reply.badRequest('output_id is required')
    }

    const canvas = await prisma.canvas.findFirst({
      where: { id, is_deleted: false },
      select: { workspace_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权修改该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    const target = await prisma.canvasNodeOutput.findFirst({
      where: { id: output_id, canvas_id: id, node_id: nodeId },
      select: { id: true },
    })

    if (!target) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '目标输出不存在' } })
    }

    await prisma.$transaction([
      prisma.canvasNodeOutput.updateMany({
        where: { canvas_id: id, node_id: nodeId },
        data: { is_selected: false },
      }),
      prisma.canvasNodeOutput.update({
        where: { id: output_id },
        data: { is_selected: true },
      }),
    ])

    return reply.send({ success: true, selected_output_id: output_id })
  })

  // GET /canvases/:id/history — batch list for this canvas (with tasks+asset info)
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; cursor?: string }
  }>('/canvases/:id/history', {
    config: {
      rateLimit: {
        max: 600,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const limitN = Math.min(parseInt(request.query.limit ?? '30', 10) || 30, 100)
    const cursor = request.query.cursor

    const canvas = await prisma.canvas.findFirst({
      where: { id, is_deleted: false },
      select: { workspace_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    let decodedCursor: { created_at: string; id: string } | null = null
    if (cursor) {
      try { decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) }
      catch { return reply.badRequest('Invalid cursor') }
    }

    const whereClause: any = {
      canvas_id: id,
      is_deleted: false,
    }

    if (decodedCursor) {
      whereClause.OR = [
        { created_at: { lt: decodedCursor.created_at } },
        {
          created_at: decodedCursor.created_at,
          id: { lt: decodedCursor.id },
        },
      ]
    }

    const rows = await prisma.taskBatch.findMany({
      where: whereClause,
      select: {
        id: true, canvas_node_id: true, model: true, prompt: true, quantity: true,
        completed_count: true, failed_count: true, status: true, actual_credits: true,
        created_at: true, module: true, provider: true,
      },
      orderBy: [
        { created_at: 'desc' },
        { id: 'desc' },
      ],
      take: limitN + 1,
    })

    const hasMore = rows.length > limitN
    const items = await Promise.all((hasMore ? rows.slice(0, limitN) : rows).map(async (batch) => {
      const queuePosition = batch.status === 'pending'
        ? await prisma.taskBatch.count({
            where: {
              is_deleted: false,
              status: 'pending',
              provider: batch.provider,
              created_at: { lt: batch.created_at },
            },
          })
        : null
      const processing = await prisma.task.findFirst({
        where: { batch_id: batch.id, processing_started_at: { not: null } },
        select: { processing_started_at: true },
        orderBy: { processing_started_at: 'asc' },
      })
      const { provider: _provider, ...item } = batch
      return {
        ...item,
        queue_position: queuePosition,
        processing_started_at: processing?.processing_started_at ?? null,
      }
    }))

    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ created_at: items[items.length - 1].created_at, id: items[items.length - 1].id })).toString('base64')
      : null

    return reply.send({ items, nextCursor })
  })

  // GET /canvases/:id/assets — asset library for this canvas
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; cursor?: string; type?: string }
  }>('/canvases/:id/assets', {
    config: {
      rateLimit: {
        max: 600,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const limitN = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200)
    const cursor = request.query.cursor
    const type = request.query.type

    const canvas = await prisma.canvas.findFirst({
      where: { id, is_deleted: false },
      select: { workspace_id: true },
    })
    if (!canvas) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '画布不存在' } })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: canvas.workspace_id, user_id: request.user.id },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权访问该画布' } })

    try {
      await assertCanvasEnabledForWorkspace(canvas.workspace_id)
    } catch {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    let decodedCursor: { created_at: string; id: string } | null = null
    if (cursor) {
      try { decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) }
      catch { return reply.badRequest('Invalid cursor') }
    }

    const whereClause: any = {
      batch: { canvas_id: id },
      is_deleted: false,
      OR: [
        { transfer_status: 'completed' },
        { original_url: { not: null } },
      ],
    }

    if (type) whereClause.type = type

    if (decodedCursor) {
      whereClause.OR = [
        ...whereClause.OR,
        { created_at: { lt: decodedCursor.created_at } },
        {
          created_at: decodedCursor.created_at,
          id: { lt: decodedCursor.id },
        },
      ]
    }

    const rows = await prisma.asset.findMany({
      where: whereClause,
      select: {
        id: true, type: true, storage_url: true, original_url: true, created_at: true,
        batch: { select: { id: true, canvas_node_id: true, prompt: true, model: true } },
      },
      orderBy: [
        { created_at: 'desc' },
        { id: 'desc' },
      ],
      take: limitN + 1,
    })

    const hasMore = rows.length > limitN
    const items = hasMore ? rows.slice(0, limitN) : rows

    // Sign storage URLs
    const signedItems = await Promise.all(
      items.map(async (item) => ({
        id: item.id,
        type: item.type,
        storage_url: await signAssetUrl(item.storage_url),
        original_url: item.original_url ? await signAssetUrl(item.original_url) : null,
        created_at: item.created_at,
        batch_id: item.batch.id,
        canvas_node_id: item.batch.canvas_node_id,
        prompt: item.batch.prompt,
        model: item.batch.model,
      }))
    )

    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ created_at: items[items.length - 1].created_at, id: items[items.length - 1].id })).toString('base64')
      : null

    return reply.send({ items: signedItems, nextCursor })
  })

  // POST /canvases/asset-upload — upload an image/video file for use as an asset node
  app.post('/canvases/asset-upload', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const userId = request.user.id

    const memberships = await prisma.workspaceMember.findMany({
      where: {
        user_id: userId,
        workspace: {
          team: { team_type: 'avatar_enabled' },
        },
      },
      select: { workspace_id: true },
      take: 1,
    })

    if (memberships.length === 0) {
      return reply.status(403).send({ success: false, error: { code: 'CANVAS_DISABLED', message: '当前团队未开通画布能力' } })
    }

    const data = await (request as any).file({ limits: { fileSize: 50 * 1024 * 1024 } })
    if (!data) return reply.badRequest('No file provided')

    const mimeType: string = data.mimetype ?? ''
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) {
      return reply.badRequest('Only image, video, and audio files are supported')
    }

    const ext = (data.filename as string).split('.').pop()?.toLowerCase() ?? 'bin'
    const fileId = `${randomUUID()}.${ext}`
    const filePath = join(CANVAS_UPLOAD_DIR, fileId)

    // Stream to disk first
    await pipeline(data.file, createWriteStream(filePath))

    try {
      let storageUrl: string

      if (hasS3UploadConfig()) {
        const key = `canvas-assets/${fileId}`
        try {
          const buf = await import('node:fs/promises').then((m) => m.readFile(filePath))
          storageUrl = await uploadToS3(key, buf, mimeType)
        } catch (err: any) {
          app.log.warn({ err: err?.message ?? String(err) }, 'S3 upload failed, fallback to external storage')
          storageUrl = await uploadViaLocalTemp(fileId, mimeType)
        }
      } else {
        storageUrl = await uploadViaLocalTemp(fileId, mimeType)
      }

      const signedUrl = await signAssetUrl(storageUrl)
      return reply.send({ url: signedUrl ?? storageUrl, storageUrl })
    } catch (err: any) {
      app.log.error({ err: err?.message ?? String(err) }, 'Canvas asset upload failed')
      return reply.status(502).send({
        success: false,
        error: {
          code: 'UPLOAD_FAILED',
          message: err?.message ?? '上传服务暂时不可用，请稍后重试',
        },
      })
    } finally {
      // Clean up temp file regardless of outcome
      unlink(filePath).catch(() => {})
    }
  })
}