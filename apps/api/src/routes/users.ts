import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import bcrypt from 'bcryptjs'
import { buildUserProfile } from '../services/user-profile.js'

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // GET /users/me
  app.get('/users/me', async (request) => {
    return buildUserProfile(prisma, request.user.id)
  })

  // PATCH /users/me
  app.patch<{ Body: { username?: string; avatar_url?: string } }>('/users/me', {
    schema: {
      body: {
        type: 'object',
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 50 },
          avatar_url: { type: ['string', 'null'], maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { username, avatar_url } = request.body ?? {}
    if (!username && avatar_url === undefined) {
      return reply.badRequest('At least one field (username, avatar_url) is required')
    }

    const updates: Record<string, unknown> = {}

    if (username) {
      const sanitized = username.trim().slice(0, 50)
      if (sanitized.length < 1) return reply.badRequest('用户名不能为空')
      updates.username = sanitized
    }

    if (avatar_url !== undefined) {
      if (avatar_url !== null && avatar_url !== '') {
        // Basic URL validation
        try {
          const parsed = new URL(avatar_url)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return reply.badRequest('头像 URL 必须是 http 或 https 链接')
          }
        } catch {
          return reply.badRequest('头像 URL 格式无效')
        }
        updates.avatar_url = avatar_url.slice(0, 500)
      } else {
        updates.avatar_url = null
      }
    }

    await prisma.user.update({
      where: { id: request.user.id },
      data: updates,
    })

    return buildUserProfile(prisma, request.user.id)
  })

  // POST /users/me/password — change password
  app.post<{ Body: { current_password: string; new_password: string } }>('/users/me/password', {
    schema: {
      body: {
        type: 'object',
        required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string', minLength: 1 },
          new_password: { type: 'string', minLength: 8, maxLength: 72 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { current_password, new_password } = request.body
    if (new_password.length < 8) {
      return reply.badRequest('新密码长度至少为 8 个字符')
    }
    if (!/[a-zA-Z]/.test(new_password) || !/\d/.test(new_password)) {
      return reply.badRequest('新密码必须包含字母和数字')
    }

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { id: true, password_hash: true },
    })

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: '用户不存在' },
      })
    }

    const valid = user.password_hash ? await bcrypt.compare(current_password, user.password_hash) : false
    if (!valid) {
      return reply.status(400).send({
        success: false,
        error: { code: 'WRONG_PASSWORD', message: '当前密码不正确' },
      })
    }

    const newHash = await bcrypt.hash(new_password, 12)
    await prisma.user.update({
      where: { id: user.id },
      data: { password_hash: newHash, password_change_required: false },
    })

    return { success: true }
  })

  // GET /users/me/generation-defaults
  app.get('/users/me/generation-defaults', async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { generation_defaults: true },
    })

    if (!user) {
      return {}
    }

    return user.generation_defaults ?? {}
  })

  // PATCH /users/me/generation-defaults
  app.patch<{ Body: Record<string, unknown> }>('/users/me/generation-defaults', {
    schema: {
      body: { type: 'object', additionalProperties: true },
    },
  }, async (request) => {
    // Prisma 自动处理 JSON 字段，无需 JSON.stringify
    await prisma.user.update({
      where: { id: request.user.id },
      data: { generation_defaults: request.body as import("@prisma/client").Prisma.InputJsonValue },
    })
    return request.body
  })
}
