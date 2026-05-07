import { prisma } from './prisma.js'
import { deleteS3Object, extractStorageKey } from './storage.js'
import type { PrismaClient } from '@prisma/client'

async function deleteStoredUrls(urls: Array<string | null | undefined>) {
  const keys = Array.from(new Set(urls.flatMap((url) => {
    if (!url) return []
    const key = extractStorageKey(url)
    return key ? [key] : []
  })))

  await Promise.all(keys.map((key) => deleteS3Object(key)))
}

export async function purgeCanvasProject(db: PrismaClient, canvasId: string) {
  const canvas = await db.canvas.findFirst({
    where: { id: canvasId },
    select: { thumbnail_url: true },
  })

  if (!canvas) return

  const assetRows = await db.asset.findMany({
    where: { batch: { canvas_id: canvasId } },
    select: { storage_url: true, original_url: true, thumbnail_url: true },
  })

  const outputRows = await db.canvasNodeOutput.findMany({
    where: { canvas_id: canvasId },
    select: { output_urls: true },
  })

  await deleteStoredUrls([
    canvas.thumbnail_url,
    ...assetRows.flatMap((row) => [row.storage_url, row.original_url, row.thumbnail_url]),
    ...outputRows.flatMap((row) => row.output_urls as string[] ?? []),
  ])

  await db.$transaction(async (tx) => {
    const batchIds = await tx.taskBatch.findMany({
      where: { canvas_id: canvasId },
      select: { id: true },
    })

    await tx.asset.deleteMany({
      where: { batch_id: { in: batchIds.map((b) => b.id) } },
    })

    await tx.canvasNodeOutput.deleteMany({
      where: { canvas_id: canvasId },
    })

    await tx.taskBatch.updateMany({
      where: { canvas_id: canvasId },
      data: { canvas_id: null, canvas_node_id: null },
    })

    await tx.canvas.deleteMany({
      where: { id: canvasId },
    })
  })
}

export async function purgeVideoStudioProject(db: PrismaClient, projectId: string) {
  const project = await db.videoStudioProject.findFirst({
    where: { id: projectId },
    select: { id: true },
  })

  if (!project) return

  const assetRows = await db.asset.findMany({
    where: { batch: { video_studio_project_id: projectId } },
    select: { storage_url: true, original_url: true, thumbnail_url: true },
  })

  await deleteStoredUrls(assetRows.flatMap((row) => [row.storage_url, row.original_url, row.thumbnail_url]))

  await db.$transaction(async (tx) => {
    const batchIds = await tx.taskBatch.findMany({
      where: { video_studio_project_id: projectId },
      select: { id: true },
    })

    await tx.asset.deleteMany({
      where: { batch_id: { in: batchIds.map((b) => b.id) } },
    })

    await tx.taskBatch.updateMany({
      where: { video_studio_project_id: projectId },
      data: { video_studio_project_id: null },
    })

    await tx.videoStudioProject.deleteMany({
      where: { id: projectId },
    })
  })
}

export async function softDeleteProjectAssets(field: 'canvas_id' | 'video_studio_project_id', id: string) {
  const batchIds = await prisma.taskBatch.findMany({
    where: { [field]: id },
    select: { id: true },
  })

  await prisma.asset.updateMany({
    where: { batch_id: { in: batchIds.map((b) => b.id) } },
    data: { is_deleted: true, deleted_at: new Date() },
  })
}

export async function restoreProjectAssets(field: 'canvas_id' | 'video_studio_project_id', id: string) {
  const batchIds = await prisma.taskBatch.findMany({
    where: { [field]: id },
    select: { id: true },
  })

  await prisma.asset.updateMany({
    where: { batch_id: { in: batchIds.map((b) => b.id) } },
    data: { is_deleted: false, deleted_at: null },
  })
}
