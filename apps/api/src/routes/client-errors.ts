import type { FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { prisma } from '../lib/prisma.js'
import { stripHtml } from '../lib/sanitize.js'

export async function clientErrorsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    max: 20,
    timeWindow: '1 minute',
    keyGenerator: (request) => `client-errors:${request.user?.id ?? request.ip}`,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      success: false,
      error: { code: 'RATE_LIMITED', message: `上报过于频繁，请 ${Math.ceil(context.ttl / 1000)} 秒后再试` },
    }),
  })

  app.post<{ Body: { error_code: string; detail?: string; http_status?: number | null; model?: string; canvas_id?: string } }>('/client-errors', {
    schema: {
      body: {
        type: 'object',
        required: ['error_code'],
        properties: {
          error_code: { type: 'string', minLength: 1, maxLength: 80 },
          detail: { type: 'string', maxLength: 2000 },
          http_status: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
          model: { type: 'string', maxLength: 100 },
          canvas_id: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const detail = request.body.detail ? stripHtml(request.body.detail).slice(0, 1000) : null

    prisma.submissionError.create({
      data: {
        user_id: request.user.id,
        source: 'client',
        error_code: request.body.error_code,
        http_status: request.body.http_status ?? null,
        detail,
        model: request.body.model ?? null,
        canvas_id: request.body.canvas_id ?? null,
      },
    }).catch((err) => {
      app.log.warn({ err, error_code: request.body.error_code }, 'Failed to log client submission error')
    })

    return { success: true }
  })
}
