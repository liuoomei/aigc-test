import type { FastifyInstance, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import jwt from 'jsonwebtoken'

// Public routes that skip auth
const PUBLIC_ROUTES = [
  '/api/v1/healthz',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/sso',
  '/api/v1/auth/accept-invite',
  '/api/v1/assets/proxy',
  '/api/v1/assets/thumbnail',
  '/api/v1/ai-assistant/uploads/',
  '/api/v1/avatar/uploads/',
  '/api/v1/action-imitation/uploads/',
  '/api/v1/videos/uploads/',
  '/api/v1/canvases/uploads/',
  '/api/v1/payment/notify',
]

export interface AuthUser {
  id: string
  email: string
  role: 'admin' | 'member'
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }
  interface FastifyInstance {
    redis: import('ioredis').Redis
  }
}

export const jwtAuthPlugin = fp(async function jwtAuth(app: FastifyInstance): Promise<void> {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is required')
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')

  app.decorateRequest('user', null as unknown as AuthUser)

  const redis = (app as unknown as { redis: import('ioredis').Redis }).redis

  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_ROUTES.some((r) => request.url.startsWith(r))) return

    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Missing or invalid authorization header' },
      })
    }

    try {
      const token = authHeader.slice(7)
      const payload = jwt.verify(token, secret) as { sub: string; email: string; role: string; iat: number }
      
      // Check session version in Redis for kick mechanism
      const sessionVersionStr = await redis.get(`user:session_version:${payload.sub}`)
      if (sessionVersionStr) {
        const sessionVersion = parseInt(sessionVersionStr, 10)
        if (payload.iat < sessionVersion) {
          return reply.status(401).send({
            success: false,
            error: { code: 'TOKEN_REVOKED', message: '账号已在其他设备登录' },
          })
        }
      }

      request.user = { id: payload.sub, email: payload.email, role: payload.role as 'admin' | 'member' }
    } catch (err) {
      const isExpired = err instanceof jwt.TokenExpiredError
      return reply.status(401).send({
        success: false,
        error: {
          code: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
          message: isExpired ? 'Access token expired' : 'Invalid or expired access token',
        },
      })
    }
  })
})
