import { Worker } from 'bullmq'
import pino_ from 'pino'
import { getDb } from '@aigc/db'
import { sql } from 'kysely'
import type { TransferJobData } from '@aigc/types'
import { getRedis } from '../lib/redis.js'
import { validateExternalUrl } from '../lib/url-validator.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
const pino = pino_ as any
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

// 懒加载：避免模块顶层在 dotenv 初始化前执行导致读不到环境变量
function getExternalStorageUrl(): string {
  const url = process.env.EXTERNAL_STORAGE_URL
  if (!url) throw new Error('EXTERNAL_STORAGE_URL env var is required')
  return url
}

// If the storage API returns an external domain URL, rewrite to internal base URL
// so the API server can proxy it. e.g. https://midscreen.js118114.com:8443/path → http://61.155.227.29:19092/path
const EXTERNAL_STORAGE_BASE = process.env.EXTERNAL_STORAGE_BASE ?? ''

function rewriteStorageUrl(url: string): string {
  if (!EXTERNAL_STORAGE_BASE) return url
  try {
    const parsed = new URL(url)
    const base = new URL(EXTERNAL_STORAGE_BASE)
    parsed.protocol = base.protocol
    parsed.host = base.host
    return parsed.toString()
  } catch {
    return url
  }
}

interface ExternalStorageResponse {
  code: number
  msg: string
  data: {
    uuid: string
    url: string
  }
}

async function uploadToExternalStorage(taskId: string, sourceUrl: string, assetType: 'image' | 'video' = 'image'): Promise<string> {
  const fileType = assetType === 'video' ? 'mp4' : 'jpg'
  const res = await fetch(getExternalStorageUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid: taskId, url: sourceUrl, type: fileType }),
  })

  if (!res.ok) {
    throw new Error(`External storage API error: ${res.status} ${res.statusText}`)
  }

  const body = (await res.json()) as ExternalStorageResponse
  if (body.code !== 10000 || !body.data?.url) {
    throw new Error(`External storage returned error: code=${body.code} msg=${body.msg}`)
  }

  return rewriteStorageUrl(body.data.url)
}

// Upload a buffer to external storage by writing to a temp file and serving via API
async function uploadBufferToExternalStorage(taskId: string, buffer: Buffer): Promise<string> {
  const baseUrl = process.env.AI_UPLOAD_BASE_URL ?? process.env.INTERNAL_API_URL ?? ''
  if (!baseUrl) throw new Error('AI_UPLOAD_BASE_URL or INTERNAL_API_URL is required for thumbnail upload')

  const fileId = `${randomUUID()}.jpg`
  const filePath = join(tmpdir(), fileId)
  await writeFile(filePath, buffer)

  try {
    const publicUrl = `${baseUrl}/api/v1/canvases/uploads/${fileId}`
    const res = await fetch(getExternalStorageUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: `${taskId}-thumb`, url: publicUrl, type: 'jpg' }),
    })
    if (!res.ok) throw new Error(`Thumbnail upload error: ${res.status}`)
    const body = (await res.json()) as ExternalStorageResponse
    if (body.code !== 10000 || !body.data?.url) throw new Error(`Thumbnail upload failed: ${body.msg}`)
    return rewriteStorageUrl(body.data.url)
  } finally {
    unlink(filePath).catch(() => {})
  }
}

// Extract first frame from a video URL using ffmpeg, return as JPEG buffer
async function extractVideoThumbnail(videoUrl: string): Promise<Buffer | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aigc-thumb-'))
  const outPath = join(tmpDir, 'thumb.jpg')
  try {
    await execFileAsync('ffmpeg', [
      '-i', videoUrl,
      '-ss', '0',
      '-frames:v', '1',
      '-vf', 'scale=512:-1',  // resize to max 512px wide, keep aspect ratio
      '-q:v', '3',            // JPEG quality
      '-y',
      outPath,
    ], { timeout: 30_000 })

    const buf = await readFile(outPath)
    return buf
  } catch (err) {
    logger.warn({ err: String(err), videoUrl }, 'ffmpeg thumbnail extraction failed')
    return null
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

export const transferWorker = new Worker<TransferJobData>(
  'transfer-queue',
  async (job) => {
    const { taskId, assetId, originalUrl } = job.data
    const assetType = job.data.assetType ?? 'image'
    logger.info({ jobId: job.id, taskId, assetId, assetType }, 'Processing transfer job')

    try {
      // SSRF protection: validate URL before fetching
      validateExternalUrl(originalUrl)

      const storageUrl = await uploadToExternalStorage(taskId, originalUrl, assetType)

      // For videos: extract first frame thumbnail via ffmpeg
      let thumbnailUrl: string | null = null
      if (assetType === 'video') {
        try {
          const thumbBuf = await extractVideoThumbnail(originalUrl)
          if (thumbBuf) {
            thumbnailUrl = await uploadBufferToExternalStorage(taskId, thumbBuf)
            logger.info({ jobId: job.id, taskId, thumbnailUrl }, 'Video thumbnail extracted and uploaded')
          }
        } catch (thumbErr) {
          // Thumbnail failure is non-fatal — video still transfers successfully
          logger.warn({ jobId: job.id, taskId, err: String(thumbErr) }, 'Video thumbnail step failed (non-fatal)')
        }
      }

      const db = getDb()
      await db
        .updateTable('assets')
        .set({
          storage_url: storageUrl,
          transfer_status: 'completed',
          ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
        })
        .where('id', '=', assetId)
        .execute()

      // Update canvas_node_outputs: replace original provider URL with permanent storage URL
      await db
        .updateTable('canvas_node_outputs')
        .set({ output_urls: sql`array_replace(output_urls, ${originalUrl}::text, ${storageUrl}::text)` })
        .where(sql<boolean>`${originalUrl}::text = ANY(output_urls)`)
        .execute()

      logger.info({ jobId: job.id, taskId, storageUrl }, 'Transfer completed')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ jobId: job.id, taskId, err: msg }, 'Transfer failed')

      const db = getDb()
      await db
        .updateTable('assets')
        .set({ transfer_status: 'failed' })
        .where('id', '=', assetId)
        .execute()

      throw err
    }
  },
  {
    connection: getRedis(),
    concurrency: 5,
  },
)

transferWorker.on('error', (err) => {
  logger.error({ err: err.message }, 'Transfer worker error')
})
