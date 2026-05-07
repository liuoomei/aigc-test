import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import pino_ from 'pino'
import { prisma } from '../lib/prisma.js'
import { getBucket, getPublicUrl, getS3 } from '../lib/storage.js'

const pino = pino_ as any
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const PROJECT_RETENTION_DAYS = 7

function extractStorageKey(storageUrl: string | null | undefined): string | null {
  if (!storageUrl) return null
  const publicUrl = getPublicUrl()
  if (!publicUrl || !storageUrl.startsWith(publicUrl)) return null
  const key = storageUrl.slice(publicUrl.length + 1)
  return key || null
}

async function deleteStoredUrls(urls: Array<string | null | undefined>) {
  const keys = Array.from(new Set(urls.flatMap((url) => {
    const key = extractStorageKey(url)
    return key ? [key] : []
  })))
  const s3 = getS3()
  await Promise.all(keys.map((key) => s3.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }))))
}

async function purgeCanvasProject(canvasId: string) {
  const canvas = await prisma.canvas.findFirst({
    where: { id: canvasId },
    select: { thumbnail_url: true },
  })
  if (!canvas) return

  const assetRows = await prisma.asset.findMany({
    where: { batch: { canvas_id: canvasId } },
    select: { storage_url: true, original_url: true, thumbnail_url: true },
  })

  const outputRows = await prisma.canvasNodeOutput.findMany({
    where: { canvas_id: canvasId },
    select: { output_urls: true },
  })

  await deleteStoredUrls([
    canvas.thumbnail_url,
    ...assetRows.flatMap((row) => [row.storage_url, row.original_url, row.thumbnail_url]),
    ...outputRows.flatMap((row) => (row.output_urls as string[]) ?? []),
  ])

  await prisma.$transaction([
    prisma.asset.deleteMany({
      where: { batch: { canvas_id: canvasId } },
    }),
    prisma.canvasNodeOutput.deleteMany({ where: { canvas_id: canvasId } }),
    prisma.taskBatch.updateMany({
      where: { canvas_id: canvasId },
      data: { canvas_id: null, canvas_node_id: null },
    }),
    prisma.canvas.delete({ where: { id: canvasId } }),
  ])
}

async function purgeVideoStudioProject(projectId: string) {
  const project = await prisma.videoStudioProject.findFirst({
    where: { id: projectId },
    select: { id: true },
  })
  if (!project) return

  const assetRows = await prisma.asset.findMany({
    where: { batch: { video_studio_project_id: projectId } },
    select: { storage_url: true, original_url: true, thumbnail_url: true },
  })

  await deleteStoredUrls(assetRows.flatMap((row) => [row.storage_url, row.original_url, row.thumbnail_url]))

  await prisma.$transaction([
    prisma.asset.deleteMany({
      where: { batch: { video_studio_project_id: projectId } },
    }),
    prisma.taskBatch.updateMany({
      where: { video_studio_project_id: projectId },
      data: { video_studio_project_id: null },
    }),
    prisma.videoStudioProject.delete({ where: { id: projectId } }),
  ])
}

export async function runPurgeDeletedProjects(): Promise<void> {
  const cutoff = new Date(Date.now() - PROJECT_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const canvases = await prisma.canvas.findMany({
    where: { is_deleted: true, deleted_at: { lt: cutoff } },
    select: { id: true },
    take: 100,
  })
  const videoProjects = await prisma.videoStudioProject.findMany({
    where: { is_deleted: true, deleted_at: { lt: cutoff } },
    select: { id: true },
    take: 100,
  })

  let purgedCanvases = 0
  let purgedVideoProjects = 0

  for (const canvas of canvases) {
    try {
      await purgeCanvasProject(canvas.id)
      purgedCanvases += 1
    } catch (err) {
      logger.error({ err, canvasId: canvas.id }, 'Failed to purge deleted canvas')
    }
  }

  for (const project of videoProjects) {
    try {
      await purgeVideoStudioProject(project.id)
      purgedVideoProjects += 1
    } catch (err) {
      logger.error({ err, projectId: project.id }, 'Failed to purge deleted video studio project')
    }
  }

  if (purgedCanvases > 0 || purgedVideoProjects > 0) {
    logger.info({ purgedCanvases, purgedVideoProjects }, 'Purged deleted projects')
  }
}
