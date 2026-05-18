'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { WizardLayout } from '@/components/video-studio/wizard-layout'
import { StepDescribe } from '@/components/video-studio/step-describe'
import { StepOutline } from '@/components/video-studio/step-outline'
import { StepScript } from '@/components/video-studio/step-script'
import { StepStoryboard } from '@/components/video-studio/step-storyboard'
import { StepCharacters } from '@/components/video-studio/step-characters'
import { StepVideo } from '@/components/video-studio/step-video'
import { StepComplete } from '@/components/video-studio/step-complete'
import { useWizardState, WIZARD_STEP_DEFS } from '@/hooks/video-studio/use-wizard-state'
import { useAuthStore } from '@/stores/auth-store'
import { fetchWithAuth } from '@/lib/api-client'
import { randomUUID } from '@/lib/utils'
import { toast } from 'sonner'
import { createSeriesEpisodes } from '@/lib/video-studio-api'
import type { WizardState, EpisodeState } from '@/hooks/video-studio/use-wizard-state'
import type { AppNode, AppEdge, CanvasNodeType } from '@/lib/canvas/types'

function makeNode(id: string, type: CanvasNodeType, position: { x: number; y: number }, config: Record<string, unknown>): AppNode {
  return {
    id,
    type,
    position,
    data: { type, config, label: '' } as unknown as AppNode['data'],
  }
}

function makeEdge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string): AppEdge {
  return { id, source, target, sourceHandle, targetHandle } as AppEdge
}

function flattenEpisodeShots(wizard: WizardState) {
  return (wizard.fragments?.length ? wizard.fragments : wizard.shots?.length ? [{ id: 'fragment_1', label: '片段1', duration: 0, shots: wizard.shots }] : []).flatMap((fragment) => fragment.shots ?? [])
}

function WizardContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const initialProjectName = searchParams.get('name') ?? '未命名项目'
  const [projectName, setProjectName] = useState(initialProjectName)
  const projectType = (searchParams.get('type') ?? 'single') as 'single' | 'series'
  const episodeCount = Number(searchParams.get('episodes') ?? '1')
  const workspaceId = useAuthStore((s) => s.activeWorkspaceId)

  const [projectId] = useState(() => {
    const existing = searchParams.get('id')
    if (existing) return existing
    return randomUUID()
  })

  useEffect(() => {
    if (!searchParams.get('id')) {
      const params = new URLSearchParams(searchParams.toString())
      params.set('id', projectId)
      router.replace(`/video-studio/wizard?${params.toString()}`)
    }
  }, [projectId, searchParams, router])

  const [serverState, setServerState] = useState<WizardState | null>(null)
  const [serverLoaded, setServerLoaded] = useState(false)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (workspaceId === null || workspaceId === undefined) return
    if (fetchedRef.current) return
    fetchedRef.current = true

    if (!workspaceId) {
      setServerLoaded(true)
      return
    }

    fetchWithAuth<{ wizard_state?: WizardState }>(`/video-studio/projects/${projectId}`)
      .then((project) => {
        if (project?.wizard_state) setServerState(project.wizard_state)
        if ((project as any)?.name) setProjectName((project as any).name)
      })
      .catch(() => {})
      .finally(() => setServerLoaded(true))
  }, [workspaceId, projectId])

  const storageKey = `video-studio:${projectId}`
  const wizard = useWizardState(storageKey, projectId, projectName, serverState)

  const handleVideoComplete = () => {
    wizard.completeStep('video')
  }

  const handleExportToCanvas = async () => {
    if (!workspaceId) { router.push('/video-studio'); return }
    try {
      toast.loading('正在创建画布…', { id: 'canvas-export' })
      const canvas = await fetchWithAuth<{ id: string; version: number }>('/canvases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${projectName} 工作流`, workspace_id: workspaceId }),
      })

      const nodes: AppNode[] = []
      const edges: AppEdge[] = []
      const COL = 320
      const ROW = 220

      // Column 0: description text
      const descNodeId = 'n-desc'
      nodes.push(makeNode(descNodeId, 'text_input', { x: 0, y: 0 }, {
        text: wizard.describeData?.description ?? '',
      }))

      // Column 1: script writer
      const scriptNodeId = 'n-script'
      nodes.push(makeNode(scriptNodeId, 'script_writer', { x: COL, y: 0 }, {
        style: wizard.describeData?.style ?? '',
        duration: wizard.describeData?.duration ?? 60,
        result: wizard.scriptData?.script ?? '',
      }))
      edges.push(makeEdge('e-desc-script', descNodeId, scriptNodeId))

      const activeShots = flattenEpisodeShots(wizard)
      const exportFragments = wizard.fragments.length > 0 ? wizard.fragments : activeShots.length ? [{ id: 'fragment_1', label: '片段1', duration: activeShots.reduce((sum, shot) => sum + (shot.duration || 0), 0), shots: activeShots }] : []

      // Column 2: storyboard splitter
      const sbNodeId = 'n-storyboard'
      nodes.push(makeNode(sbNodeId, 'storyboard_splitter', { x: COL * 2, y: 0 }, {
        shotCount: exportFragments.length,
      }))
      edges.push(makeEdge('e-script-sb', scriptNodeId, sbNodeId))

      // Columns 3-5: per-fragment nodes
      exportFragments.forEach((fragment, i) => {
        const y = i * ROW
        const firstShot = fragment.shots[0]
        const refUrl = firstShot ? (wizard.shotImages[firstShot.id]
          ?? (firstShot.characters?.[0] ? wizard.characterImages[firstShot.characters[0]] : undefined)
          ?? (firstShot.scene ? wizard.sceneImages[firstShot.scene] : undefined)
          ?? '') : ''

        const refNodeId = `n-ref-${fragment.id}`
        nodes.push(makeNode(refNodeId, 'asset', { x: COL * 3, y }, {
          url: refUrl, mimeType: 'image/jpeg',
        }))
        edges.push(makeEdge(`e-sb-ref-${i}`, sbNodeId, refNodeId))

        const vidGenNodeId = `n-vidgen-${fragment.id}`
        nodes.push(makeNode(vidGenNodeId, 'video_gen', { x: COL * 4, y }, {
          prompt: fragment.shots.map((shot) => shot.content).join('\n'),
          model: 'seedance-2.0',
          videoMode: 'multiref',
          aspectRatio: wizard.describeData?.aspectRatio ?? 'adaptive',
          duration: fragment.duration,
          generateAudio: true,
          cameraFixed: false,
          watermark: false,
        }))
        edges.push(makeEdge(`e-ref-vidgen-${i}`, refNodeId, vidGenNodeId))

        const outNodeId = `n-out-${fragment.id}`
        const videoUrl = wizard.shotVideos[fragment.id] ?? ''
        nodes.push(makeNode(outNodeId, 'asset', { x: COL * 5, y }, {
          url: videoUrl, mimeType: 'video/mp4',
        }))
        edges.push(makeEdge(`e-vidgen-out-${i}`, vidGenNodeId, outNodeId))
      })

      await fetchWithAuth(`/canvases/${canvas.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structure_data: { nodes, edges }, version: canvas.version }),
      })

      // Write node outputs for video_gen nodes so videos show as completed
      const outputResults = await Promise.allSettled(
        exportFragments
          .filter((fragment) => wizard.shotVideos[fragment.id])
          .map((fragment) =>
            fetchWithAuth(`/canvases/${canvas.id}/node-outputs/${`n-vidgen-${fragment.id}`}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ output_urls: [wizard.shotVideos[fragment.id]], is_selected: true }),
            })
          )
      )
      const failedOutput = outputResults.find((result) => result.status === 'rejected')
      if (failedOutput) throw failedOutput.reason

      toast.success('画布已创建', { id: 'canvas-export' })
      router.push(`/canvas/editor/${canvas.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建画布失败', { id: 'canvas-export' })
      router.push('/video-studio')
    }
  }

  const handleCreateSeriesEpisodes = async () => {
    if (!workspaceId || !wizard.describeData || !wizard.seriesOutline) return
    try {
      toast.loading('正在创建分集项目…', { id: 'series-episodes' })
      await createSeriesEpisodes(projectId, {
        workspace_id: workspaceId,
        name: projectName,
        describeData: wizard.describeData,
        outline: wizard.seriesOutline,
        characterImages: wizard.characterImages,
        sceneImages: wizard.sceneImages,
        assetStyle: wizard.assetStyle ?? wizard.describeData.style,
      })
      toast.success('分集项目已创建', { id: 'series-episodes' })
      wizard.completeStep('characters')
      router.push(`/video-studio/series/${projectId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建分集项目失败', { id: 'series-episodes' })
    }
  }

  const handleReturnToProjects = () => {
    router.push('/video-studio')
  }

  const handleRenameProject = async (name: string) => {
    await fetchWithAuth(`/video-studio/projects/${projectId}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    setProjectName(name)
    const params = new URLSearchParams(searchParams.toString())
    params.set('name', name)
    router.replace(`/video-studio/wizard?${params.toString()}`)
    toast.success('项目名称已更新')
  }

  if (!serverLoaded) return null

  const activeEpisode = wizard.episodes.find((episode: EpisodeState) => episode.id === wizard.activeEpisodeId)
  const mergedCharacterImages = { ...(wizard.sharedCharacterImages ?? {}), ...wizard.characterImages }
  const mergedSceneImages = { ...(wizard.sharedSceneImages ?? {}), ...wizard.sceneImages }
  const activeShots = flattenEpisodeShots(wizard)
  const activeFragments = wizard.fragments.length > 0 ? wizard.fragments : activeShots.length ? [{ id: 'fragment_1', label: '片段1', duration: activeShots.reduce((sum, shot) => sum + (shot.duration || 0), 0), shots: activeShots }] : []
  const completeItems = activeFragments.map((fragment) => ({
    id: fragment.id,
    label: fragment.label,
    content: fragment.shots.map((shot) => shot.content).join(' / '),
    characters: Array.from(new Set(fragment.shots.flatMap((shot) => shot.characters ?? []))),
    scene: fragment.shots.find((shot) => shot.scene)?.scene,
    cameraMove: Array.from(new Set(fragment.shots.map((shot) => shot.cameraMove).filter(Boolean))).join(' / ') || '固定镜头',
    duration: fragment.duration,
    visualPrompt: fragment.shots.map((shot) => shot.visualPrompt ?? shot.content).join('\n'),
  }))
  const episodeContext = wizard.seriesParentId && ((wizard.sharedCharacters?.length ?? 0) || (wizard.sharedScenes?.length ?? 0)) ? [
    wizard.sharedCharacters?.length ? `可用共享角色：${wizard.sharedCharacters.map((character) => `${character.name}：${character.description}${character.voiceDescription ? `；音色：${character.voiceDescription}` : ''}`).join('；')}` : '',
    wizard.sharedScenes?.length ? `可用共享场景：${wizard.sharedScenes.map((scene) => `${scene.name}：${scene.description}`).join('；')}` : '',
  ].filter(Boolean).join('\n') : undefined

  const headerRight = (
    <Link
      href="/video-studio"
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      返回项目列表
    </Link>
  )

  const visibleSteps = projectType === 'series'
    ? WIZARD_STEP_DEFS
      .filter((step) => ['describe', 'outline', 'characters', 'complete'].includes(step.id))
      .map((step) => step.id === 'characters' ? { ...step, label: '主要人物场景', description: '生成整剧共享参考图' } : step.id === 'complete' ? { ...step, label: '分集制作', description: '进入分集项目列表' } : step)
    : WIZARD_STEP_DEFS.filter((step) => step.id !== 'outline')

  return (
    <div className="flex flex-col h-full overflow-hidden -m-4 md:-m-6">
      <WizardLayout
        statuses={wizard.statuses}
        activeStep={wizard.activeStep}
        onStepClick={wizard.setActiveStep}
        projectName={projectName}
        projectId={projectId}
        onProjectNameChange={handleRenameProject}
        headerRight={headerRight}
        visibleSteps={visibleSteps}
      >
        {wizard.activeStep === 'describe' && (
          <StepDescribe
            initial={wizard.draftDescribeData ?? wizard.describeData}
            projectType={projectType}
            episodeCount={episodeCount}
            onDraftChange={wizard.setDraftDescribeData}
            onComplete={(data) => {
              wizard.setDescribeData(data, projectType)
              wizard.completeStep('describe')
            }}
          />
        )}

        {wizard.activeStep === 'outline' && wizard.describeData && (
          projectType === 'series' ? (
            <StepOutline
              describeData={wizard.describeData}
              episodeCount={episodeCount}
              initial={wizard.seriesOutline}
              activeEpisodeId={wizard.activeEpisodeId}
              onGenerated={wizard.setSeriesOutline}
              onSelectEpisode={wizard.setActiveEpisodeId}
              onComplete={() => wizard.completeStep('outline')}
            />
          ) : null
        )}

        {wizard.activeStep === 'script' && wizard.describeData && (
          <StepScript
            describeData={wizard.describeData}
            episodeContext={episodeContext}
            initial={wizard.scriptData}
            scriptHistory={wizard.scriptHistory ?? []}
            onGenerated={wizard.setScriptData}
            onComplete={(data) => {
              wizard.setScriptData(data)
              wizard.completeStep('script')
            }}
          />
        )}

        {wizard.activeStep === 'storyboard' && wizard.describeData && wizard.scriptData && (
          <StepStoryboard
            describeData={wizard.describeData}
            script={wizard.scriptData.script}
            characters={[...(wizard.sharedCharacters ?? []), ...wizard.scriptData.characters]}
            scenes={[...(wizard.sharedScenes ?? []), ...wizard.scriptData.scenes]}
            initial={wizard.fragments.length > 0 ? wizard.fragments : undefined}
            defaultFragmentCount={wizard.scriptData.actCount}
            onComplete={(fragments) => {
              wizard.setFragments(fragments)
              wizard.completeStep('storyboard')
            }}
          />
        )}

        {wizard.activeStep === 'characters' && wizard.describeData && (
          projectType === 'series' && wizard.seriesOutline ? (
            <StepCharacters
              mode="series-shared"
              scriptData={{
                title: wizard.seriesOutline.title,
                script: wizard.seriesOutline.synopsis,
                characters: wizard.seriesOutline.mainCharacters,
                scenes: wizard.seriesOutline.mainScenes,
              }}
              style={wizard.describeData.style}
              assetStyle={wizard.assetStyle}
              characterImages={wizard.characterImages}
              sceneImages={wizard.sceneImages}
              characterImageHistory={wizard.characterImageHistory ?? {}}
              sceneImageHistory={wizard.sceneImageHistory ?? {}}
              projectId={projectId}
              pendingImageBatches={wizard.pendingImageBatches ?? {}}
              onAddPendingImageBatch={wizard.addPendingImageBatch}
              onClearPendingImageBatch={wizard.clearPendingImageBatch}
              onSelectCharacterImage={wizard.setCharacterImage}
              onSelectSceneImage={wizard.setSceneImage}
              onAssetStyleChange={wizard.setAssetStyle}
              onComplete={handleCreateSeriesEpisodes}
            />
          ) : wizard.scriptData ? (
            <StepCharacters
              mode={wizard.seriesParentId ? 'episode' : 'single'}
              scriptData={wizard.scriptData}
              style={wizard.describeData.style}
              assetStyle={wizard.assetStyle}
              characterImages={mergedCharacterImages}
              sceneImages={mergedSceneImages}
              sharedCharacters={wizard.sharedCharacters ?? []}
              sharedScenes={wizard.sharedScenes ?? []}
              sharedCharacterImages={wizard.sharedCharacterImages ?? {}}
              sharedSceneImages={wizard.sharedSceneImages ?? {}}
              characterImageHistory={wizard.characterImageHistory ?? {}}
              sceneImageHistory={wizard.sceneImageHistory ?? {}}
              projectId={projectId}
              pendingImageBatches={wizard.pendingImageBatches ?? {}}
              onAddPendingImageBatch={wizard.addPendingImageBatch}
              onClearPendingImageBatch={wizard.clearPendingImageBatch}
              onSelectCharacterImage={wizard.setCharacterImage}
              onSelectSceneImage={wizard.setSceneImage}
              onAssetStyleChange={wizard.setAssetStyle}
              onComplete={() => wizard.completeStep('characters')}
            />
          ) : null
        )}

        {wizard.activeStep === 'video' && wizard.describeData && (
          <StepVideo
            fragments={activeFragments}
            shotImages={wizard.shotImages}
            shotVideos={wizard.shotVideos}
            shotVideoHistory={wizard.shotVideoHistory ?? {}}
            describeData={wizard.describeData}
            characters={[...(wizard.sharedCharacters ?? []), ...(wizard.scriptData?.characters ?? [])]}
            characterImages={mergedCharacterImages}
            sceneImages={mergedSceneImages}
            projectId={projectId}
            projectName={projectName}
            pendingVideoBatches={wizard.pendingVideoBatches ?? {}}
            onAddPendingVideoBatch={wizard.addPendingVideoBatch}
            onClearPendingVideoBatch={wizard.clearPendingVideoBatch}
            onVideoReady={wizard.setShotVideo}
            refreshFromServer={wizard.refreshFromServer}
            onComplete={handleVideoComplete}
          />
        )}

        {wizard.activeStep === 'complete' && wizard.describeData && (
          projectType === 'series' ? (
            <div className="flex flex-col items-center justify-center h-full gap-6 text-center p-8">
              <div className="text-5xl">🎬</div>
              <div className="space-y-2">
                <h2 className="text-2xl font-bold">分集项目已创建</h2>
                <p className="text-muted-foreground text-sm">共享人物场景资产已写入每集，点击下方进入分集制作</p>
              </div>
              <button
                onClick={() => router.push(`/video-studio/series/${projectId}`)}
                className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                进入分集制作
              </button>
            </div>
          ) : (
            <StepComplete
              shots={completeItems}
              shotVideos={wizard.shotVideos}
              projectName={projectName}
              onExportToCanvas={handleExportToCanvas}
              onReturn={handleReturnToProjects}
            />
          )
        )}
      </WizardLayout>
    </div>
  )
}

export default function WizardPage() {
  return (
    <Suspense>
      <WizardContent />
    </Suspense>
  )
}
