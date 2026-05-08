'use client'

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useCanvasStructureStore } from '@/stores/canvas/structure-store'
import { useCanvasExecutionStore } from '@/stores/canvas/execution-store'
import { useAuthStore } from '@/stores/auth-store'
import { CanvasApiError, executeStoryboardSplitterNode } from '@/lib/canvas/canvas-api'
import { randomUUID } from '@/lib/utils'
import type { StoryboardSplitterConfig, AppNode, AppEdge } from '@/lib/canvas/types'
import { isScriptWriterConfig, isTextInputConfig } from '@/lib/canvas/types'

interface Shot {
  id: string
  label: string
  content: string
}

interface Props {
  nodeId: string
  canvasId: string
  config: StoryboardSplitterConfig
  onExecuted: () => void
  onExpanded?: (shotNodeIds: string[]) => void
}

export function StoryboardSplitterPanel({ nodeId, canvasId, config, onExecuted, onExpanded }: Props) {
  const updateNodeData = useCanvasStructureStore((s) => s.updateNodeData)
  const setNodeStatus = useCanvasExecutionStore((s) => s.setNodeStatus)
  const setNodeError = useCanvasExecutionStore((s) => s.setNodeError)
  const addNodeOutput = useCanvasExecutionStore((s) => s.addNodeOutput)
  const execState = useCanvasExecutionStore((s) => s.nodes[nodeId])
  const token = useAuthStore((s) => s.accessToken)

  const [executing, setExecuting] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Editable shot drafts — initialized from execState when done
  const rawShots = (execState?.outputs[0]?.paramsSnapshot as { shots?: Shot[] } | undefined)?.shots ?? []
  const [editedShots, setEditedShots] = useState<Shot[]>([])
  const isDone = execState?.submissionStatus === 'completed' && rawShots.length > 0

  // Sync editedShots when rawShots first arrive
  const shotsToShow: Shot[] = editedShots.length > 0 ? editedShots : rawShots

  const updateCfg = useCallback((patch: Partial<StoryboardSplitterConfig>) => {
    updateNodeData(nodeId, { config: { ...config, ...patch } })
  }, [nodeId, config, updateNodeData])

  const updateShot = (id: string, content: string) => {
    const base = editedShots.length > 0 ? editedShots : rawShots
    setEditedShots(base.map((s) => s.id === id ? { ...s, content } : s))
  }

  // Collect upstream script text
  const getUpstreamScript = useCallback((): string => {
    const { nodes, edges } = useCanvasStructureStore.getState()
    const execStore = useCanvasExecutionStore.getState()
    const upstreamEdges = edges.filter((e) => e.target === nodeId)
    const parts: string[] = []
    for (const edge of upstreamEdges) {
      const src = nodes.find((n) => n.id === edge.source)
      if (!src) continue
      if (src.type === 'script_writer') {
        const out = execStore.nodes[src.id]?.outputs[0]
        const script = (out?.paramsSnapshot as { script?: string } | undefined)?.script
        if (script) parts.push(script)
      } else if (src.type === 'text_input' && isTextInputConfig(src.data.config)) {
        if (src.data.config.text) parts.push(src.data.config.text)
      }
    }
    return parts.join('\n')
  }, [nodeId])

  const handleExecute = useCallback(async () => {
    const script = getUpstreamScript()
    if (!script.trim()) {
      toast.error('请先连接剧本节点并执行')
      return
    }
    setExecuting(true)
    setEditedShots([])
    setExpanded(false)
    setNodeStatus(nodeId, 'pending', { progress: 0 })
    try {
      const result = await executeStoryboardSplitterNode(
        { script, shotCount: config.shotCount },
        token ?? undefined,
      )
      addNodeOutput(nodeId, {
        id: randomUUID(),
        url: '',
        type: 'text',
        paramsSnapshot: { shots: result.shots },
      })
      setNodeStatus(nodeId, 'completed', { progress: 100 })
      toast.success(`已生成 ${result.shots.length} 个分镜草稿，请在下方确认后展开`)
      onExecuted()
    } catch (err) {
      const message = err instanceof Error ? err.message : '执行失败'
      const code = err instanceof CanvasApiError ? err.code : undefined
      toast.error(message)
      setNodeError(nodeId, message, code)
    } finally {
      setExecuting(false)
    }
  }, [config.shotCount, nodeId, token, getUpstreamScript, addNodeOutput, setNodeStatus, setNodeError, onExecuted])

  const handleExpandToCanvas = useCallback(() => {
    const shots = shotsToShow
    if (shots.length === 0) return

    const currentNode = useCanvasStructureStore.getState().nodes.find((n) => n.id === nodeId)
    const baseX = (currentNode?.position.x ?? 100) + 350
    const baseY = currentNode?.position.y ?? 100

    const newNodes: AppNode[] = shots.map((shot, i) => ({
      id: `shot_${nodeId}_${i}`,
      type: 'text_input' as const,
      position: { x: baseX, y: baseY + i * 220 },
      data: { label: shot.label, config: { text: shot.content } },
    }))
    const newEdges: AppEdge[] = newNodes.map((n) => ({
      id: `edge_${nodeId}_${n.id}`,
      source: nodeId,
      target: n.id,
      sourceHandle: 'text-out',
      targetHandle: 'any-in',
    }))

    useCanvasStructureStore.getState().applyAgentWorkflow({
      strategy: 'append',
      summary: `展开 ${shots.length} 个分镜节点`,
      reusedNodeIds: [],
      newNodes,
      newEdges,
      steps: [],
    })

    setExpanded(true)
    toast.success(`已展开 ${shots.length} 个分镜节点`)
    onExpanded?.(newNodes.map((n) => n.id))
  }, [nodeId, shotsToShow, onExpanded])

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">分镜数量（0=自动）</label>
          <input
            type="number"
            min={0}
            max={50}
            value={config.shotCount}
            onChange={(e) => updateCfg({ shotCount: Number(e.target.value) })}
            className="w-full text-xs bg-background border border-border rounded px-2 py-1.5"
          />
        </div>
      </div>

      <button
        onClick={handleExecute}
        disabled={executing}
        className="w-full text-xs bg-primary text-primary-foreground rounded-lg py-1.5 hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
      >
        {executing && <Loader2 size={11} className="animate-spin" />}
        {executing ? '拆分中…' : isDone ? '重新拆分' : '拆分分镜'}
      </button>

      {isDone && shotsToShow.length > 0 && (
        <div className="space-y-2 pt-1 border-t border-border">
          <p className="text-[11px] font-medium text-muted-foreground">
            {shotsToShow.length} 个分镜草稿，可直接编辑后展开：
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {shotsToShow.map((shot) => (
              <div key={shot.id} className="space-y-0.5">
                <span className="text-[10px] font-medium text-muted-foreground">{shot.label}</span>
                <textarea
                  value={shot.content}
                  onChange={(e) => updateShot(shot.id, e.target.value)}
                  rows={3}
                  className="w-full text-[11px] bg-background border border-border rounded px-2 py-1.5 resize-y outline-none focus:border-primary/50 transition-colors"
                />
              </div>
            ))}
          </div>
          <button
            onClick={handleExpandToCanvas}
            disabled={expanded}
            className="w-full text-xs bg-violet-600 text-white rounded-lg py-1.5 hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {expanded ? '已展开到画布 ✓' : `确认展开 ${shotsToShow.length} 个分镜节点 →`}
          </button>
        </div>
      )}
    </div>
  )
}
