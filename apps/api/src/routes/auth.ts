import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import type { LoginRequest, AcceptInviteRequest } from '@aigc/types'
import { buildUserProfile } from '../services/user-profile.js'

const MAX_LOGIN_ATTEMPTS = 5
const LOCKOUT_WINDOW = 10 * 60 // 10 minutes in seconds
const LOCKOUT_DURATION = 15 * 60 // 15 minutes in seconds
const BCRYPT_ROUNDS = 12
const MAX_PASSWORD_LENGTH = 72 // bcrypt truncates at 72 bytes

function signAccessToken(user: { id: string; account: string; role: string }): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set')
  const expiresIn = (process.env.JWT_ACCESS_EXPIRES_IN ?? '15m') as jwt.SignOptions['expiresIn']
  return jwt.sign({ sub: user.id, email: user.account, role: user.role }, secret, { expiresIn })
}

function signRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Account lockout helpers using Redis
  const redis = (app as unknown as { redis: import('ioredis').default }).redis

  async function checkAccountLocked(identifier: string): Promise<boolean> {
    const lockKey = `auth:locked:${identifier.toLowerCase()}`
    const locked = await redis.get(lockKey)
    return locked === '1'
  }

  async function recordFailedAttempt(identifier: string): Promise<void> {
    const attemptsKey = `auth:attempts:${identifier.toLowerCase()}`
    const count = await redis.incr(attemptsKey)
    if (count === 1) {
      await redis.expire(attemptsKey, LOCKOUT_WINDOW)
    }
    if (count >= MAX_LOGIN_ATTEMPTS) {
      const lockKey = `auth:locked:${identifier.toLowerCase()}`
      await redis.setex(lockKey, LOCKOUT_DURATION, '1')
      await redis.del(attemptsKey)
    }
  }

  async function clearFailedAttempts(identifier: string): Promise<void> {
    await redis.del(`auth:attempts:${identifier.toLowerCase()}`)
  }

  // POST /auth/login
  app.post<{ Body: LoginRequest }>('/auth/login', {
    config: {
      // Stricter rate limit for login: 10 attempts per minute per IP
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request: { ip: string }) => request.ip,
        errorResponseBuilder: (_request: unknown, context: { ttl: number }) => ({
          statusCode: 429,
          success: false,
          error: { code: 'RATE_LIMITED', message: `请求过于频繁，请 ${Math.ceil(context.ttl / 1000)} 秒后再试` },
        }),
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['identifier', 'password'],
        properties: {
          identifier: { type: 'string', minLength: 1, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 72 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { identifier, password } = request.body

    // Check account lockout
    if (await checkAccountLocked(identifier)) {
      return reply.status(429).send({
        success: false,
        error: { code: 'ACCOUNT_LOCKED', message: '登录失败次数过多，账户已临时锁定，请 15 分钟后再试' },
      })
    }

    const user = await prisma.user.findFirst({
      where: { account: identifier.toLowerCase() },
      select: { id: true, account: true, username: true, password_hash: true, role: true, status: true },
    })

    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      await recordFailedAttempt(identifier)
      // If user exists but is suspended, reveal that rather than a generic credentials error
      if (user && user.status !== 'active') {
        return reply.status(403).send({
          success: false,
          error: { code: 'ACCOUNT_SUSPENDED', message: '您的账户已被停用，请联系管理员' },
        })
      }
      return reply.status(401).send({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: '邮箱/手机号或密码错误' },
      })
    }

    if (user.status !== 'active') {
      return reply.status(403).send({
        success: false,
        error: { code: 'ACCOUNT_SUSPENDED', message: '您的账户已被停用，请联系管理员' },
      })
    }

    // Clear failed attempts on successful login
    await clearFailedAttempts(identifier)

    // Revoke all older refresh tokens to enforce single session
    await prisma.refreshToken.updateMany({
      where: { user_id: user.id, revoked_at: null },
      data: { revoked_at: new Date() },
    })

    // Publish kick event to other devices
    const sessionVersion = Math.floor(Date.now() / 1000)
    await redis.set(`user:session_version:${user.id}`, sessionVersion.toString(), 'EX', 7 * 24 * 60 * 60)

    const accessToken = signAccessToken({ id: user.id, account: user.account, role: user.role })
    const refreshToken = signRefreshToken()
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    await prisma.refreshToken.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
      },
    })

    reply.setCookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    })

    const profile = await buildUserProfile(prisma, user.id)
    return { access_token: accessToken, user: profile }
  })

  // POST /auth/refresh
  app.post('/auth/refresh', async (request, reply) => {
    const refreshToken = (request.cookies as Record<string, string | undefined>)?.refresh_token
    if (!refreshToken) {
      return reply.status(401).send({
        success: false,
        error: { code: 'NO_REFRESH_TOKEN', message: 'No refresh token provided' },
      })
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')

    const stored = await prisma.refreshToken.findFirst({
      where: { token_hash: tokenHash },
      include: { user: { select: { id: true, account: true, role: true, status: true } } },
    })

    if (!stored || stored.expires_at < new Date()) {
      return reply.status(401).send({
        success: false,
        error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token' },
      })
    }

    // Refresh token reuse detection: if a revoked token is presented,
    // an attacker may have stolen it. Revoke ALL tokens for this user.
    if (stored.revoked_at) {
      await prisma.refreshToken.updateMany({
        where: { user_id: stored.user_id, revoked_at: null },
        data: { revoked_at: new Date() },
      })

      reply.clearCookie('refresh_token', { path: '/api/v1/auth' })
      return reply.status(401).send({
        success: false,
        error: { code: 'TOKEN_REUSE_DETECTED', message: '检测到令牌重用，所有会话已失效，请重新登录' },
      })
    }

    if (stored.user.status !== 'active') {
      // Revoke the token so it can't be reused
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revoked_at: new Date() },
      })

      reply.clearCookie('refresh_token', { path: '/api/v1/auth' })

      return reply.status(403).send({
        success: false,
        error: { code: 'ACCOUNT_SUSPENDED', message: '您的账户已被停用，请联系团队管理员重新邀请' },
      })
    }

    // Atomic token rotation: revoke old + create new in one transaction
    const newRefreshToken = signRefreshToken()
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex')
    const newExpiresAt = new Date()
    newExpiresAt.setDate(newExpiresAt.getDate() + 7)

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revoked_at: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          user_id: stored.user_id,
          token_hash: newTokenHash,
          expires_at: newExpiresAt,
        },
      }),
    ])

    reply.setCookie('refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    })

    const accessToken = signAccessToken({ id: stored.user_id, account: stored.user.account, role: stored.user.role })
    const profile = await buildUserProfile(prisma, stored.user_id)
    return { access_token: accessToken, user: profile }
  })

  // POST /auth/logout
  app.post('/auth/logout', async (request, reply) => {
    const refreshToken = (request.cookies as Record<string, string | undefined>)?.refresh_token
    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
      await prisma.refreshToken.updateMany({
        where: { token_hash: tokenHash },
        data: { revoked_at: new Date() },
      })
    }

    reply.clearCookie('refresh_token', { path: '/api/v1/auth' })
    return { success: true }
  })

  // POST /auth/accept-invite
  app.post<{ Body: AcceptInviteRequest }>('/auth/accept-invite', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'password', 'username'],
        properties: {
          token: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email', maxLength: 254 },
          phone: { type: 'string', maxLength: 20 },
          password: { type: 'string', minLength: 8, maxLength: 72 },
          username: { type: 'string', minLength: 1, maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { token, email, phone, password, username } = request.body

    if (!email && !phone) {
      return reply.badRequest('必须提供邮箱或手机号')
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      return reply.badRequest(`密码长度不能超过 ${MAX_PASSWORD_LENGTH} 个字符`)
    }
    if (password.length < 8) {
      return reply.badRequest('密码长度至少为 8 个字符')
    }
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      return reply.badRequest('密码必须包含字母和数字')
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    // Use transaction to prevent concurrent accept-invite race
    const result = await prisma.$transaction(async (tx) => {
      const invite = await tx.emailVerification.findFirst({
        where: { token_hash: tokenHash, type: 'verify_email' },
        orderBy: { created_at: 'desc' },
      })

      if (!invite || invite.used_at || (invite.expires_at && invite.expires_at < new Date())) {
        return { error: 'INVALID_INVITE' as const }
      }

      // Verify identifier matches the invited user
      const invitedUser = await tx.user.findFirst({
        where: { id: invite.user_id },
        select: { id: true, email: true, phone: true, account: true },
      })

      if (!invitedUser) {
        return { error: 'INVALID_INVITE' as const }
      }

      // Check identifier match
      if (email && invitedUser.email?.toLowerCase() !== email.toLowerCase()) {
        return { error: 'IDENTIFIER_MISMATCH' as const }
      }
      if (phone && invitedUser.phone !== phone) {
        return { error: 'IDENTIFIER_MISMATCH' as const }
      }

      const pwHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

      // Update the pre-created user with real credentials
      await tx.user.update({
        where: { id: invite.user_id },
        data: { username, password_hash: pwHash, status: 'active' },
      })

      // Mark this token as used + invalidate any other unused tokens for this user
      await tx.emailVerification.updateMany({
        where: { user_id: invite.user_id, used_at: null },
        data: { used_at: new Date() },
      })

      return { userId: invite.user_id }
    })

    if ('error' in result) {
      if (result.error === 'IDENTIFIER_MISMATCH') {
        return reply.status(400).send({
          success: false,
          error: { code: 'IDENTIFIER_MISMATCH', message: '邮箱/手机号与邀请不匹配，请使用被邀请的账号' },
        })
      }
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_INVITE', message: '邀请链接无效或已过期' },
      })
    }

    const user = await prisma.user.findFirstOrThrow({
      where: { id: result.userId },
      select: { id: true, account: true, role: true },
    })

    // Revoke all older refresh tokens to enforce single session
    await prisma.refreshToken.updateMany({
      where: { user_id: user.id, revoked_at: null },
      data: { revoked_at: new Date() },
    })

    // Publish kick event to other devices
    const sessionVersion = Math.floor(Date.now() / 1000)
    await redis.set(`user:session_version:${user.id}`, sessionVersion.toString(), 'EX', 7 * 24 * 60 * 60)

    const accessToken = signAccessToken({ id: user.id, account: user.account, role: user.role })
    const refreshTokenStr = signRefreshToken()
    const refreshHash = crypto.createHash('sha256').update(refreshTokenStr).digest('hex')

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    await prisma.refreshToken.create({
      data: {
        user_id: user.id,
        token_hash: refreshHash,
        expires_at: expiresAt,
      },
    })

    reply.setCookie('refresh_token', refreshTokenStr, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    })

    const profile = await buildUserProfile(prisma, user.id)
    return reply.status(201).send({ access_token: accessToken, user: profile })
  })

  // POST /auth/sso — exchange a short-lived SSO token (signed by the same JWT_SECRET) for a full session
  // Partner system backend signs: { sub: userId, email: account, role } with JWT_SECRET, exp <= 5min
  app.post('/auth/sso', async (request, reply) => {
    const { token } = request.body as { token?: string }
    if (!token) return reply.badRequest('token is required')

    const secret = process.env.JWT_SECRET
    if (!secret) throw new Error('JWT_SECRET is not set')

    let payload: { sub: string; email: string; role: string; iat: number }
    try {
      payload = jwt.verify(token, secret) as typeof payload
    } catch (err) {
      const isExpired = err instanceof jwt.TokenExpiredError
      return reply.status(401).send({
        success: false,
        error: { code: isExpired ? 'SSO_TOKEN_EXPIRED' : 'SSO_TOKEN_INVALID', message: 'SSO token 无效或已过期' },
      })
    }

    // Enforce short expiry: SSO tokens must expire within 5 minutes of issuance
    if (!payload.iat || Date.now() / 1000 - payload.iat > 5 * 60) {
      return reply.status(401).send({
        success: false,
        error: { code: 'SSO_TOKEN_EXPIRED', message: 'SSO token 已过期，请重新跳转' },
      })
    }

    const user = await prisma.user.findFirst({
      where: { id: payload.sub },
      select: { id: true, account: true, role: true, status: true },
    })

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: '用户不存在' },
      })
    }

    if (user.status !== 'active') {
      return reply.status(403).send({
        success: false,
        error: { code: 'ACCOUNT_SUSPENDED', message: '您的账户已被停用，请联系管理员' },
      })
    }

    // Same session establishment as normal login
    await prisma.refreshToken.updateMany({
      where: { user_id: user.id, revoked_at: null },
      data: { revoked_at: new Date() },
    })

    const sessionVersion = Math.floor(Date.now() / 1000)
    await redis.set(`user:session_version:${user.id}`, sessionVersion.toString(), 'EX', 7 * 24 * 60 * 60)

    const accessToken = signAccessToken({ id: user.id, account: user.account, role: user.role })
    const refreshTokenStr = signRefreshToken()
    const refreshHash = crypto.createHash('sha256').update(refreshTokenStr).digest('hex')

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    await prisma.refreshToken.create({
      data: {
        user_id: user.id,
        token_hash: refreshHash,
        expires_at: expiresAt,
      },
    })

    reply.setCookie('refresh_token', refreshTokenStr, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    })

    const profile = await buildUserProfile(prisma, user.id)
    return { access_token: accessToken, user: profile }
  })
}