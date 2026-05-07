import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { signAssetUrl, extractStorageKey, signThumbnailUrl, verifyThumbnailSig, getS3ObjectBuffer, encryptProxyUrl } from '../lib/storage.js'

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  // 内存缩略图缓存：key = "storageKey:width"，value = WebP Buffer
  const thumbnailCache = new Map<string, { data: Buffer; createdAt: number }>()
  const THUMBNAIL_CACHE_MAX = 500

  // GET /assets/thumbnail — 提供缩放后的 WebP（无需认证，HMAC 签名 URL）
  app.get<{ Querystring: { key: string; w?: string; exp: string; sig: string } }>(
    '/assets/thumbnail',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['key', 'exp', 'sig'],
          properties: {
            key: { type: 'string' },
            w: { type: 'string' },
            exp: { type: 'string' },
            sig: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { key, w, exp, sig } = request.query
      const width = Math.min(parseInt(w ?? '400', 10) || 400, 1200)
      const expNum = parseInt(exp, 10)

      if (!verifyThumbnailSig(key, width, expNum, sig)) {
        return reply.code(403).send({ error: 'Invalid or expired thumbnail URL' })
      }

      const cacheKey = `${key}:${width}`
      const cached = thumbnailCache.get(cacheKey)
      if (cached) {
        reply.header('Content-Type', 'image/webp')
        reply.header('Cache-Control', 'public, max-age=86400, immutable')
        reply.header('X-Cache', 'HIT')
        return reply.send(cached.data)
      }

      let rawBuffer: Buffer
      try {
        rawBuffer = await getS3ObjectBuffer(key)
      } catch (err) {
        app.log.warn({ err, key }, 'Failed to fetch asset from S3 for thumbnail')
        return reply.code(502).send({ error: 'Failed to fetch asset' })
      }

      let resultBuffer: Buffer
      let contentType: string
      try {
        const sharp = (await import('sharp')).default
        resultBuffer = await sharp(rawBuffer)
          .resize(width, null, { withoutEnlargement: true, fit: 'inside' })
          .webp({ quality: 82 })
          .toBuffer()
        contentType = 'image/webp'
      } catch {
        // 降级：返回原始数据
        resultBuffer = rawBuffer
        contentType = 'image/jpeg'
      }

      if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
        const oldest = [...thumbnailCache.entries()]
          .sort((a, b) => a[1].createdAt - b[1].createdAt)
          .slice(0, 100)
          .map(([k]) => k)
        for (const k of oldest) thumbnailCache.delete(k)
      }
      thumbnailCache.set(cacheKey, { data: resultBuffer, createdAt: Date.now() })

      reply.header('Content-Type', contentType)
      reply.header('Cache-Control', 'public, max-age=86400, immutable')
      reply.header('X-Cache', 'MISS')
      return reply.send(resultBuffer)
    },
  )

  app.get<{ Querystring: { workspace_id?: string; type?: string; date?: string; cursor?: string; limit?: string } }>(
    '/assets',
    async (request, reply) => {
      const { workspace_id, type, date, cursor, limit: limitStr } = request.query
      const userId = request.user.id

      if (!workspace_id) {
        return reply.badRequest('workspace_id is required')
      }

      // 验证工作空间成员身份
      if (request.user.role !== 'admin') {
        const wsMember = await prisma.workspaceMember.findFirst({
          where: { workspace_id, user_id: userId },
          select: { role: true },
        })
        if (!wsMember) {
          return reply.status(403).send({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' },
          })
        }
      }

      const limit = Math.min(parseInt(limitStr ?? '50', 10) || 50, 200)

      let decodedCursor: { created_at: string; id: string } | null = null
      if (cursor) {
        try {
          decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'))
        } catch {
          return reply.badRequest('Invalid cursor')
        }
      }

      // 构建 Prisma 查询
      const whereConditions: any = {
        batch: {
          workspace_id,
          canvas_id: null,
          video_studio_project_id: null,
        },
        is_deleted: false,
        OR: [
          { transfer_status: 'completed' as const },
          { original_url: { not: null } },
        ],
      }

      if (type) {
        whereConditions.type = type
      }

      // 按本地日期过滤（YYYY-MM-DD），使用 UTC 创建时间
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        whereConditions.created_at = {
          gte: new Date(`${date}T00:00:00.000Z`),
          lt: new Date(`${date}T24:00:00.000Z`),
        }
      }

      if (decodedCursor) {
        whereConditions.AND = [
          {
            OR: [
              { created_at: { lt: new Date(decodedCursor.created_at) } },
              {
                created_at: new Date(decodedCursor.created_at),
                id: { lt: decodedCursor.id },
              },
            ],
          },
        ]
      }

      const rows = await prisma.asset.findMany({
        where: whereConditions,
        include: {
          batch: {
            select: { id: true, prompt: true, model: true },
          },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      })

      const hasMore = rows.length > limit
      const assets = hasMore ? rows.slice(0, limit) : rows

      // 签名 URL 并构建缩略图 URL
      const signed = await Promise.all(
        assets.map(async (a) => {
          const rawUrl: string | null = a.storage_url
          const storageKey = rawUrl ? extractStorageKey(rawUrl) : null
          let thumbnail_url: string | null = null
          if (storageKey) {
            // MinIO/S3 — HMAC 签名缩略图端点
            thumbnail_url = signThumbnailUrl(storageKey, 400) || null
          } else if (rawUrl?.startsWith('http://')) {
            // 加密 URL 以隐藏存储服务器 IP
            thumbnail_url = `/api/v1/assets/proxy?token=${encryptProxyUrl(rawUrl)}&w=400`
          }
          return {
            id: a.id,
            type: a.type,
            storage_url: rawUrl ? await signAssetUrl(rawUrl) : null,
            thumbnail_url,
            original_url: a.original_url ? await signAssetUrl(a.original_url) : null,
            created_at: a.created_at.toISOString(),
            batch: { id: a.batch.id, prompt: a.batch.prompt, model: a.batch.model },
          }
        }),
      )

      const nextCursor = hasMore && assets.length > 0
        ? Buffer.from(
            JSON.stringify({
              created_at: assets[assets.length - 1].created_at.toISOString(),
              id: assets[assets.length - 1].id,
            }),
          ).toString('base64')
        : null

      return reply.send({ data: signed, cursor: nextCursor })
    },
  )

  // DELETE /assets/:id — 软删除资产
  app.delete<{ Params: { id: string } }>(
    '/assets/:id',
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id

      const asset = await prisma.asset.findFirst({
        where: { id, is_deleted: false },
        include: {
          batch: { select: { workspace_id: true } },
        },
      })

      if (!asset) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: '资产未找到' },
        })
      }

      // 权限校验：必须是资产所有者、工作空间成员或管理员
      const isOwner = asset.user_id != null && asset.user_id === userId
      if (!isOwner && request.user.role !== 'admin') {
        if (asset.batch.workspace_id) {
          const wsMember = await prisma.workspaceMember.findFirst({
            where: { workspace_id: asset.batch.workspace_id, user_id: userId },
            select: { role: true },
          })
          if (!wsMember) {
            return reply.status(403).send({
              success: false,
              error: { code: 'FORBIDDEN', message: 'Not authorized' },
            })
          }
        } else {
          return reply.status(403).send({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Not authorized' },
          })
        }
      }

      await prisma.asset.update({
        where: { id },
        data: { is_deleted: true, deleted_at: new Date() },
      })

      return reply.status(204).send()
    },
  )

  // GET /assets/trash — 列出工作空间的软删除资产（7 天内）
  app.get<{ Querystring: { workspace_id?: string } }>(
    '/assets/trash',
    async (request, reply) => {
      const { workspace_id } = request.query
      const userId = request.user.id

      if (!workspace_id) return reply.badRequest('workspace_id is required')

      if (request.user.role !== 'admin') {
        const wsMember = await prisma.workspaceMember.findFirst({
          where: { workspace_id, user_id: userId },
          select: { role: true },
        })
        if (!wsMember) return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' } })
      }

      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

      const assets = await prisma.asset.findMany({
        where: {
          batch: { workspace_id },
          is_deleted: true,
          deleted_at: { gte: cutoff },
        },
        include: {
          batch: { select: { prompt: true } },
        },
        orderBy: { deleted_at: 'desc' },
      })

      const signed = await Promise.all(
        assets.map(async (a) => ({
          id: a.id,
          type: a.type,
          storage_url: a.storage_url ? await signAssetUrl(a.storage_url) : null,
          original_url: a.original_url ?? null,
          deleted_at: a.deleted_at,
          prompt: a.batch.prompt,
        })),
      )

      return { data: signed }
    },
  )

  // POST /assets/trash/:id/restore — 恢复软删除的资产
  app.post<{ Params: { id: string } }>(
    '/assets/trash/:id/restore',
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id

      const asset = await prisma.asset.findFirst({
        where: { id, is_deleted: true },
        include: {
          batch: { select: { workspace_id: true } },
        },
      })

      if (!asset) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '资产不存在' } })

      if (asset.user_id !== userId && request.user.role !== 'admin') {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorized' } })
      }

      await prisma.asset.update({
        where: { id },
        data: { is_deleted: false, deleted_at: null },
      })

      return { success: true }
    },
  )

  // DELETE /assets/trash/:id — 永久删除资产
  app.delete<{ Params: { id: string } }>(
    '/assets/trash/:id',
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id

      const asset = await prisma.asset.findFirst({
        where: { id, is_deleted: true },
        select: { id: true, user_id: true },
      })

      if (!asset) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '资产不存在' } })

      if (asset.user_id !== userId && request.user.role !== 'admin') {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorized' } })
      }

      await prisma.asset.delete({ where: { id } })

      return reply.status(204).send()
    },
  )
}
