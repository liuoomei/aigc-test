'use client'

import { useState, useCallback } from 'react'
import { Loader2, GripVertical, Plus, Trash2, ArrowRight, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { randomUUID } from '@/lib/utils'
import { executeStoryboardSplitterNode } from '@/lib/canvas/canvas-api'

interface Shot { id: string; label: string; content: string }

interface Props {
  canvasId: string
  script: string
  storyboardData: Shot[] | null
  onComplete: (shots: Shot[]) => void
}

export function StepStoryboard({ script, storyboardData, onComplete }: Props) {
  const token = useAuthStore((s) => s.accessToken)
  const [shotCount, setShotCount] = useState(6)
  const [loading, setLoading] = useState(false)
  const [shots, setShots] = useState<Shot[]>(storyboardData ?? [])

  const generate = useCallback(async () => {
    if (!script.trim()) { toast.error('请先完成剧本步骤'); return }
    setLoading(true)
    try {
      const res = await executeStoryboardSplitterNode({ script, shotCount }, token ?? undefined)
      setShots(res.shots)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '分镜拆分失败')
    } finally {
      setLoading(false)
    }
  }, [script, shotCount, token])

  const updateContent = (id: string, content: string) =>
    setShots((prev) => prev.map((s) => s.id === id ? { ...s, content } : s))

  const removeShot = (id: string) =>
    setShots((prev) => prev.filter((s) => s.id !== id))

  const addShot = () =>
    setShots((prev) => [...prev, { id: randomUUID(), label: `镜头${prev.length + 1}`, content: '' }])

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold">Step 2 · 分镜</h2>
        <p className="text-sm text-muted-foreground mt-1">将剧本拆分为分镜文案，每条文案将用于生成对应视频片段</p>
      </div>

      <div className="flex items-end gap-3 p-4 border rounded-xl bg-card">
        <div>
          <label className="text-sm font-medium block mb-1.5">分镜数量</label>
          <input
            type="number" min={2} max={20} step={1}
            value={shotCount}
            onChange={(e) => setShotCount(Number(e.target.value))}
            className="w-24 text-sm bg-background border border-border rounded-lg px-3 py-2"
          />
        </div>
        <button
          onClick={generate}
          disabled={loading || !script.trim()}
          className="flex items-center gap-2 text-sm bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {loading ? '拆分中…' : shots.length > 0 ? '重新拆分' : '拆分分镜'}
        </button>
      </div>

      {shots.length > 0 && (
        <div className="space-y-3">
          {shots.map((shot, idx) => (
            <div key={shot.id} className="flex gap-2 items-start p-3 border rounded-xl bg-card group">
              <GripVertical className="w-4 h-4 text-muted-foreground/40 mt-2 shrink-0 cursor-grab" />
              <div className="flex-1 space-y-1">
                <div className="text-xs font-semibold text-muted-foreground">{shot.label || `镜头${idx + 1}`}</div>
                <textarea
                  className="w-full text-sm bg-muted/40 rounded-lg p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary min-h-[60px]"
                  value={shot.content}
                  onChange={(e) => updateContent(shot.id, e.target.value)}
                  placeholder="分镜文案…"
                />
              </div>
              <button
                onClick={() => removeShot(shot.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive mt-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          <button
            onClick={addShot}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-2"
          >
            <Plus className="w-4 h-4" />
            添加分镜
          </button>

          <button
            onClick={() => onComplete(shots)}
            className="flex items-center gap-2 text-sm bg-green-600 text-white px-5 py-2.5 rounded-lg hover:bg-green-700 transition-colors"
          >
            确认分镜，进入角色&场景
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
