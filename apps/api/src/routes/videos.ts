import type { FastifyInstance } from 'fastify'
import { createWriteStream, createReadStream } from 'node:fs'
import { unlink, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { prisma } from '../lib/prisma.js'
import { freezeCredits, refundCredits } from '../services/credit.js'
import { VIDEO_CREDITS_MAP } from '../lib/credits.js'
import { encryptProxyUrl } from '../lib/storage.js'
import { runConcatExport, type ConcatJobStore } from '../services/concat-export.js'

// ── Temp upload config ────────────────────────────────────────────────────────
const UPLOAD_DIR = '/tmp/video-uploads'
const MAX_FILE_AGE_MS = 60 * 60 * 1000 // 60 minutes
const MAX_IMAGE_SIZE = 30 * 1024 * 1024  // 30 MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024  // 50 MB
const MAX_AUDIO_SIZE = 15 * 1024 * 1024  // 15 MB

// In-memory job store for concat-export jobs (hot path); DB is the durable fallback
const concatJobStore: ConcatJobStore = new Map()

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'gif']
const VIDEO_EXTS = ['mp4', 'mov', 'webm']
const AUDIO_EXTS = ['mp3', 'wav']
const ALL_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  bmp: 'image/bmp', tiff: 'image/tiff', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav',
}
const SAFE_ID = /^[\w-]+\.(jpg|jpeg|png|webp|bmp|tiff|gif|mp4|mov|webm|mp3|wav)$/

// Map frontend model codes → actual Volcengine model IDs
const VOLCENGINE_MODEL_ID: Record<string, string> = {
  'seedance-1.5-pro': 'doubao-seedance-1-5-pro-251215',
  'seedance-2.0':     'doubao-seedance-2-0-260128',
  'seedance-2.0-fast':'doubao-seedance-2-0-fast-260128',
}

interface VideoGenerateBody {
  prompt: string
  workspace_id: string
  idempotency_key?: string
  canvas_id?: string
  canvas_node_id?: string
  video_studio_project_id?: string
  model?: string
  images?: string[]            // 首尾帧（首尾帧 Tab）
  reference_images?: string[]  // 参考图（参考生视频 Tab / multimodal Tab，Seedance 2.0 专用）
  reference_videos?: string[]  // 参考视频（multimodal Tab，Seedance 2.0 专用）
  reference_audios?: string[]  // 参考音频（multimodal Tab，Seedance 2.0 专用）
  aspect_ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | 'adaptive'
  enable_upsample?: boolean
  resolution?: '480p' | '720p' | '1080p'
  duration?: number
  generate_audio?: boolean
  camera_fixed?: boolean
  watermark?: boolean
}

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true })

  const BASE_URL = process.env.AVATAR_UPLOAD_BASE_URL ?? process.env.AI_UPLOAD_BASE_URL ?? ''

  /**
   * Convert a URL to a publicly accessible absolute URL for AI API calls.
   * - Internal HTTP URLs (http://...) → encrypted proxy URL
   * - Relative proxy paths (/api/v1/assets/proxy?...) → prepend BASE_URL
   * - Already absolute HTTPS URLs → return as-is
   */
  function toPublicUrl(url: string): string {
    if (url.startsWith('http://')) {
      return `${BASE_URL}/api/v1/assets/proxy?token=${encryptProxyUrl(url)}`
    }
    if (url.startsWith('/')) {
      return `${BASE_URL}${url}`
    }
    return url
  }

  function toPublicUrls(urls: string[] | undefined): string[] | undefined {
    if (!urls || urls.length === 0) return urls
    return urls.map(toPublicUrl)
  }

  // ── POST /videos/upload ───────────────────────────────────────────────────
  // Upload image / video / audio for Seedance multimodal; returns public URL.
  app.post('/videos/upload', async (request, reply) => {
    const maxSize = Math.max(MAX_IMAGE_SIZE, MAX_VIDEO_SIZE, MAX_AUDIO_SIZE)
    const data = await (request as any).file({ limits: { fileSize: maxSize } })
    if (!data) return reply.badRequest('未检测到文件，请重新选择后上传')

    const ext = (data.filename as string).split('.').pop()?.toLowerCase() ?? ''
    if (!ALL_EXTS.includes(ext)) {
      const allowed = `图片（${IMAGE_EXTS.join('/')}）、视频（${VIDEO_EXTS.join('/')}）、音频（${AUDIO_EXTS.join('/')}）`
      return reply.badRequest(`不支持的文件格式「.${ext}」，请上传 ${allowed} 格式的文件`)
    }

    // Per-type size check
    const isImage = IMAGE_EXTS.includes(ext)
    const isVideo = VIDEO_EXTS.includes(ext)
    const isAudio = AUDIO_EXTS.includes(ext)
    const maxAllowed = isImage ? MAX_IMAGE_SIZE : isVideo ? MAX_VIDEO_SIZE : MAX_AUDIO_SIZE
    if (data.file.bytesRead > maxAllowed) {
      const mb = Math.round(maxAllowed / 1024 / 1024)
      const typeLabel = isImage ? '图片' : isVideo ? '视频' : '音频'
      return reply.badRequest(`${typeLabel}文件过大，最大支持 ${mb} MB，请压缩后重新上传`)
    }

    const id = `${randomUUID()}.${ext}`
    const filePath = join(UPLOAD_DIR, id)
    await pipeline(data.file, createWriteStream(filePath))

    return { url: `${BASE_URL}/api/v1/videos/uploads/${id}` }
  })

  // ── GET /videos/uploads/:id ───────────────────────────────────────────────
  // Serve temp files publicly so Volcengine can fetch them (no auth required).
  app.get<{ Params: { id: string } }>('/videos/uploads/:id', async (request, reply) => {
    const { id } = request.params
    if (!SAFE_ID.test(id)) return reply.status(404).send()

    const filePath = join(UPLOAD_DIR, id)
    try {
      const s = await stat(filePath)
      if (Date.now() - s.mtimeMs > MAX_FILE_AGE_MS) {
        await unlink(filePath).catch(() => {})
        return reply.status(404).send()
      }
      const ext = id.split('.').pop()!
      reply.header('Content-Type', MIME_MAP[ext] ?? 'application/octet-stream')
      reply.header('Content-Length', s.size)
      reply.header('Cache-Control', 'no-store')
      reply.header('X-Robots-Tag', 'noindex')
      return reply.send(createReadStream(filePath))
    } catch {
      return reply.status(404).send()
    }
  })

  app.post<{ Body: VideoGenerateBody }>('/videos/generate', {
    schema: {
      body: {
        type: 'object',
        required: ['prompt', 'workspace_id'],
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 4000 },
          workspace_id: { type: 'string', format: 'uuid' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
          canvas_id: { type: 'string', format: 'uuid' },
          canvas_node_id: { type: 'string', maxLength: 128 },
          video_studio_project_id: { type: 'string', format: 'uuid' },
          model: {
            type: 'string',
            enum: ['veo3.1-fast', 'veo3.1-components', 'seedance-1.5-pro', 'seedance-2.0', 'seedance-2.0-fast'],
            default: 'veo3.1-fast'
          },
          images: { type: 'array', items: { type: 'string' }, maxItems: 2 },
          reference_images: { type: 'array', items: { type: 'string' }, maxItems: 9 },
          reference_videos: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          reference_audios: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'] },
          enable_upsample: { type: 'boolean' },
          resolution: { type: 'string', enum: ['480p', '720p', '1080p'] },
          duration: { type: 'integer', minimum: -1, maximum: 15 },
          generate_audio: { type: 'boolean' },
          camera_fixed: { type: 'boolean' },
          watermark: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const {
      prompt,
      workspace_id: workspaceId,
      idempotency_key: idempotencyKey,
      canvas_id: canvasId,
      canvas_node_id: canvasNodeId,
      video_studio_project_id: videoStudioProjectId,
      model = 'veo3.1-fast',
      images: rawImages,
      reference_images: rawReferenceImages,
      reference_videos: rawReferenceVideos,
      reference_audios: rawReferenceAudios,
      aspect_ratio,
      enable_upsample,
      resolution,
      duration,
      generate_audio,
      camera_fixed,
      watermark,
    } = request.body

    const isSeedance = model.startsWith('seedance-')
    const isSeedance2 = model === 'seedance-2.0' || model === 'seedance-2.0-fast'

    // Convert internal storage URLs (http://...) to publicly accessible proxy URLs
    // so that Volcengine / Veo APIs can fetch the reference media.
    const images           = toPublicUrls(rawImages)
    const reference_images = toPublicUrls(rawReferenceImages)
    const reference_videos = toPublicUrls(rawReferenceVideos)
    const reference_audios = toPublicUrls(rawReferenceAudios)

    // Validate images count based on model
    if (images) {
      if (model === 'veo3.1-fast' && images.length > 2) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_IMAGES', message: 'veo3.1-fast 模型最多支持2张图片（首尾帧）' },
        })
      }
      if (model === 'veo3.1-components') {
        if (images.length < 1 || images.length > 3) {
          return reply.status(400).send({
            success: false,
            error: { code: 'INVALID_IMAGES', message: 'veo3.1-components 模型需要1-3张参考图片' },
          })
        }
      }
      if (isSeedance && images.length > 2) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_IMAGES', message: 'Seedance 模型首尾帧最多支持2张图片' },
        })
      }
    } else if (model === 'veo3.1-components') {
      return reply.status(400).send({
        success: false,
        error: { code: 'MISSING_IMAGES', message: 'veo3.1-components 模型需要至少1张参考图片' },
      })
    }

    if (reference_images && reference_images.length > 0 && !isSeedance2) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'reference_images 仅支持 Seedance 2.0 系列模型' },
      })
    }
    if ((reference_videos?.length || reference_audios?.length) && !isSeedance2) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'reference_videos / reference_audios 仅支持 Seedance 2.0 系列模型' },
      })
    }

    // Per-model resolution validation
    if (isSeedance && resolution) {
      const isReferenceImageScene = reference_images && reference_images.length > 0
      if (model === 'seedance-2.0-fast' && resolution === '1080p') {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'seedance-2.0-fast 不支持 1080p 分辨率' },
        })
      }
      if (isReferenceImageScene && resolution === '1080p') {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_PARAMS', message: '参考图生视频场景不支持 1080p 分辨率' },
        })
      }
    }

    // Per-model duration validation
    if (isSeedance && duration !== undefined && duration !== -1) {
      const isSeedance15or20 = model === 'seedance-1.5-pro' || isSeedance2
      const minDuration = isSeedance15or20 ? 4 : 2
      const maxDuration = isSeedance2 ? 15 : 12
      if (duration < minDuration || duration > maxDuration) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_PARAMS', message: `${model} 视频时长范围为 ${minDuration}~${maxDuration} 秒（或 -1 自动）` },
        })
      }
    }

    // Audio-only is not allowed; must have at least one image or video
    if (reference_audios && reference_audios.length > 0) {
      const hasMedia = (reference_images && reference_images.length > 0) || (reference_videos && reference_videos.length > 0)
      if (!hasMedia) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_PARAMS', message: '不可单独输入音频，应至少包含 1 个参考视频或图片' },
        })
      }
    }

    // Calculate credits: seedance uses per-second pricing, others use flat rate
    const CREDITS_PER_SECOND = VIDEO_CREDITS_MAP[model] ?? 5
    const videoDuration = isSeedance ? (duration ?? 5) : undefined
    const VIDEO_CREDITS = isSeedance
      ? (videoDuration === -1 ? 15 : videoDuration!) * CREDITS_PER_SECOND
      : VIDEO_CREDITS_MAP[model] ?? 10

    const userId = request.user.id

    // Check pending batch limit
    const pendingCount = await prisma.taskBatch.count({
      where: {
        user_id: userId,
        status: { in: ['pending', 'processing'] },
      },
    })

    if (pendingCount >= 20) {
      return reply.status(429).send({
        success: false,
        error: { code: 'TOO_MANY_PENDING', message: '当前任务队列已满，请等待已有视频生成完成后再提交' },
      })
    }

    // Verify workspace membership
    const wsMember = await prisma.workspaceMember.findFirst({
      where: {
        workspace_id: workspaceId,
        user_id: userId,
      },
      include: {
        workspace: { select: { team_id: true } },
      },
    })

    if (!wsMember && request.user.role !== 'admin') {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: '你不是此工作区的成员' },
      })
    }
    if (wsMember?.role === 'viewer' && request.user.role !== 'admin') {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: '查看者无权生成视频' },
      })
    }

    let teamId: string
    if (wsMember) {
      if (!wsMember.workspace.team_id) {
        return reply.status(400).send({ success: false, error: { code: 'NO_TEAM', message: '工作区未关联团队' } })
      }
      teamId = wsMember.workspace.team_id
    } else {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { team_id: true },
      })
      if (!workspace) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '工作区未找到' } })
      }
      if (!workspace.team_id) {
        return reply.status(400).send({ success: false, error: { code: 'NO_TEAM', message: '工作区未关联团队' } })
      }
      teamId = workspace.team_id
    }

    const teamMember = await prisma.teamMember.findUnique({
      where: {
        team_id_user_id: { team_id: teamId, user_id: userId },
      },
    })

    if (!teamMember) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: '必须是团队成员才能生成视频' },
      })
    }

    // Idempotency: if caller retries with same key, return existing batch directly
    if (idempotencyKey) {
      const existing = await prisma.taskBatch.findFirst({
        where: {
          idempotency_key: idempotencyKey,
          user_id: userId,
          module: 'video',
        },
      })

      if (existing) {
        const tasks = await prisma.task.findMany({
          where: { batch_id: existing.id },
        })

        return reply.send({
          id: existing.id,
          module: existing.module,
          provider: existing.provider,
          model: existing.model,
          prompt: existing.prompt,
          params: {},
          quantity: existing.quantity,
          completed_count: existing.completed_count,
          failed_count: existing.failed_count,
          status: existing.status,
          estimated_credits: existing.estimated_credits,
          actual_credits: existing.actual_credits,
          created_at: String(existing.created_at),
          tasks: tasks.map((t) => ({
            id: t.id,
            version_index: t.version_index,
            status: t.status,
            estimated_credits: t.estimated_credits,
            credits_cost: t.credits_cost,
            error_message: t.error_message,
            processing_started_at: t.processing_started_at?.toISOString?.() ?? t.processing_started_at ?? null,
            completed_at: t.completed_at?.toISOString?.() ?? t.completed_at ?? null,
            asset: null,
          })),
        })
      }
    }

    // Freeze credits
    let creditAccountId: string
    try {
      const result = await freezeCredits(teamId, userId, VIDEO_CREDITS)
      creditAccountId = result.creditAccountId
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Credit error'
      return reply.status(402).send({
        success: false,
        error: { code: 'INSUFFICIENT_CREDITS', message: msg },
      })
    }

    // Create batch + task (status=processing, external_task_id will be set after API call)
    // Wrapped in try-catch: if DB fails after freeze, refund to prevent orphan frozen credits
    let batchId: string
    let taskId: string
    try {
    const _batchTask = await prisma.$transaction(async (tx) => {
      const paramsForDb: Record<string, unknown> = {
        aspect_ratio: aspect_ratio ?? null,
        resolution: resolution ?? null,
        enable_upsample: enable_upsample ?? false,
      }

      if (model === 'veo3.1-components') {
        paramsForDb.has_reference_components = true
        paramsForDb.reference_count = images?.length ?? 0
      } else if (isSeedance) {
        paramsForDb.duration = videoDuration
        paramsForDb.generate_audio = generate_audio ?? true
        paramsForDb.camera_fixed = camera_fixed ?? false
        if (isSeedance2 && reference_images && reference_images.length > 0) {
          paramsForDb.has_reference_images = true
          paramsForDb.reference_count = reference_images.length
        }
        if (isSeedance2 && (reference_videos?.length || reference_audios?.length)) {
          paramsForDb.has_reference_videos = (reference_videos?.length ?? 0) > 0
          paramsForDb.has_reference_audios = (reference_audios?.length ?? 0) > 0
          paramsForDb.reference_video_count = reference_videos?.length ?? 0
          paramsForDb.reference_audio_count = reference_audios?.length ?? 0
        }
        if (images && images.length > 0) {
          paramsForDb.has_first_frame = true
          paramsForDb.has_last_frame = images.length > 1
        }
      } else {
        paramsForDb.has_first_frame = (images?.length ?? 0) > 0
        paramsForDb.has_last_frame = (images?.length ?? 0) > 1
      }

      const provider = isSeedance ? 'volcengine' : 'nano-banana'

      const batchResult = await tx.taskBatch.create({
        data: {
          idempotency_key: idempotencyKey ?? randomUUID(),
          user_id: userId,
          team_id: teamId,
          workspace_id: workspaceId,
          credit_account_id: creditAccountId,
          module: 'video',
          provider,
          model,
          prompt,
          params: JSON.stringify(paramsForDb),
          quantity: 1,
          status: 'processing',
          estimated_credits: VIDEO_CREDITS,
          ...(canvasId ? { canvas_id: canvasId, canvas_node_id: canvasNodeId ?? null } : {}),
          ...(videoStudioProjectId ? { video_studio_project_id: videoStudioProjectId } : {}),
        },
        select: { id: true },
      })

      const taskResult = await tx.task.create({
        data: {
          batch_id: batchResult.id,
          user_id: userId,
          version_index: 0,
          estimated_credits: VIDEO_CREDITS,
          status: 'processing',
          processing_started_at: new Date().toISOString(),
        },
        select: { id: true },
      })

      return { batchId: batchResult.id, taskId: taskResult.id }
    })
    batchId = _batchTask.batchId
    taskId = _batchTask.taskId
    } catch (err) {
      // DB error after freeze — refund to prevent orphan frozen credits
      app.log.error({ err }, 'Failed to create video batch/task after freeze, refunding credits')
      try {
        await refundCredits(teamId, creditAccountId, userId, VIDEO_CREDITS)
      } catch (refundErr) {
        app.log.error({ refundErr }, 'CRITICAL: Failed to refund credits after video batch creation failure')
      }
      return reply.status(500).send({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: '任务创建失败，积分已退回，请重试' },
      })
    }

    // Call API (Veo for nano-banana, Volcengine for seedance)
    let externalTaskId: string
    let lastError: string = ''
    const maxRetries = 1

    if (isSeedance) {
      // Volcengine Seedance API
      const volcengineApiUrl = 'https://ark.cn-beijing.volces.com/api/v3'
      const volcengineApiKey = process.env.VOLCENGINE_API_KEY ?? ''

      const volcengineBody: Record<string, unknown> = {
        model: VOLCENGINE_MODEL_ID[model] ?? model,
        content: [{ type: 'text', text: prompt }],
        duration: videoDuration,
        generate_audio: generate_audio ?? true,
        watermark: watermark ?? false,
      }

      if (resolution) volcengineBody.resolution = resolution

      // camera_fixed not supported in reference image scenes or seedance 2.0 series
      const isReferenceImageScene = reference_images && reference_images.length > 0
      if (camera_fixed !== undefined && !isReferenceImageScene && !isSeedance2) volcengineBody.camera_fixed = camera_fixed

      // 首尾帧图片（frames Tab）：images 字段，role=first_frame/last_frame
      if (images && images.length > 0) {
        images.forEach((img, idx) => {
          const role = idx === 0 ? 'first_frame' : 'last_frame'
          ;(volcengineBody.content as any[]).push({
            type: 'image_url',
            image_url: { url: img },
            role,
          })
        })
      }

      // 参考图（components Tab / multimodal Tab，Seedance 2.0 专用）：role=reference_image
      if (isSeedance2 && reference_images && reference_images.length > 0) {
        reference_images.forEach((img) => {
          ;(volcengineBody.content as any[]).push({
            type: 'image_url',
            image_url: { url: img },
            role: 'reference_image',
          })
        })
      }

      // 参考视频（multimodal Tab，Seedance 2.0 专用）：role=reference_video
      if (isSeedance2 && reference_videos && reference_videos.length > 0) {
        reference_videos.forEach((vid) => {
          ;(volcengineBody.content as any[]).push({
            type: 'video_url',
            video_url: { url: vid },
            role: 'reference_video',
          })
        })
      }

      // 参考音频（multimodal Tab，Seedance 2.0 专用）：role=reference_audio
      if (isSeedance2 && reference_audios && reference_audios.length > 0) {
        reference_audios.forEach((aud) => {
          ;(volcengineBody.content as any[]).push({
            type: 'audio_url',
            audio_url: { url: aud },
            role: 'reference_audio',
          })
        })
      }

      if (aspect_ratio) volcengineBody.ratio = aspect_ratio

      // Seedance 2.0 默认开启联网搜索增强（仅纯文本输入时模型会自主决定是否搜索）
      if (isSeedance2) {
        volcengineBody.tools = [{ type: 'web_search' }]
      }

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30_000)
          let res: Response
          try {
            res = await fetch(`${volcengineApiUrl}/contents/generations/tasks`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${volcengineApiKey}` },
              body: JSON.stringify(volcengineBody),
              signal: controller.signal,
            })
          } finally {
            clearTimeout(timer)
          }

          if (!res.ok) {
            const errText = await res.text()
            throw new Error(`Volcengine API ${res.status}: ${errText}`)
          }

          const json = (await res.json()) as { id: string }
          if (!json.id) throw new Error('Volcengine API did not return task id')
          externalTaskId = json.id
          break
        } catch (err) {
          let errMsg = err instanceof Error ? err.message : String(err)

          // 拦截 Volcengine API 常见的视频分辨率超限错误，给出友好的中文提示
          if (errMsg.includes('video pixel count') || errMsg.includes('must be less than or equal to 927408')) {
            errMsg = '参考视频分辨率过高（限制为 720p 级别，约 92.7 万像素以内），请降低视频分辨率后重试'
          } else if (errMsg.includes('video total duration') && errMsg.includes('15.2')) {
            errMsg = '参考视频总时长超限（所有视频累计时长不超过 15 秒），请删减视频后重试'
          } else if ((errMsg.includes('video duration') || errMsg.includes('audio duration')) && errMsg.includes('15.2')) {
            errMsg = '参考音视频时长过长（最长支持 15 秒），请裁剪后重试'
          } else if (errMsg.includes('video size') && errMsg.includes('52428800')) {
            errMsg = '参考视频文件过大（最大支持 50 MB），请压缩后重试'
          } else if (errMsg.includes('may contain real person') || errMsg.includes('real person')) {
            errMsg = '视频内容可能包含真实人物，不符合平台安全规范，请更换参考素材后重试'
          }

          lastError = errMsg
          const isTimeout = errMsg.includes("aborted") || errMsg.includes("timeout")
          const isHttpError = errMsg.startsWith('Volcengine API ')
          const isNetworkError = errMsg.includes('fetch failed') || errMsg.includes('ECONNREFUSED') ||
                                errMsg.includes('ENOTFOUND') || errMsg.includes('ETIMEDOUT') ||
                                errMsg.includes('ECONNRESET')
          const shouldRetry = !isTimeout && !isHttpError && isNetworkError && attempt < maxRetries
          if (shouldRetry) {
            app.log.warn({ taskId, batchId, attempt: attempt + 1, err: errMsg }, 'Volcengine API call failed, retrying')
            await new Promise(r => setTimeout(r, 2000))
            continue
          }
          app.log.error({ taskId, batchId, err: errMsg }, 'Volcengine API submission failed')
          break
        }
      }
    } else {
      // Nano Banana Veo API (existing logic)
      const veoApiUrl = process.env.NANO_BANANA_API_URL ?? ''
      const veoApiKey = process.env.NANO_BANANA_API_KEY ?? ''

      const veoBody: Record<string, unknown> = {
        prompt,
        model,
        enhance_prompt: true,
      }
      if (images && images.length > 0) veoBody.images = images
      if (aspect_ratio) veoBody.aspect_ratio = aspect_ratio
      if (enable_upsample !== undefined) veoBody.enable_upsample = enable_upsample

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30_000)
          let veoRes: Response
          try {
            veoRes = await fetch(`${veoApiUrl}/v2/videos/generations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${veoApiKey}` },
              body: JSON.stringify(veoBody),
              signal: controller.signal,
            })
          } finally {
            clearTimeout(timer)
          }

          if (!veoRes.ok) {
            const errText = await veoRes.text()
            throw new Error(`Veo API ${veoRes.status}: ${errText}`)
          }

          const veoJson = (await veoRes.json()) as { task_id: string }
          if (!veoJson.task_id) throw new Error('Veo API did not return task_id')
          externalTaskId = veoJson.task_id
          break
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          lastError = errMsg
          const isTimeout = errMsg.includes('aborted') || errMsg.includes('timeout')
          const isHttpError = errMsg.startsWith('Veo API ')
          const isNetworkError = errMsg.includes('fetch failed') || errMsg.includes('ECONNREFUSED') ||
                                errMsg.includes('ENOTFOUND') || errMsg.includes('ETIMEDOUT') ||
                                errMsg.includes('ECONNRESET')
          const shouldRetry = !isTimeout && !isHttpError && isNetworkError && attempt < maxRetries
          if (shouldRetry) {
            app.log.warn({ taskId, batchId, attempt: attempt + 1, err: errMsg }, 'Veo API call failed, retrying')
            await new Promise(r => setTimeout(r, 2000))
            continue
          }
          app.log.error({ taskId, batchId, err: errMsg }, 'Veo API submission failed')
          break
        }
      }
    }

    // If no externalTaskId, fail the task and refund credits
    if (!externalTaskId!) {
      await prisma.$transaction(async (tx) => {
        await tx.task.update({
          where: { id: taskId },
          data: {
            status: 'failed',
            error_message: lastError.slice(0, 1000),
            completed_at: new Date(),
          },
        })

        await tx.taskBatch.update({
          where: { id: batchId },
          data: {
            status: 'failed',
            failed_count: { increment: 1 },
          },
        })

        await tx.creditAccount.update({
          where: { id: creditAccountId },
          data: {
            frozen_credits: { decrement: VIDEO_CREDITS },
          },
        })

        await tx.teamMember.update({
          where: { team_id_user_id: { team_id: teamId, user_id: userId } },
          data: {
            credit_used: { decrement: VIDEO_CREDITS },
          },
        })

        await tx.creditsLedger.create({
          data: {
            credit_account_id: creditAccountId,
            user_id: userId,
            amount: VIDEO_CREDITS,
            type: 'refund',
            task_id: taskId,
            batch_id: batchId,
            description: `Video generation failed to submit: ${lastError.slice(0, 200)}`,
          },
        })
      })

      try {
        await (request.server as any).redis.publish(`sse:batch:${batchId}`, JSON.stringify({ event: 'batch_update' }))
      } catch { /* ignore SSE errors */ }

      return reply.status(502).send({
        success: false,
        error: { code: 'VIDEO_API_ERROR', message: `视频生成服务暂时不可用：${lastError.slice(0, 300)}` },
      })
    }

    // Update task with external_task_id
    await prisma.task.update({
      where: { id: taskId },
      data: { external_task_id: externalTaskId },
    })

    return reply.status(201).send({
      id: batchId,
      module: 'video',
      provider: isSeedance ? 'volcengine' : 'nano-banana',
      model,
      prompt,
      params: {},
      quantity: 1,
      completed_count: 0,
      failed_count: 0,
      status: 'processing',
      estimated_credits: VIDEO_CREDITS,
      actual_credits: 0,
      created_at: new Date().toISOString(),
      tasks: [{
        id: taskId,
        version_index: 0,
        status: 'processing',
        estimated_credits: VIDEO_CREDITS,
        credits_cost: null,
        error_message: null,
        processing_started_at: new Date().toISOString(),
        completed_at: null,
        asset: null,
      }],
    })
  })

  // DELETE /videos/batches/:batchId/cancel — cancel a queued/processing seedance video task
  app.delete<{ Params: { batchId: string } }>('/videos/batches/:batchId/cancel', async (request, reply) => {
    const { batchId } = request.params
    const userId = request.user.id

    const batch = await prisma.taskBatch.findUnique({
      where: { id: batchId },
      select: { id: true, user_id: true, provider: true, status: true, team_id: true, credit_account_id: true },
    })

    if (!batch) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '任务不存在' } })
    if (batch.user_id !== userId && request.user.role !== 'admin') {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '无权操作此任务' } })
    }
    if (batch.provider !== 'volcengine') {
      return reply.status(400).send({ success: false, error: { code: 'NOT_SUPPORTED', message: '仅支持取消 Seedance 视频任务' } })
    }
    if (batch.status !== 'processing' && batch.status !== 'pending') {
      return reply.status(400).send({ success: false, error: { code: 'INVALID_STATE', message: '任务已完成或已取消，无法取消' } })
    }

    const task = await prisma.task.findFirst({
      where: {
        batch_id: batchId,
        status: { in: ['processing', 'pending'] },
      },
      select: { id: true, external_task_id: true, estimated_credits: true, status: true },
    })

    if (!task) return reply.status(400).send({ success: false, error: { code: 'INVALID_STATE', message: '任务已完成或已取消，无法取消' } })

    // Attempt to cancel on Volcengine side (only works for queued tasks; ignore errors)
    if (task.external_task_id) {
      try {
        const volcengineApiKey = process.env.VOLCENGINE_API_KEY ?? ''
        await fetch(`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${task.external_task_id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${volcengineApiKey}` },
          signal: AbortSignal.timeout(10_000),
        })
      } catch { /* best-effort */ }
    }

    // Mark task/batch as failed and refund credits
    await prisma.$transaction(async (tx) => {
      const updated = await tx.task.updateMany({
        where: {
          id: task.id,
          status: { in: ['processing', 'pending'] },
        },
        data: {
          status: 'failed',
          error_message: '用户已取消',
          completed_at: new Date(),
        },
      })

      if (updated.count === 0) return

      await tx.taskBatch.update({
        where: { id: batchId },
        data: {
          status: 'failed',
          failed_count: { increment: 1 },
        },
      })

      if (batch.credit_account_id) {
        await tx.creditAccount.update({
          where: { id: batch.credit_account_id },
          data: {
            frozen_credits: { decrement: task.estimated_credits },
          },
        })
      }

      if (batch.team_id) {
        await tx.teamMember.update({
          where: { team_id_user_id: { team_id: batch.team_id, user_id: userId } },
          data: {
            credit_used: { decrement: task.estimated_credits },
          },
        })
      }

      if (batch.credit_account_id) {
        await tx.creditsLedger.create({
          data: {
            credit_account_id: batch.credit_account_id,
            user_id: userId,
            amount: task.estimated_credits,
            type: 'refund',
            task_id: task.id,
            batch_id: batchId,
            description: '用户取消视频生成',
          },
        })
      }
    })

    try {
      await (request.server as any).redis.publish(`sse:batch:${batchId}`, JSON.stringify({ event: 'batch_update' }))
    } catch { /* ignore SSE errors */ }

    return reply.send({ success: true })
  })

  // ── Concat export ─────────────────────────────────────────────────────────────

  app.post('/videos/concat-export', async (request, reply) => {
    const userId = (request as any).userId as string
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })

    const { segments, projectName } = request.body as {
      segments: Array<{ url: string; inPoint: number; outPoint: number }>
      projectName?: string
    }
    if (!Array.isArray(segments) || segments.length === 0) {
      return reply.status(400).send({ error: 'segments required' })
    }

    const jobId = randomUUID()

    await prisma.concatJob.create({
      data: {
        id: jobId,
        status: 'processing',
        created_at: new Date(),
        updated_at: new Date(),
      },
    })

    concatJobStore.set(jobId, { status: 'processing' })

    // fire-and-forget
    runConcatExport(jobId, segments, projectName ?? 'export', concatJobStore, prisma).catch((err) => {
      app.log.error({ err, jobId }, 'concat-export failed')
    })

    return reply.status(202).send({ jobId })
  })

  app.get('/videos/concat-export/:jobId', async (request, reply) => {
    const userId = (request as any).userId as string
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })

    const { jobId } = request.params as { jobId: string }

    const mem = concatJobStore.get(jobId)
    if (mem) return reply.send(mem)

    const row = await prisma.concatJob.findUnique({
      where: { id: jobId },
      select: { status: true, result_url: true, error: true },
    })

    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send({ status: row.status, resultUrl: row.result_url, error: row.error })
  })
}
