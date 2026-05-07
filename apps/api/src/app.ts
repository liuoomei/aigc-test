import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import Redis from 'ioredis'
import { jwtAuthPlugin } from './plugins/jwt-auth.js'
import { prisma } from './lib/prisma.js'
import { healthzRoutes } from './routes/healthz.js'
import { generateRoutes } from './routes/generate.js'
import { sseRoutes } from './routes/sse.js'
import { batchRoutes } from './routes/batches.js'
import { authRoutes } from './routes/auth.js'
import { userRoutes } from './routes/users.js'
import { teamRoutes } from './routes/teams.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { adminRoutes } from './routes/admin.js'
import { proxyRoutes } from './routes/proxy.js'
import { assetRoutes } from './routes/assets.js'
import { videoRoutes } from './routes/videos.js'
import { aiAssistantRoutes } from './routes/ai-assistant.js'
import { avatarRoutes } from './routes/avatar.js'
import { actionImitationRoutes } from './routes/action-imitation.js'
import { canvasRoutes } from './routes/canvas.js'
import { canvasAgentRoutes } from './routes/canvas-agent.js'
import { videoStudioRoutes } from './routes/video-studio.js'
import { companyARoutes } from './routes/company-a.js'
import { clientErrorsRoutes } from './routes/client-errors.js'
import { paymentRoutes } from './routes/payment.js'

// Fastify 5 日志配置：开发环境使用 pino-pretty 美化输出
const isDev = process.env.NODE_ENV === 'development'

export async function buildApp() {
  const app = Fastify({
    logger: isDev
      ? { level: process.env.LOG_LEVEL ?? 'info', transport: { target: 'pino-pretty' } }
      : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 100 * 1024 * 1024, // 100 MB
  })

  await app.register(sensible)
  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } })

  // CORS
  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map(s => s.trim())
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: false,
  })

  // Redis client
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  app.decorate('redis', redis)

  app.addHook('onClose', async () => {
    await redis.quit()
    await prisma.$disconnect()
  })

  // Rate limit
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (request) => {
      const auth = request.headers.authorization
      if (auth?.startsWith('Bearer ')) {
        const tokenPrefix = auth.slice(7, 23)
        return `${request.ip}:${tokenPrefix}`
      }
      return request.ip
    },
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      success: false,
      error: { code: 'RATE_LIMITED', message: `请求过于频繁，请 ${Math.ceil(context.ttl / 1000)} 秒后再试` },
    }),
  })

  // Plugins
  await app.register(jwtAuthPlugin)

  // Routes — prefixed with /api/v1
  await app.register(
    async (v1) => {
      await v1.register(authRoutes)
      await v1.register(userRoutes)
      await v1.register(healthzRoutes)
      await v1.register(generateRoutes)
      await v1.register(sseRoutes)
      await v1.register(batchRoutes)
      await v1.register(teamRoutes)
      await v1.register(workspaceRoutes)
      await v1.register(adminRoutes)
      await v1.register(proxyRoutes)
      await v1.register(assetRoutes)
      await v1.register(videoRoutes)
      await v1.register(aiAssistantRoutes)
      await v1.register(avatarRoutes)
      await v1.register(actionImitationRoutes)
      await v1.register(canvasRoutes)
      await v1.register(canvasAgentRoutes)
      await v1.register(videoStudioRoutes)
      await v1.register(companyARoutes)
      await v1.register(clientErrorsRoutes)
      await v1.register(paymentRoutes)
    },
    { prefix: '/api/v1' },
  )

  // 全局错误处理
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error)

    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        success: false,
        error: { code: 'VALIDATION_ERROR', message: error.message },
      })
    }

    const statusCode = error.statusCode ?? 500
    return reply.status(statusCode).send({
      statusCode,
      success: false,
      error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message },
    })
  })

  return app
}
