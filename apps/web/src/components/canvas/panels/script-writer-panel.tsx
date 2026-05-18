'use client'

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useCanvasStructureStore } from '@/stores/canvas/structure-store'
import { useCanvasExecutionStore } from '@/stores/canvas/execution-store'
import { useAuthStore } from '@/stores/auth-store'
import { randomUUID } from '@/lib/utils'
import { CanvasApiError, executeScriptWriterNode } from '@/lib/canvas/canvas-api'
import type { ScriptWriterConfig } from '@/lib/canvas/types'

const STYLE_OPTIONS = ['现代都市', '古装', '科幻', '动漫', '纪录片', '悬疑', '奇幻']

interface Props {
  nodeId: string
  canvasId: string
  config: ScriptWriterConfig
  onExecuted: () => void
}

export function ScriptWriterPanel({ nodeId, canvasId, config, onExecuted }: Props) {
  const updateNodeData = useCanvasStructureStore((s) => s.updateNodeData)
  const setNodeStatus = useCanvasExecutionStore((s) => s.setNodeStatus)
  const setNodeError = useCanvasExecutionStore((s) => s.setNodeError)
  const addNodeOutput = useCanvasExecutionStore((s) => s.addNodeOutput)
  const execState = useCanvasExecutionStore((s) => s.nodes[nodeId])
  const token = useAuthStore((s) => s.accessToken)

  const [executing, setExecuting] = useState(false)

  const script = (execState?.outputs[0]?.paramsSnapshot as { script?: string } | undefined)?.script ?? ''
  const characters = (execState?.outputs[0]?.paramsSnapshot as { characters?: string[] } | undefined)?.characters ?? []
  const scenes = (execState?.outputs[0]?.paramsSnapshot as { scenes?: string[] } | undefined)?.scenes ?? []
  const isDone = execState?.submissionStatus === 'completed'

  const updateCfg = useCallback((patch: Partial<ScriptWriterConfig>) => {
    updateNodeData(nodeId, { config: { ...config, ...patch } })
  }, [nodeId, config, updateNodeData])

  const handleExecute = useCallback(async () => {
    if (!config.description.trim()) {
      toast.error('请先填写故事描述')
      return
    }
    setExecuting(true)
    setNodeStatus(nodeId, 'pending', { progress: 0 })
    try {
      const result = await executeScriptWriterNode(
        { description: config.description, style: config.style, duration: config.duration },
        token ?? undefined,
      )
      addNodeOutput(nodeId, {
        id: randomUUID(),
        url: '',
        type: 'text',
        paramsSnapshot: { script: result.script, characters: result.characters, scenes: result.scenes },
      })
      setNodeStatus(nodeId, 'completed', { progress: 100 })
      toast.success('剧本生成完成')
      onExecuted()
    } catch (err) {
      const message = err instanceof Error ? err.message : '执行失败'
      const code = err instanceof CanvasApiError ? err.code : undefined
      toast.error(message)
      setNodeError(nodeId, message, code)
    } finally {
      setExecuting(false)
    }
  }, [config, nodeId, token, addNodeOutput, setNodeStatus, setNodeError, onExecuted])

  return (
    <div className="p-3 space-y-3">
      <div>
        <label className="text-[11px] font-medium text-muted-foreground block mb-1">故事描述</label>
        <textarea
          className="w-full h-20 p-2 text-xs bg-muted/60 rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="简单描述你想要的故事内容…"
          value={config.description}
          onChange={(e) => updateCfg({ description: e.target.value })}
        />
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">风格</label>
          <select
            value={config.style}
            onChange={(e) => updateCfg({ style: e.target.value })}
            className="w-full text-xs bg-background border border-border rounded px-2 py-1.5"
          >
            {STYLE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="w-20">
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">时长(秒)</label>
          <input
            type="number"
            min={10}
            max={600}
            step={10}
            value={config.duration}
            onChange={(e) => updateCfg({ duration: Number(e.target.value) })}
            className="w-full text-xs bg-background border border-border rounded px-2 py-1.5"
          />
        </div>
      </div>

      <button
        onClick={handleExecute}
        disabled={executing || !config.description.trim()}
        className="w-full text-xs bg-primary text-primary-foreground rounded-lg py-1.5 hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
      >
        {executing && <Loader2 size={11} className="animate-spin" />}
        {executing ? '生成中…' : '生成剧本'}
      </button>

      {isDone && script && (
        <div className="space-y-2 pt-1 border-t border-border">
          {characters.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1">角色</p>
              <div className="flex flex-wrap gap-1">
                {characters.map((c, i) => (
                  <span key={i} className="text-[10px] bg-amber-50 border border-amber-200 text-amber-700 px-1.5 py-0.5 rounded">{c}</span>
                ))}
              </div>
            </div>
          )}
          {scenes.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1">场景</p>
              <div className="flex flex-wrap gap-1">
                {scenes.map((s, i) => (
                  <span key={i} className="text-[10px] bg-blue-50 border border-blue-200 text-blue-700 px-1.5 py-0.5 rounded">{s}</span>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">剧本</p>
            <div className="max-h-48 overflow-y-auto text-[11px] text-foreground bg-muted/40 rounded p-2 whitespace-pre-wrap leading-relaxed">
              {script}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
