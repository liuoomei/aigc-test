import pino_ from 'pino'
import { prisma } from '../lib/prisma.js'

const pino = pino_ as any
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const AI_ERRORS_RETENTION_DAYS = 7
const PROMPT_FILTER_LOGS_RETENTION_DAYS = 30
const WEBHOOK_LOGS_RETENTION_DAYS = 30

export async function runPurgeOldRecords(): Promise<void> {
  const aiErrorsCutoff = new Date(Date.now() - AI_ERRORS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const aiErrorsDeleted = await prisma.aiAssistantError.deleteMany({
    where: { created_at: { lt: aiErrorsCutoff } },
  })

  const filterLogsCutoff = new Date(Date.now() - PROMPT_FILTER_LOGS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const filterLogsDeleted = await prisma.promptFilterLog.deleteMany({
    where: { created_at: { lt: filterLogsCutoff } },
  })

  const webhookLogsCutoff = new Date(Date.now() - WEBHOOK_LOGS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const webhookLogsDeleted = await prisma.webhookLog.deleteMany({
    where: { processed_at: { lt: webhookLogsCutoff } },
  })

  const total = aiErrorsDeleted.count + filterLogsDeleted.count + webhookLogsDeleted.count
  if (total > 0) {
    logger.info(
      { aiErrorsDeleted: aiErrorsDeleted.count, filterLogsDeleted: filterLogsDeleted.count, webhookLogsDeleted: webhookLogsDeleted.count },
      'Purged old records',
    )
  }
}
