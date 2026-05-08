'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { randomUUID } from '@/lib/utils'
import { useCanvasStructureStore } from '@/stores/canvas/structure-store'
import { useCanvasExecutionStore } from '@/stores/canvas/execution-store'
import { useAuthStore } from '@/stores/auth-store'
import { isAssetConfig, isImageGenConfig, isVideoGenConfig, isScriptWriterConfig, isStoryboardSplitterConfig } from '@/lib/canvas/types'
import { callCanvasAgent } from '@/lib/canvas/agent-api'
import {
  parseAgentResponse,
  type AgentPhase,
  type AgentMessage,
  type AgentInstruction,
  type AgentWorkflow,
  type AgentStep,
  type StepParams,
  type CanvasNodeSummary,
} from '@/lib/canvas/agent-types'
import {
  loadCanvasAgentSession,
  saveCanvasAgentSession,
  clearCanvasAgentSession,
} from './use-canvas-agent-history'
import {
  executeCanvasNode,
  executeVideoNode,
  executeScriptWriterNode,
  executeStoryboardSplitterNode,
  CanvasApiError,
} from '@/lib/canvas/canvas-api'
import {
  IMAGE_MODEL_CREDITS,
  VIDEO_PER_SECOND_CREDITS,
  VIDEO_FLAT_CREDITS,
} from '@/lib/credits'
import { MODEL_CODE_MAP } from '@/components/canvas/panels/panel-constants'
import { mutate } from 'swr'

// ── Canvas context builder ───────────────────────────────────────────────────

function summarizeConfig(type: string, config: any): string {
  if (type === 'text_input') return `"${config.text?.slice(0, 60) ?? ''}"`
  if (type === 'image_gen') return `model:${config.modelType}, prompt:"${config.prompt?.slice(0, 40) ?? ''}"`
  if (type === 'video_gen') return `model:${config.model}, mode:${config.videoMode}`
  if (type === 'asset') return `file:${config.name ?? config.url?.split('/').pop() ?? ''}, mime:${config.mimeType ?? ''}`
  return ''
}

function buildCanvasContext() {
  const { nodes, edges } = useCanvasStructureStore.getState()
  const execState = useCanvasExecutionStore.getState().nodes
  return {
    nodes: nodes.map((n): CanvasNodeSummary => ({
      id: n.id,
      type: n.type ?? '',
      label: n.data.label,
      configSummary: summarizeConfig(n.type ?? '', n.data.config),
      hasOutput: (execState[n.id]?.outputs.length ?? 0) > 0,
      selectedOutputId: execState[n.id]?.selectedOutputId ?? null,
    })),
    edges: edges.map((e) => ({ source: e.source, target: e.target })),
  }
}

// ── Multimodal content builder ───────────────────────────────────────────────

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function buildUserContent(
  rawText: string,
  implicitNodeId?: string,
): string | ContentPart[] {
  const nodes = useCanvasStructureStore.getState().nodes
  const execNodes = useCanvasExecutionStore.getState().nodes

  const TOKEN_RE = /@\[([^\]|]+)\|([^\]]+)\]/g
  const parts: ContentPart[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let hasMedia = false

  const appendNodeMedia = (nodeId: string, label: string) => {
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return

    if (node.type === 'image_gen') {
      const execState = execNodes[nodeId]
      const output = execState?.outputs.find((o) => o.id === execState.selectedOutputId)
      if (output?.url) {
        parts.push({ type: 'image_url', image_url: { url: output.url } })
        parts.push({ type: 'text', text: `[图片节点「${label}」]` })
        hasMedia = true
      }
    } else if (node.type === 'asset' && isAssetConfig(node.data.config)) {
      const { url, mimeType, name } = node.data.config
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } })
        const mediaLabel = mimeType?.startsWith('video') ? '视频' : mimeType?.startsWith('audio') ? '音频' : '图片'
        parts.push({ type: 'text', text: `[${mediaLabel}素材「${name ?? label}」]` })
        hasMedia = true
      }
    } else if (node.type === 'text_input') {
      parts.push({ type: 'text', text: `[文本节点「${label}」：${(node.data.config as any).text ?? ''}]` })
    } else if (node.type === 'script_writer') {
      const script = (execNodes[nodeId]?.outputs[0]?.paramsSnapshot as { script?: string } | undefined)?.script
      if (script) {
        parts.push({ type: 'text', text: `[剧本节点「${label}」：${script.slice(0, 200)}${script.length > 200 ? '…' : ''}]` })
      } else {
        parts.push({ type: 'text', text: `[剧本节点「${label}」：尚未生成]` })
      }
    } else if (node.type === 'video_gen') {
      const execState = execNodes[nodeId]
      const output = execState?.outputs.find((o) => o.id === execState.selectedOutputId)
      if (output?.url) {
        parts.push({ type: 'image_url', image_url: { url: output.url } })
        parts.push({ type: 'text', text: `[视频节点「${label}」]` })
        hasMedia = true
      }
    }
  }

  while ((match = TOKEN_RE.exec(rawText)) !== null) {
    const before = rawText.slice(lastIndex, match.index)
    if (before) parts.push({ type: 'text', text: before })
    lastIndex = TOKEN_RE.lastIndex
    appendNodeMedia(match[2], match[1])
  }

  const tail = rawText.slice(lastIndex)
  if (tail) parts.push({ type: 'text', text: tail })

  // Append implicit node context at the end
  if (implicitNodeId) {
    const node = nodes.find((n) => n.id === implicitNodeId)
    if (node) appendNodeMedia(implicitNodeId, node.data.label)
  }

  if (!hasMedia && !implicitNodeId) return rawText
  return parts.length > 0 ? parts : rawText
}

// ── Credit estimator ─────────────────────────────────────────────────────────

export function estimateStepCredits(step: AgentStep, params: StepParams): number {
  const nodes = useCanvasStructureStore.getState().nodes
  return step.nodeIds.reduce((total, id) => {
    const node = nodes.find((n) => n.id === id)
    if (!node) return total
    if (node.type === 'image_gen' && isImageGenConfig(node.data.config)) {
      const credits = IMAGE_MODEL_CREDITS[params.modelType ?? 'gemini'] ?? 5
      return total + credits * (node.data.config.quantity ?? 1)
    }
    if (node.type === 'video_gen') {
      const model = params.videoModel ?? 'seedance-2.0'
      const perSec = VIDEO_PER_SECOND_CREDITS[model]
      if (perSec !== undefined) return total + perSec * (params.duration ?? 5)
      const flat = VIDEO_FLAT_CREDITS[model]
      if (flat !== undefined) return total + flat
      return total + 5 * (params.duration ?? 5)
    }
    return total
  }, 0)
}

// ── Node executor (for batch run) ────────────────────────────────────────────

async function executeNode(
  nodeId: string,
  canvasId: string,
  workspaceId: string | null,
  params: StepParams,
  token: string | null,
): Promise<void> {
  const { nodes, edges } = useCanvasStructureStore.getState()
  const execStore = useCanvasExecutionStore.getState()
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return

  execStore.setNodeStatus(nodeId, 'pending', { progress: 0 })

  try {
    if (node.type === 'image_gen' && isImageGenConfig(node.data.config)) {
      const cfg = node.data.config
      const modelType = params.modelType ?? cfg.modelType ?? 'gemini'
      const resolution = params.resolution ?? cfg.resolution ?? '2k'
      const modelCode = MODEL_CODE_MAP[modelType]?.[resolution] ?? 'gemini-3.1-flash-image-preview-2k'

      // Collect upstream image refs
      const upstreamEdges = edges.filter((e) => e.target === nodeId)
      const refUrls: string[] = []
      for (const edge of upstreamEdges) {
        const srcNode = nodes.find((n) => n.id === edge.source)
        if (!srcNode) continue
        const srcExec = execStore.nodes[edge.source]
        const output = srcExec?.outputs.find((o) => o.id === srcExec.selectedOutputId)
        if (output?.url) refUrls.push(output.url)
        if (srcNode.type === 'asset' && isAssetConfig(srcNode.data.config) && srcNode.data.config.url) {
          if (!refUrls.includes(srcNode.data.config.url)) refUrls.push(srcNode.data.config.url)
        }
      }

      // Collect upstream text prompts
      const textParts: string[] = []
      for (const edge of upstreamEdges) {
        const srcNode = nodes.find((n) => n.id === edge.source)
        if (srcNode?.type === 'text_input') {
          const txt = (srcNode.data.config as any).text
          if (txt) textParts.push(txt)
        }
      }
      const finalPrompt = [...textParts, cfg.prompt].filter(Boolean).join('\n')

      await executeCanvasNode(
        {
          canvasId,
          canvasNodeId: nodeId,
          type: 'image_gen',
          config: {
            prompt: finalPrompt,
            model: modelCode,
            aspectRatio: params.aspectRatio ?? cfg.aspectRatio ?? '1:1',
            quantity: cfg.quantity ?? 1,
            resolution,
          },
          workspaceId: workspaceId ?? undefined,
          referenceImageUrls: refUrls.length > 0 ? refUrls : undefined,
        },
        token ?? undefined,
      )
    } else if (node.type === 'video_gen' && isVideoGenConfig(node.data.config)) {
      const cfg = node.data.config
      const videoModel = params.videoModel ?? cfg.model ?? 'seedance-2.0'
      const videoMode = cfg.videoMode ?? 'multiref'

      const upstreamEdges = edges.filter((e) => e.target === nodeId)
      const refImages: string[] = []
      const refVideos: string[] = []
      const refAudios: string[] = []
      const textParts: string[] = []
      let frameStart: string | undefined
      let frameEnd: string | undefined

      for (const edge of upstreamEdges) {
        const srcNode = nodes.find((n) => n.id === edge.source)
        if (!srcNode) continue

        if (srcNode.type === 'text_input') {
          const txt = (srcNode.data.config as any).text
          if (txt) textParts.push(txt)
          continue
        }

        const getUrl = (): string | undefined => {
          if (srcNode.type === 'asset' && isAssetConfig(srcNode.data.config)) return srcNode.data.config.url ?? undefined
          const srcExec = execStore.nodes[srcNode.id]
          return srcExec?.outputs.find((o) => o.id === srcExec.selectedOutputId)?.url
        }
        const url = getUrl()
        if (!url) continue

        const mime = srcNode.type === 'asset' && isAssetConfig(srcNode.data.config) ? srcNode.data.config.mimeType : undefined

        if (videoMode === 'keyframe') {
          if (!frameStart) frameStart = url
          else if (!frameEnd) frameEnd = url
        } else {
          if (mime?.startsWith('video')) refVideos.push(url)
          else if (mime?.startsWith('audio')) refAudios.push(url)
          else refImages.push(url)
        }
      }

      const finalPrompt = [...textParts, cfg.prompt].filter(Boolean).join('\n')

      await executeVideoNode(
        {
          canvasId,
          canvasNodeId: nodeId,
          workspaceId: workspaceId ?? undefined,
          prompt: finalPrompt,
          model: videoModel,
          videoMode,
          aspectRatio: params.aspectRatio ?? cfg.aspectRatio ?? undefined,
          duration: params.duration ?? cfg.duration ?? undefined,
          referenceImages: videoMode === 'multiref' ? refImages : undefined,
          referenceVideos: videoMode === 'multiref' ? refVideos : undefined,
          referenceAudios: videoMode === 'multiref' ? refAudios : undefined,
          frameStart: videoMode === 'keyframe' ? frameStart : undefined,
          frameEnd: videoMode === 'keyframe' ? frameEnd : undefined,
        },
        token ?? undefined,
      )
    } else if (node.type === 'script_writer' && isScriptWriterConfig(node.data.config)) {
      const cfg = node.data.config
      const result = await executeScriptWriterNode(
        { description: cfg.description, style: cfg.style, duration: cfg.duration },
        token ?? undefined,
      )
      execStore.addNodeOutput(nodeId, {
        id: randomUUID(),
        url: '',
        type: 'text',
        paramsSnapshot: { script: result.script, characters: result.characters, scenes: result.scenes },
      })
      execStore.setNodeStatus(nodeId, 'completed', { progress: 100 })
    } else if (node.type === 'storyboard_splitter' && isStoryboardSplitterConfig(node.data.config)) {
      const cfg = node.data.config
      const upstreamEdges = edges.filter((e) => e.target === nodeId)
      const scriptParts: string[] = []
      for (const edge of upstreamEdges) {
        const srcNode = nodes.find((n) => n.id === edge.source)
        if (!srcNode) continue
        if (srcNode.type === 'script_writer') {
          const out = execStore.nodes[srcNode.id]?.outputs[0]
          const script = (out?.paramsSnapshot as { script?: string } | undefined)?.script
          if (script) scriptParts.push(script)
        } else if (srcNode.type === 'text_input') {
          const txt = (srcNode.data.config as any).text
          if (txt) scriptParts.push(txt)
        }
      }
      const script = scriptParts.join('\n')
      const result = await executeStoryboardSplitterNode(
        { script, shotCount: cfg.shotCount },
        token ?? undefined,
      )
      execStore.addNodeOutput(nodeId, {
        id: randomUUID(),
        url: '',
        type: 'text',
        paramsSnapshot: { shots: result.shots },
      })
      execStore.setNodeStatus(nodeId, 'completed', { progress: 100 })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '执行失败'
    const code = err instanceof CanvasApiError ? err.code : undefined
    execStore.setNodeError(nodeId, message, code)
    throw err
  }
}

// ── Main hook ────────────────────────────────────────────────────────────────

export function useCanvasAgent(canvasId: string, kickPoll: () => void) {
  const token = useAuthStore((s) => s.accessToken)
  const workspaceId = useCanvasStructureStore((s) => s.workspaceId)

  // Restore session from localStorage on mount
  const savedSession = typeof window !== 'undefined' ? loadCanvasAgentSession(canvasId) : null

  const [phase, setPhase] = useState<AgentPhase>('idle')
  const [messages, setMessages] = useState<AgentMessage[]>(savedSession?.messages ?? [])
  const [activeWorkflow, setActiveWorkflow] = useState<AgentWorkflow | null>(savedSession?.activeWorkflow ?? null)
  const [currentStepIndex, setCurrentStepIndex] = useState(savedSession?.currentStepIndex ?? 0)
  const [stepParams, setStepParams] = useState<Record<number, StepParams>>({})
  const [implicitNodeId, setImplicitNodeId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  // Persist session whenever messages or workflow state changes
  useEffect(() => {
    if (messages.length === 0 && !activeWorkflow) return
    saveCanvasAgentSession(canvasId, { messages, activeWorkflow, currentStepIndex })
  }, [canvasId, messages, activeWorkflow, currentStepIndex])

  const appendChunk = useCallback((msgId: string, chunk: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId && m.role !== 'result' ? { ...m, content: m.content + chunk } : m)),
    )
  }, [])

  const finalizeMessage = useCallback((msgId: string, instruction: AgentInstruction | null) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? { ...m, status: 'done', ...(instruction ? { instruction } : {}) }
          : m,
      ),
    )
  }, [])

  const sendMessage = useCallback(
    async (rawText: string) => {
      if (!rawText.trim() && !implicitNodeId) return

      // Abort any in-flight request
      abortRef.current?.abort()
      abortRef.current = new AbortController()

      const userMsg: AgentMessage = {
        id: randomUUID(),
        role: 'user',
        content: rawText,
        implicitNodeId: implicitNodeId ?? undefined,
        status: 'done',
      }

      const assistantMsgId = randomUUID()
      const assistantMsg: AgentMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        status: 'streaming',
      }

      setMessages((prev) => [...prev, userMsg, assistantMsg])
      setPhase('waiting_llm')
      setImplicitNodeId(null)

      // Build history — keep last 10 done messages, summarize large instruction responses
      const history = messages
        .filter((m): m is Extract<typeof m, { role: 'user' | 'assistant' }> => m.role !== 'result' && m.status === 'done')
        .slice(-10)
        .map((m) => {
          if (m.role === 'assistant' && m.instruction?.type === 'apply_workflow') {
            // Summarize workflow with step labels and nodeIds so LLM can track its own nodes
            const steps = m.instruction.workflow.steps
            const stepLines = steps.map((s) =>
              `  - Step ${s.stepIndex + 1} ${s.label} (${s.nodeType}): ${s.nodeIds.join(', ')}`
            ).join('\n')
            return { role: m.role, content: `[已搭建工作流：\n${stepLines}]` }
          }
          // Truncate very long messages to avoid context overflow
          const content = m.content.length > 800 ? m.content.slice(0, 800) + '…' : m.content
          return { role: m.role, content }
        })

      const content = buildUserContent(rawText, implicitNodeId ?? undefined)
      const canvasContext = buildCanvasContext()

      let fullText = ''
      try {
        await callCanvasAgent({
          content,
          canvasContext,
          history,
          token,
          signal: abortRef.current.signal,
          onChunk: (chunk) => {
            fullText += chunk
            appendChunk(assistantMsgId, chunk)
          },
        })

        const { text, instruction } = parseAgentResponse(fullText)

        // Update message with clean text (strip instruction block)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: text, status: 'done', ...(instruction ? { instruction } : {}) }
              : m,
          ),
        )

        if (instruction?.type === 'apply_workflow') {
          handleApplyWorkflow(instruction.workflow)
        } else if (instruction?.type === 'autorun') {
          // Start autorun from current step — use setState callback to avoid stale closure
          setActiveWorkflow((wf) => {
            if (wf) {
              setPhase('autorunning')
              setCurrentStepIndex((idx) => {
                setStepParams((sp) => {
                  // Defer to avoid calling autoRunAllSteps before it's defined
                  setTimeout(() => autoRunAllStepsRef.current?.(idx, wf, sp[idx] ?? {}), 0)
                  return sp
                })
                return idx
              })
            } else {
              setPhase('idle')
            }
            return wf
          })
        } else if (instruction) {
          setPhase('waiting_user')
        } else {
          setPhase('idle')
        }
      } catch (err: unknown) {
        if ((err as any)?.name === 'AbortError') return
        const message = err instanceof Error ? err.message : 'AI助手出错'
        toast.error(message)
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, status: 'error' } : m)),
        )
        setPhase('idle')
      }
    },
    [messages, implicitNodeId, token, appendChunk],
  )

  const handleApplyWorkflow = useCallback(
    (workflow: AgentWorkflow) => {
      const structureStore = useCanvasStructureStore.getState()
      structureStore.applyAgentWorkflow(workflow)
      setActiveWorkflow(workflow)
      setCurrentStepIndex(0)
      setStepParams({})

      // Highlight first step nodes
      if (workflow.steps.length > 0) {
        useCanvasExecutionStore.getState().setHighlightedNodes(new Set(workflow.steps[0].nodeIds))
        setPhase('waiting_user')
      } else {
        setPhase('idle')
      }
    },
    [],
  )

  const confirmStep = useCallback(
    async (stepIndex: number, params: StepParams) => {
      if (!activeWorkflow) return
      const step = activeWorkflow.steps[stepIndex]
      if (!step) return

      setStepParams((prev) => ({ ...prev, [stepIndex]: params }))

      if (!step.needsRun) {
        advanceStep(stepIndex, activeWorkflow)
        return
      }

      setPhase('running')
      useCanvasExecutionStore.getState().setHighlightedNodes(new Set(step.nodeIds))

      // Execute nodes with concurrency limit of 3
      const limit = 3
      const queue = [...step.nodeIds]
      let failed = 0

      const runNext = async (): Promise<void> => {
        const nodeId = queue.shift()
        if (!nodeId) return
        try {
          await executeNode(nodeId, canvasId, workspaceId, params, token)
          const activeTeamId = useAuthStore.getState().activeTeamId
          if (activeTeamId) mutate(`/teams/${activeTeamId}`)
          // Inject result message into conversation
          const execState = useCanvasExecutionStore.getState().nodes[nodeId]
          const node = useCanvasStructureStore.getState().nodes.find((n) => n.id === nodeId)
          if (execState && node) {
            const outputs = execState.outputs
              .filter((o) => o.url && (o.type === 'image' || o.type === 'video'))
              .map((o) => ({ url: o.url!, type: o.type as 'image' | 'video' }))
            if (outputs.length > 0) {
              setMessages((prev) => [
                ...prev,
                { id: randomUUID(), role: 'result' as const, nodeId, nodeLabel: node.data.label, outputs },
              ])
            }
          }
        } catch {
          failed++
        }
        await runNext()
      }

      await Promise.all(Array.from({ length: Math.min(limit, step.nodeIds.length) }, runNext))

      kickPoll()

      if (failed > 0) {
        toast.error(`${failed} 个节点执行失败，可手动重试`)
      }

      advanceStep(stepIndex, activeWorkflow)
    },
    [activeWorkflow, canvasId, workspaceId, token, kickPoll],
  )

  const advanceStep = useCallback(
    (stepIndex: number, workflow: AgentWorkflow) => {
      const next = stepIndex + 1
      if (next >= workflow.steps.length) {
        setPhase('idle')
        useCanvasExecutionStore.getState().setHighlightedNodes(new Set())
        setActiveWorkflow(null)
      } else {
        setCurrentStepIndex(next)
        useCanvasExecutionStore.getState().setHighlightedNodes(new Set(workflow.steps[next].nodeIds))
        setPhase('waiting_user')
      }
    },
    [],
  )

  const autorunRef = useRef(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoRunRef = useRef<((startIndex: number, workflow: AgentWorkflow, params: StepParams) => Promise<void>) | null>(null)
  const autoRunAllStepsRef = useRef<((startIndex: number, workflow: AgentWorkflow, params: StepParams) => Promise<void>) | null>(null)

  const autoRunAllSteps = useCallback(
    async (startIndex: number, workflow: AgentWorkflow, params: StepParams) => {
      autorunRef.current = true
      for (let i = startIndex; i < workflow.steps.length; i++) {
        if (!autorunRef.current) break
        await confirmStep(i, params)
      }
      autorunRef.current = false
    },
    [confirmStep],
  )
  autoRunAllStepsRef.current = autoRunAllSteps

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setPhase('idle')
    setMessages([])
    setActiveWorkflow(null)
    setCurrentStepIndex(0)
    setStepParams({})
    setImplicitNodeId(null)
    clearCanvasAgentSession(canvasId)
    useCanvasExecutionStore.getState().setHighlightedNodes(new Set())
  }, [canvasId])

  // Keep ref in sync so sendMessage can call it without circular dep
  autoRunRef.current = autoRunAllSteps

  const stopAutorun = useCallback(() => {
    autorunRef.current = false
    setPhase('waiting_user')
  }, [])

  return {
    phase,
    messages,
    activeWorkflow,
    currentStepIndex,
    stepParams,
    implicitNodeId,
    setImplicitNodeId,
    sendMessage,
    confirmStep,
    autoRunAllSteps,
    stopAutorun,
    reset,
    estimateStepCredits,
  }
}
