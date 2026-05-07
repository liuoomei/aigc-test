import type { FastifyInstance } from 'fastify'
import type { Prisma, AssetType } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { signAssetUrl } from '../lib/storage.js'
import { purgeVideoStudioProject, restoreProjectAssets, softDeleteProjectAssets } from '../lib/project-purge.js'

export async function videoStudioRoutes(app: FastifyInstance) {
  const AI_API_URL = process.env.NANO_BANANA_API_URL ?? ''
  const AI_API_KEY = process.env.NANO_BANANA_API_KEY ?? ''
  const AI_MODEL = process.env.GEMINI_MODEL ?? ''
  const SCRIPT_SYSTEM_PROMPT = process.env.AI_PROMPT_STUDIO_SCRIPT ?? ''
  const STORYBOARD_SYSTEM_PROMPT = process.env.AI_PROMPT_STUDIO_STORYBOARD ?? ''
  const ASSET_PROMPT_SYSTEM_PROMPT = process.env.AI_PROMPT_STUDIO_ASSET ?? ''
  const SERIES_OUTLINE_SYSTEM_PROMPT = process.env.AI_PROMPT_STUDIO_SERIES_OUTLINE ?? ''

  async function callLLM(systemPrompt: string, userPrompt: string, maxTokens = 4000): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const res = await fetch(`${AI_API_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          stream: false,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`LLM error ${res.status}`)
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      return data.choices?.[0]?.message?.content ?? ''
    } finally {
      clearTimeout(timer)
    }
  }

  function parseJSON<T>(raw: string): T | null {
    try {
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) return null
      return JSON.parse(m[0]) as T
    } catch {
      return null
    }
  }

  async function assertProjectAccess(projectId: string, userId: string, requireDelete = false) {
    const project = await prisma.videoStudioProject.findFirst({
      where: { id: projectId },
      select: { workspace_id: true, user_id: true },
    })
    if (!project) return null

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: project.workspace_id, user_id: userId },
      select: { role: true },
    })
    if (!member) return null
    if (requireDelete && project.user_id !== userId && member.role !== 'admin') return null
    return { project, member }
  }

  // ── Script write ──────────────────────────────────────────────────────────────

  app.post<{
    Body: { description: string; style: string; duration: number; feedback?: string }
  }>(
    '/video-studio/script-write',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'style', 'duration'],
          properties: {
            description: { type: 'string', maxLength: 3000 },
            style: { type: 'string', maxLength: 200 },
            duration: { type: 'number', minimum: 10, maximum: 600 },
            feedback: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { description, style, duration, feedback } = request.body
      const actCount = Math.ceil(duration / 12)
      let userPrompt = `风格：${style}\n目标时长：${duration}秒\n剧本幕数：${actCount}幕（每幕对应后续一个10-15秒长片段）\n\n故事描述：${description}`
      if (feedback) userPrompt += `\n\n修改意见：${feedback}`

      try {
        const raw = await callLLM(SCRIPT_SYSTEM_PROMPT, userPrompt, 6000)
        type ScriptCharacter = { name: string; description: string; voiceDescription?: string; visualPresence?: boolean }
        type ScriptResult = { title?: string; actCount?: number; script?: string; characters?: ScriptCharacter[]; scenes?: Array<{ name: string; description: string }> }
        const parsed = parseJSON<ScriptResult>(raw)
        return reply.send({
          success: true,
          title: parsed?.title ?? '',
          actCount: parsed?.actCount ?? actCount,
          script: parsed?.script ?? raw,
          characters: parsed?.characters ?? [],
          scenes: parsed?.scenes ?? [],
        })
      } catch (err) {
        app.log.error(err, 'video-studio script-write error')
        return reply.status(502).send({ success: false, error: { code: 'AI_ERROR', message: 'AI服务暂时不可用，请稍后重试' } })
      }
    },
  )

  // ── Storyboard split ──────────────────────────────────────────────────────────

  app.post<{
    Body: {
      script: string
      shotCount?: number
      fragmentCount?: number
      duration?: number
      aspectRatio?: string
      style?: string
      characters?: Array<{ name: string; description: string; voiceDescription?: string; visualPresence?: boolean }>
      scenes?: Array<{ name: string; description: string }>
    }
  }>(
    '/video-studio/storyboard-split',
    {
      schema: {
        body: {
          type: 'object',
          required: ['script'],
          properties: {
            script: { type: 'string', maxLength: 10000 },
            shotCount: { type: 'number', minimum: 0, maximum: 50 },
            fragmentCount: { type: 'number', minimum: 0, maximum: 50 },
            duration: { type: 'number', minimum: 10, maximum: 600 },
            aspectRatio: { type: 'string' },
            style: { type: 'string', maxLength: 200 },
            characters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, voiceDescription: { type: 'string' } } } },
            scenes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } } },
          },
        },
      },
    },
    async (request, reply) => {
      const { script, shotCount = 0, fragmentCount, duration, aspectRatio, style, characters, scenes } = request.body
      const targetFragmentCount = fragmentCount ?? (duration ? Math.ceil(duration / 12) : shotCount > 0 ? Math.ceil(shotCount / 2) : 0)
      const countInstruction = targetFragmentCount > 0 ? `拆分成恰好 ${targetFragmentCount} 个长片段，每个片段 10-15 秒且包含 1-3 个分镜` : '根据剧本内容自动决定片段数量（每个片段10-15秒，每个片段1-3个分镜）'
      const ratioNote = aspectRatio ? `\n画面比例：${aspectRatio}` : ''
      const styleNote = style ? `\n整体视觉风格：${style}` : ''
      const charList = characters?.length ? `\n\n可用角色列表（characters 字段只能从这里选取名字；有台词时使用【角色名音色】占位符引用对应 voiceDescription）：\n${characters.map(c => `- ${c.name}：${c.description}${c.voiceDescription ? `；音色：${c.voiceDescription}` : ''}`).join('\n')}` : ''
      const sceneList = scenes?.length ? `\n\n可用场景列表（scene 字段只能从这里选取名字）：\n${scenes.map(s => `- ${s.name}：${s.description}`).join('\n')}` : ''
      const userPrompt = `请将以下剧本${countInstruction}${ratioNote}${styleNote}${charList}${sceneList}。\n\n每个片段必须填写 transition 和 duration；每个分镜必须填写 characters、scene、duration、content 和 visualPrompt。content 必须与 visualPrompt 保持一致或高度一致。详细景别、角度、构图、焦点变化和运镜过程必须写进 visualPrompt。台词直接写在 visualPrompt 里；有台词时，台词后写“【角色名音色】语气：...”。\n\n剧本：\n\n${script}`

      try {
        const raw = await callLLM(STORYBOARD_SYSTEM_PROMPT, userPrompt, 8000)
        type ShotRaw = { id: string; label: string; content: string; characters?: string[]; scene?: string; duration: number; visualPrompt?: string }
        type FragmentRaw = { id: string; label: string; duration: number; transition?: string; shots: ShotRaw[] }
        type StoryboardResult = { fragments?: FragmentRaw[]; shots?: ShotRaw[] }
        const parsed = parseJSON<StoryboardResult>(raw)
        const fragments = parsed?.fragments ?? (parsed?.shots ? [{ id: 'fragment_1', label: '片段1', duration: parsed.shots.reduce((sum, shot) => sum + (shot.duration || 0), 0), shots: parsed.shots }] : [])
        return reply.send({ success: true, fragments, shots: fragments.flatMap((fragment) => fragment.shots ?? []) })
      } catch (err) {
        app.log.error(err, 'video-studio storyboard-split error')
        return reply.status(502).send({ success: false, error: { code: 'AI_ERROR', message: 'AI服务暂时不可用，请稍后重试' } })
      }
    },
  )

  // ── Asset prompts ─────────────────────────────────────────────────────────────

  app.post<{
    Body: {
      characters: Array<{ name: string; description: string }>
      scenes: Array<{ name: string; description: string }>
      style: string
    }
  }>(
    '/video-studio/asset-prompts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['characters', 'scenes', 'style'],
          properties: {
            characters: { type: 'array', items: { type: 'object' } },
            scenes: { type: 'array', items: { type: 'object' } },
            style: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { characters, scenes, style } = request.body
      const charList = characters.map((c) => `- ${c.name}：${c.description}`).join('\n')
      const sceneList = scenes.map((s) => `- ${s.name}：${s.description}`).join('\n')
      const userPrompt = `整体风格：${style}\n\n角色列表：\n${charList}\n\n场景列表：\n${sceneList}`

      try {
        const raw = await callLLM(ASSET_PROMPT_SYSTEM_PROMPT, userPrompt, 4000)
        type AssetResult = { styleAnchor?: string; characters?: Array<{ name: string; prompt: string }>; scenes?: Array<{ name: string; prompt: string }> }
        const parsed = parseJSON<AssetResult>(raw)
        return reply.send({
          success: true,
          styleAnchor: parsed?.styleAnchor ?? '',
          characters: parsed?.characters ?? [],
          scenes: parsed?.scenes ?? [],
        })
      } catch (err) {
        app.log.error(err, 'video-studio asset-prompts error')
        return reply.status(502).send({ success: false, error: { code: 'AI_ERROR', message: 'AI服务暂时不可用，请稍后重试' } })
      }
    },
  )

  // ── Series outline ────────────────────────────────────────────────────────────

  app.post<{
    Body: { description: string; style: string; episodeCount: number; episodeDuration: number }
  }>(
    '/video-studio/series-outline',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'style', 'episodeCount', 'episodeDuration'],
          properties: {
            description: { type: 'string', maxLength: 3000 },
            style: { type: 'string', maxLength: 200 },
            episodeCount: { type: 'number', minimum: 2, maximum: 50 },
            episodeDuration: { type: 'number', minimum: 10, maximum: 600 },
          },
        },
      },
    },
    async (request, reply) => {
      const { description, style, episodeCount, episodeDuration } = request.body
      const userPrompt = `风格：${style}\n集数：${episodeCount}集，每集约${episodeDuration}秒\n\n故事描述：${description}`

      try {
        const raw = await callLLM(SERIES_OUTLINE_SYSTEM_PROMPT, userPrompt, 6000)
        type SeriesCharacter = { name: string; description: string; voiceDescription?: string }
        type SeriesEpisode = { id: string; title: string; synopsis: string; coreConflict?: string; hook?: string }
        type SeriesScene = { name: string; description: string }
        type SeriesRelationship = { from: string; to: string; description: string }
        type SeriesResult = { title?: string; synopsis?: string; worldbuilding?: string; mainCharacters?: SeriesCharacter[]; mainScenes?: SeriesScene[]; relationships?: SeriesRelationship[]; episodes?: SeriesEpisode[] }
        const parsed = parseJSON<SeriesResult>(raw)
        return reply.send({
          success: true,
          title: parsed?.title ?? '',
          synopsis: parsed?.synopsis ?? '',
          worldbuilding: parsed?.worldbuilding ?? '',
          mainCharacters: parsed?.mainCharacters ?? [],
          mainScenes: parsed?.mainScenes ?? [],
          relationships: parsed?.relationships ?? [],
          episodes: parsed?.episodes ?? [],
        })
      } catch (err) {
        app.log.error(err, 'video-studio series-outline error')
        return reply.status(502).send({ success: false, error: { code: 'AI_ERROR', message: 'AI服务暂时不可用，请稍后重试' } })
      }
    },
  )

  // ── Project CRUD ──────────────────────────────────────────────────────────────

  // GET /video-studio/projects?workspace_id=...
  app.get<{ Querystring: { workspace_id: string } }>(
    '/video-studio/projects',
    async (request, reply) => {
      const userId = request.user.id
      const { workspace_id } = request.query
      if (!workspace_id) return reply.status(400).send({ error: 'workspace_id required' })

      const member = await prisma.workspaceMember.findFirst({
        where: { workspace_id, user_id: userId },
        select: { role: true },
      })
      if (!member) return reply.status(403).send({ error: 'forbidden' })

      // 管理员可见所有项目，普通成员只能看自己的
      const projects = await prisma.videoStudioProject.findMany({
        where: {
          workspace_id,
          is_deleted: false,
          series_parent_id: null,
          ...(member.role === 'admin' ? {} : { user_id: userId }),
        },
        select: { id: true, name: true, created_at: true, updated_at: true },
        orderBy: { updated_at: 'desc' },
      })

      return reply.send(projects)
    },
  )

  // GET /video-studio/projects/:id
  app.get<{ Params: { id: string } }>(
    '/video-studio/projects/:id',
    async (request, reply) => {
      const userId = request.user.id
      const { id } = request.params

      const project = await prisma.videoStudioProject.findFirst({
        where: { id, is_deleted: false },
      })

      if (!project) return reply.status(404).send({ error: 'not found' })
      const member = await prisma.workspaceMember.findFirst({
        where: { workspace_id: project.workspace_id, user_id: userId },
        select: { workspace_id: true },
      })
      if (!member) return reply.status(403).send({ error: 'forbidden' })

      const wizardState = project.wizard_state as Record<string, unknown> | null
      if (wizardState) {
        const resign = async (urlMap: unknown): Promise<Record<string, string>> => {
          if (!urlMap || typeof urlMap !== 'object') return {}
          const result: Record<string, string> = {}
          await Promise.all(Object.entries(urlMap as Record<string, string>).map(async ([k, v]) => {
            result[k] = (await signAssetUrl(v)) ?? v
          }))
          return result
        }
        const resignHistory = async (historyMap: unknown): Promise<Record<string, string[]>> => {
          if (!historyMap || typeof historyMap !== 'object') return {}
          const result: Record<string, string[]> = {}
          await Promise.all(Object.entries(historyMap as Record<string, string[]>).map(async ([k, urls]) => {
            result[k] = await Promise.all((urls ?? []).map(async (v) => (await signAssetUrl(v)) ?? v))
          }))
          return result
        }
        const resignNestedHistory = async (historyMap: unknown): Promise<Record<string, string[][]>> => {
          if (!historyMap || typeof historyMap !== 'object') return {}
          const result: Record<string, string[][]> = {}
          await Promise.all(Object.entries(historyMap as Record<string, string[][]>).map(async ([k, batches]) => {
            result[k] = await Promise.all((batches ?? []).map(async (urls) => Promise.all((urls ?? []).map(async (v) => (await signAssetUrl(v)) ?? v))))
          }))
          return result
        }
        const [characterImages, sceneImages, shotImages, shotVideos, shotVideoHistory, characterImageHistory, sceneImageHistory, sharedCharacterImages, sharedSceneImages] = await Promise.all([
          resign(wizardState.characterImages),
          resign(wizardState.sceneImages),
          resign(wizardState.shotImages),
          resign(wizardState.shotVideos),
          resignHistory(wizardState.shotVideoHistory),
          resignNestedHistory(wizardState.characterImageHistory),
          resignNestedHistory(wizardState.sceneImageHistory),
          resign(wizardState.sharedCharacterImages),
          resign(wizardState.sharedSceneImages),
        ])
        return reply.send({
          ...project,
          wizard_state: { ...wizardState, characterImages, sceneImages, shotImages, shotVideos, shotVideoHistory, characterImageHistory, sceneImageHistory, sharedCharacterImages, sharedSceneImages },
        })
      }

      return reply.send(project)
    },
  )

  // PUT /video-studio/projects/:id — upsert (create or update)
  app.put<{
    Params: { id: string }
    Body: { workspace_id: string; name: string; wizard_state: unknown; project_type?: 'single' | 'series' | 'episode'; series_parent_id?: string | null; episode_index?: number | null }
  }>(
    '/video-studio/projects/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['workspace_id', 'name', 'wizard_state'],
          properties: {
            workspace_id: { type: 'string' },
            name: { type: 'string', maxLength: 200 },
            wizard_state: { type: 'object' },
            project_type: { type: 'string', enum: ['single', 'series', 'episode'] },
            series_parent_id: { type: ['string', 'null'] },
            episode_index: { type: ['number', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id
      const { id } = request.params
      const { workspace_id, name, wizard_state, project_type = 'single', series_parent_id = null, episode_index = null } = request.body

      const member = await prisma.workspaceMember.findFirst({
        where: { workspace_id, user_id: userId },
        select: { workspace_id: true },
      })
      if (!member) return reply.status(403).send({ error: 'forbidden' })

      const existing = await prisma.videoStudioProject.findFirst({
        where: { id },
        select: { workspace_id: true, is_deleted: true },
      })
      if (existing?.is_deleted) return reply.status(404).send({ error: 'not found' })
      if (existing) {
        const access = await assertProjectAccess(id, userId, true)
        if (!access) return reply.status(404).send({ error: 'not found' })
        if (existing.workspace_id !== workspace_id) return reply.status(400).send({ error: 'workspace mismatch' })
      }

      if (series_parent_id) {
        const parent = await prisma.videoStudioProject.findFirst({
          where: { id: series_parent_id, workspace_id, is_deleted: false },
          select: { workspace_id: true },
        })
        if (!parent) return reply.status(400).send({ error: 'series parent not found' })
        const parentAccess = await assertProjectAccess(series_parent_id, userId, true)
        if (!parentAccess) return reply.status(404).send({ error: 'not found' })
      }

      await prisma.videoStudioProject.upsert({
        where: { id },
        create: {
          id,
          workspace_id,
          user_id: userId,
          name,
          wizard_state: wizard_state as Prisma.InputJsonValue,
          project_type,
          series_parent_id,
          episode_index,
        },
        update: {
          name,
          wizard_state: wizard_state as Prisma.InputJsonValue,
          project_type,
          series_parent_id,
          episode_index,
          updated_at: new Date(),
        },
      })

      return reply.send({ success: true })
    },
  )

  // POST /video-studio/projects/:id/series/episodes
  app.post<{
    Params: { id: string }
    Body: {
      workspace_id: string
      name: string
      describeData: { description: string; style: string; duration: number; aspectRatio: string }
      outline: {
        title: string
        synopsis: string
        worldbuilding?: string
        mainCharacters?: Array<{ name: string; description: string; voiceDescription?: string }>
        mainScenes?: Array<{ name: string; description: string }>
        relationships?: Array<{ from: string; to: string; description: string }>
        episodes: Array<{ id: string; title: string; synopsis: string; coreConflict?: string; hook?: string }>
      }
      characterImages: Record<string, string>
      sceneImages: Record<string, string>
    }
  }>('/video-studio/projects/:id/series/episodes', async (request, reply) => {
    const userId = request.user.id
    const { id } = request.params
    const { workspace_id, name, describeData, outline, characterImages, sceneImages } = request.body

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id, user_id: userId },
      select: { workspace_id: true },
    })
    if (!member) return reply.status(403).send({ error: 'forbidden' })
    if (!outline?.episodes?.length) return reply.status(400).send({ error: 'episodes required' })

    const parentState = {
      statuses: { describe: 'completed', outline: 'completed', script: 'locked', storyboard: 'locked', characters: 'completed', video: 'locked', complete: 'pending' },
      activeStep: 'complete',
      projectType: 'series',
      seriesOutline: outline,
      activeEpisodeId: null,
      episodes: [],
      describeData,
      draftDescribeData: describeData,
      scriptData: null,
      scriptHistory: [],
      shots: [],
      fragments: [],
      shotImages: {},
      characterImages,
      sceneImages,
      characterImageHistory: {},
      sceneImageHistory: {},
      shotVideos: {},
      pendingImageBatches: {},
      pendingVideoBatches: {},
    }

    const episodes = await prisma.$transaction(async (trx) => {
      await trx.videoStudioProject.upsert({
        where: { id },
        create: {
          id,
          workspace_id,
          user_id: userId,
          name: outline.title || name,
          wizard_state: parentState as Prisma.InputJsonValue,
          project_type: 'series',
          series_parent_id: null,
          episode_index: null,
        },
        update: {
          name: outline.title || name,
          wizard_state: parentState as Prisma.InputJsonValue,
          project_type: 'series',
          series_parent_id: null,
          episode_index: null,
          updated_at: new Date(),
        },
      })

      await trx.videoStudioProject.updateMany({
        where: { series_parent_id: id, is_deleted: false },
        data: { is_deleted: true, deleted_at: new Date(), updated_at: new Date() },
      })

      const rows = [] as Array<{ id: string; name: string; episode_index: number; wizard_state: unknown }>
      for (const [index, episode] of outline.episodes.entries()) {
        const episodeId = crypto.randomUUID()
        // Episode description: only this episode's story + minimal context (no full worldbuilding/character list)
        const episodeDescription = [
          `本集标题：${episode.title}`,
          `本集梗概：${episode.synopsis}`,
          episode.coreConflict ? `本集核心冲突：${episode.coreConflict}` : '',
          episode.hook ? `本集结尾钩子：${episode.hook}` : '',
        ].filter(Boolean).join('\n')
        const episodeDescribeData = { ...describeData, description: episodeDescription }
        const wizardState = {
          statuses: { describe: 'completed', outline: 'locked', script: 'pending', storyboard: 'locked', characters: 'locked', video: 'locked', complete: 'locked' },
          activeStep: 'script',
          projectType: 'single',
          seriesParentId: id,
          episodeIndex: index + 1,
          sharedCharacters: outline.mainCharacters ?? [],
          sharedScenes: outline.mainScenes ?? [],
          sharedCharacterImages: characterImages,
          sharedSceneImages: sceneImages,
          seriesOutline: null,
          activeEpisodeId: null,
          episodes: [],
          describeData: episodeDescribeData,
          draftDescribeData: episodeDescribeData,
          scriptData: null,
          scriptHistory: [],
          shots: [],
          fragments: [],
          shotImages: {},
          characterImages: {},
          sceneImages: {},
          characterImageHistory: {},
          sceneImageHistory: {},
          shotVideos: {},
          pendingImageBatches: {},
          pendingVideoBatches: {},
        }
        const episodeName = `第 ${index + 1} 集：${episode.title}`
        await trx.videoStudioProject.create({
          data: {
            id: episodeId,
            workspace_id,
            user_id: userId,
            name: episodeName,
            wizard_state: wizardState as Prisma.InputJsonValue,
            project_type: 'episode',
            series_parent_id: id,
            episode_index: index + 1,
          },
        })
        rows.push({ id: episodeId, name: episodeName, episode_index: index + 1, wizard_state: wizardState })
      }
      return rows
    })

    return reply.send({ success: true, episodes })
  })

  // GET /video-studio/projects/:id/episodes
  app.get<{ Params: { id: string } }>('/video-studio/projects/:id/episodes', async (request, reply) => {
    const access = await assertProjectAccess(request.params.id, request.user.id)
    if (!access) return reply.status(404).send({ error: 'not found' })

    const episodes = await prisma.videoStudioProject.findMany({
      where: { series_parent_id: request.params.id, is_deleted: false },
      select: { id: true, name: true, created_at: true, updated_at: true, project_type: true, series_parent_id: true, episode_index: true, wizard_state: true },
      orderBy: { episode_index: 'asc' },
    })

    return reply.send(episodes)
  })

  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; cursor?: string }
  }>('/video-studio/projects/:id/history', async (request, reply) => {
    const { id } = request.params
    const limitN = Math.min(parseInt(request.query.limit ?? '30', 10) || 30, 100)
    const cursor = request.query.cursor

    const access = await assertProjectAccess(id, request.user.id)
    if (!access) return reply.status(404).send({ error: 'not found' })

    let decodedCursor: { created_at: string; id: string } | null = null
    if (cursor) {
      try { decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) }
      catch { return reply.badRequest('Invalid cursor') }
    }

    const rows = await prisma.taskBatch.findMany({
      where: {
        video_studio_project_id: id,
        is_deleted: false,
        ...(decodedCursor ? {
          OR: [
            { created_at: { lt: new Date(decodedCursor.created_at) } },
            { created_at: new Date(decodedCursor.created_at), id: { lt: decodedCursor.id } },
          ],
        } : {}),
      },
      select: { id: true, model: true, prompt: true, quantity: true, completed_count: true, failed_count: true, status: true, actual_credits: true, created_at: true, module: true, provider: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limitN + 1,
    })

    const hasMore = rows.length > limitN
    const items = await Promise.all((hasMore ? rows.slice(0, limitN) : rows).map(async (batch) => {
      const queuePosition = batch.status === 'pending'
        ? await prisma.taskBatch.count({
            where: {
              is_deleted: false,
              status: 'pending',
              provider: batch.provider,
              created_at: { lt: batch.created_at },
            },
          })
        : null
      const processing = await prisma.task.findFirst({
        where: { batch_id: batch.id, processing_started_at: { not: null } },
        select: { processing_started_at: true },
        orderBy: { processing_started_at: 'asc' },
      })
      const { provider: _provider, ...item } = batch
      return { ...item, canvas_node_id: null, queue_position: queuePosition, processing_started_at: processing?.processing_started_at ?? null }
    }))

    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ created_at: items[items.length - 1].created_at, id: items[items.length - 1].id })).toString('base64')
      : null

    return reply.send({ items, nextCursor })
  })

  // GET /video-studio/projects/:id/assets
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; cursor?: string; type?: string }
  }>('/video-studio/projects/:id/assets', async (request, reply) => {
    const { id } = request.params
    const limitN = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200)
    const cursor = request.query.cursor
    const type = request.query.type

    const access = await assertProjectAccess(id, request.user.id)
    if (!access) return reply.status(404).send({ error: 'not found' })

    let decodedCursor: { created_at: string; id: string } | null = null
    if (cursor) {
      try { decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) }
      catch { return reply.badRequest('Invalid cursor') }
    }

    const rows = await prisma.asset.findMany({
      where: {
        is_deleted: false,
        batch: { video_studio_project_id: id },
        ...(type ? { type: type as AssetType } : {}),
        OR: [
          { transfer_status: 'completed' },
          { original_url: { not: null } },
        ],
        ...(decodedCursor ? {
          AND: [
            {
              OR: [
                { created_at: { lt: new Date(decodedCursor.created_at) } },
                { created_at: new Date(decodedCursor.created_at), id: { lt: decodedCursor.id } },
              ],
            },
          ],
        } : {}),
      },
      include: {
        batch: { select: { id: true, prompt: true, model: true } },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limitN + 1,
    })

    const hasMore = rows.length > limitN
    const items = hasMore ? rows.slice(0, limitN) : rows
    const signedItems = await Promise.all(items.map(async (item) => ({
      id: item.id,
      type: item.type,
      storage_url: await signAssetUrl(item.storage_url),
      original_url: item.original_url ? await signAssetUrl(item.original_url) : null,
      created_at: item.created_at,
      batch_id: item.batch?.id ?? null,
      prompt: item.batch?.prompt ?? null,
      model: item.batch?.model ?? null,
      canvas_node_id: null,
    })))

    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ created_at: items[items.length - 1].created_at, id: items[items.length - 1].id })).toString('base64')
      : null

    return reply.send({ items: signedItems, nextCursor })
  })

  // PATCH /video-studio/projects/:id/name
  app.patch<{
    Params: { id: string }
    Body: { name: string }
  }>(
    '/video-studio/projects/:id/name',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim()
      if (!name) return reply.status(400).send({ error: 'name required' })

      const access = await assertProjectAccess(request.params.id, request.user.id, true)
      if (!access) return reply.status(404).send({ error: 'not found' })

      await prisma.videoStudioProject.updateMany({
        where: { id: request.params.id, is_deleted: false },
        data: { name, updated_at: new Date() },
      })

      return reply.send({ success: true, name })
    },
  )

  // DELETE /video-studio/projects/:id
  app.delete<{ Params: { id: string } }>(
    '/video-studio/projects/:id',
    async (request, reply) => {
      const access = await assertProjectAccess(request.params.id, request.user.id, true)
      if (!access) return reply.status(404).send({ error: 'not found' })

      await prisma.videoStudioProject.updateMany({
        where: { id: request.params.id, is_deleted: false },
        data: { is_deleted: true, deleted_at: new Date(), updated_at: new Date() },
      })
      await softDeleteProjectAssets('video_studio_project_id', request.params.id)

      return reply.send({ success: true })
    },
  )

  // GET /video-studio/projects/trash
  app.get<{ Querystring: { workspace_id: string } }>('/video-studio/projects/trash', async (request, reply) => {
    const userId = request.user.id
    const { workspace_id } = request.query
    if (!workspace_id) return reply.status(400).send({ error: 'workspace_id required' })

    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id, user_id: userId },
      select: { role: true },
    })
    if (!member) return reply.status(403).send({ error: 'forbidden' })

    const projects = await prisma.videoStudioProject.findMany({
      where: {
        workspace_id,
        is_deleted: true,
        ...(member.role === 'admin' ? {} : { user_id: userId }),
      },
      select: { id: true, name: true, created_at: true, updated_at: true, deleted_at: true, user_id: true, workspace_id: true },
      orderBy: { deleted_at: 'desc' },
    })

    return reply.send(projects)
  })

  // POST /video-studio/projects/:id/restore
  app.post<{ Params: { id: string } }>('/video-studio/projects/:id/restore', async (request, reply) => {
    const access = await assertProjectAccess(request.params.id, request.user.id, true)
    if (!access) return reply.status(404).send({ error: 'not found' })

    await prisma.videoStudioProject.updateMany({
      where: { id: request.params.id, is_deleted: true },
      data: { is_deleted: false, deleted_at: null, updated_at: new Date() },
    })
    await restoreProjectAssets('video_studio_project_id', request.params.id)

    return reply.send({ success: true })
  })

  // DELETE /video-studio/projects/:id/permanent
  app.delete<{ Params: { id: string } }>('/video-studio/projects/:id/permanent', async (request, reply) => {
    const access = await assertProjectAccess(request.params.id, request.user.id, true)
    if (!access) return reply.status(404).send({ error: 'not found' })

    await purgeVideoStudioProject(prisma, request.params.id)
    return reply.send({ success: true })
  })
}
