'use client'

import { useState } from 'react'
import Image from 'next/image'
import type { BatchResponse } from '@aigc/types'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Download, RotateCcw, Check, ImagePlus, Loader2 } from 'lucide-react'
import { useBatch, cancelSeedanceBatch } from '@/hooks/use-batches'
import { downloadImage } from '@/lib/download'
import { translateTaskError } from '@/lib/error-messages'
import { useGenerationStore } from '@/stores/generation-store'
import { toast } from 'sonner'
import { randomUUID } from '@/lib/utils'

interface BatchDetailProps {
  batchId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onApplied?: () => void
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'gemini-3.1-flash-image-preview':    '全能图片2 1K',
  'gemini-3.1-flash-image-preview-2k': '全能图片2 2K',
  'gemini-3.1-flash-image-preview-4k': '全能图片2 4K',
  'gpt-image-2':                       '超能图片2',
  'nano-banana-pro':                   '全能图片Pro 1K',
  'nano-banana-pro-2k':                '全能图片Pro 2K',
  'nano-banana-pro-4k':                '全能图片Pro 4K',
  'veo3.1-fast':                       '全能视频3.1 Fast',
  'veo3.1-components':                 '全能视频3.1',
  'jimeng_realman_avatar_picture_omni_v15': 'OmniHuman 1.5 数字人',
  'jimeng_dreamactor_m20_gen_video': '动作模仿2.0',
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'success' | 'destructive' | 'processing' | 'warning' | 'outline' }> = {
  pending: { label: '等待中', variant: 'outline' },
  processing: { label: '生成中', variant: 'processing' },
  completed: { label: '已完成', variant: 'success' },
  partial_complete: { label: '部分完成', variant: 'warning' },
  failed: { label: '失败', variant: 'destructive' },
}

export function BatchDetail({ batchId, open, onOpenChange, onApplied }: BatchDetailProps) {
  const { data: batch, isLoading, mutate } = useBatch(open ? batchId : null)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>批次详情</SheetTitle>
          <SheetDescription className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-left">
            {((batch as any)?.module === 'action_imitation' && !batch?.prompt) ? '动作模仿任务' : (batch?.prompt ?? '加载中...')}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !batch ? (
          <div className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square rounded-lg" />
              ))}
            </div>
          </div>
        ) : (
          <BatchDetailContent batch={batch} onClose={() => onOpenChange(false)} onApplied={onApplied} onCancelled={() => mutate()} />
        )}
      </SheetContent>
    </Sheet>
  )
}

function BatchDetailContent({ batch, onClose, onApplied, onCancelled }: { batch: BatchResponse; onClose: () => void; onApplied?: () => void; onCancelled?: () => void }) {
  const applyBatch = useGenerationStore((s) => s.applyBatch)
  const addReferenceImage = useGenerationStore((s) => s.addReferenceImage)
  const referenceCount = useGenerationStore((s) => s.referenceImages.length)
  const status = statusConfig[batch.status] ?? statusConfig.pending
  const time = new Date(batch.created_at)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [applied, setApplied] = useState(false)
  const [sendingUrl, setSendingUrl] = useState<string | null>(null)
  const [sendingAll, setSendingAll] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  function handleApply() {
    applyBatch(batch)
    setApplied(true)
    setTimeout(() => setApplied(false), 1500)
    onApplied?.()
    onClose()
  }

  async function handleCancel() {
    if (!confirm('确认取消这个 Seedance 任务？')) return
    setCancelling(true)
    try {
      await cancelSeedanceBatch(batch.id)
      toast.success('任务已取消，积分已退回')
      onCancelled?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '取消任务失败')
    } finally {
      setCancelling(false)
    }
  }

  async function handleSendToReference(url: string, showSuccess = true) {
    if (referenceCount >= 10) {
      toast.error('最多添加 10 张参考图')
      return
    }
    setSendingUrl(url)
    try {
      addReferenceImage({
        id: randomUUID(),
        previewUrl: url,
      })
      if (showSuccess) toast.success('已发送至参考区')
    } catch {
      toast.error('发送至参考失败')
    } finally {
      setSendingUrl(null)
    }
  }

  async function handleSendAllToReference() {
    if (completedUrls.length === 0) return
    if (referenceCount >= 10) {
      toast.error('最多添加 10 张参考图')
      return
    }
    setSendingAll(true)
    try {
      const availableSlots = 10 - referenceCount
      completedUrls.slice(0, availableSlots).forEach((url) => {
        addReferenceImage({
          id: randomUUID(),
          previewUrl: url,
        })
      })
      toast.success('已发送至参考区')
      if (completedUrls.length > availableSlots) {
        toast.info(`参考区最多 10 张，已添加前 ${availableSlots} 张`)
      }
    } finally {
      setSendingAll(false)
    }
  }

  // Collect completed tasks that have a URL
  const completedUrls = batch.tasks
    .filter((t) => t.status === 'completed' && (t.asset?.storage_url ?? t.asset?.original_url))
    .map((t) => t.asset!.storage_url ?? t.asset!.original_url!)

  const isVideo = (batch as any).module === 'video' || (batch as any).module === 'avatar' || (batch as any).module === 'action_imitation'
  const canCancelSeedance = (batch.status === 'pending' || batch.status === 'processing') && batch.provider === 'volcengine' && /^seedance-/i.test(batch.model)

  return (
    <div className="mt-6 space-y-4">
      {/* Meta info */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground">状态</p>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <div>
          <p className="text-muted-foreground">进度</p>
          <p className="font-medium">{batch.completed_count}/{batch.quantity}</p>
        </div>
        <div>
          <p className="text-muted-foreground">模型</p>
          <p className="font-medium">{MODEL_DISPLAY_NAMES[batch.model] ?? batch.model}</p>
        </div>
        <div>
          <p className="text-muted-foreground">积分</p>
          <p className="font-medium">{batch.actual_credits || batch.estimated_credits}</p>
        </div>
        {batch.user && (
          <div>
            <p className="text-muted-foreground">操作人</p>
            <p className="font-medium">{batch.user.username}</p>
          </div>
        )}
        <div className={batch.user ? '' : 'col-span-2'}>
          <p className="text-muted-foreground">创建时间</p>
          <p className="font-medium">{time.toLocaleString('zh-CN')}</p>
        </div>
      </div>

      {canCancelSeedance && (
        <Button
          variant="destructive"
          size="sm"
          className="w-full gap-2"
          onClick={handleCancel}
          disabled={cancelling}
        >
          {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}
          取消任务
        </Button>
      )}

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={handleApply}
        disabled={applied}
      >
        {applied ? (
          <><Check className="h-4 w-4 mr-2 text-green-500" />已填入</>
        ) : (
          <><RotateCcw className="h-4 w-4 mr-2" />复用此配置</>
        )}
      </Button>

      {!isVideo && completedUrls.length > 0 && (
        <Button
          size="sm"
          className="w-full gap-2"
          onClick={handleSendAllToReference}
          disabled={sendingAll || referenceCount >= 10}
        >
          {sendingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
          发送至参考
        </Button>
      )}

      <Separator />

      {/* Task results */}
      <div>
        <p className="text-sm font-medium mb-3">生成结果</p>
        {batch.tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">无任务数据</p>
        ) : isVideo ? (
          /* Video tasks */
          <div className="space-y-3">
            {batch.tasks.map((task) => {
              const url = task.asset?.storage_url ?? task.asset?.original_url
              if (task.status === 'completed' && url) {
                return (
                  <div key={task.id} className="rounded-lg overflow-hidden border bg-black">
                    <video
                      src={url}
                      controls
                      className="w-full max-h-[400px] object-contain"
                      preload="metadata"
                    />
                    <div className="flex justify-end p-2">
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => downloadImage(url, 'video')}>
                        <Download className="h-3.5 w-3.5" />
                        下载
                      </Button>
                    </div>
                  </div>
                )
              }
              return (
                <div key={task.id} className="flex h-20 items-center justify-center rounded-lg border bg-muted text-xs text-muted-foreground">
                  {task.status === 'failed' ? (
                    <div className="text-center px-3">
                      <p className="font-medium text-destructive">生成失败</p>
                      {task.error_message && (
                        <p className="mt-1 line-clamp-3 text-xs text-destructive/80">{translateTaskError(task.error_message)}</p>
                      )}
                    </div>
                  ) : task.status === 'processing' ? '视频生成中...' : '等待中'}
                </div>
              )
            })}
          </div>
        ) : (
          /* Image tasks */
          <div className="grid grid-cols-2 gap-3">
            {batch.tasks.map((task) => {
              const url = task.asset?.storage_url ?? task.asset?.original_url

              if (task.status === 'completed' && url) {
                const urlIndex = completedUrls.indexOf(url)
                return (
                  <div
                    key={task.id}
                    className="group relative aspect-square rounded-lg overflow-hidden border cursor-pointer"
                    onClick={() => setLightboxIndex(urlIndex)}
                  >
                    <Image
                      src={url}
                      alt=""
                      fill
                      className="object-cover"
                      sizes="200px"
                      unoptimized
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-end justify-end p-2 opacity-0 group-hover:opacity-100">
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 bg-background/80 hover:bg-background"
                          onClick={(e) => { e.stopPropagation(); handleSendToReference(url) }}
                          disabled={sendingUrl === url}
                          title="发送至参考"
                        >
                          {sendingUrl === url ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 bg-background/80 hover:bg-background"
                          onClick={(e) => { e.stopPropagation(); downloadImage(url, task.asset?.type as 'image' | 'video' | undefined) }}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              }

              return (
                <div key={task.id} className="flex aspect-square items-center justify-center rounded-lg border bg-muted text-xs text-muted-foreground">
                  {task.status === 'failed' ? (
                    <div className="text-center px-3">
                      <p className="font-medium text-destructive">生成失败</p>
                      {task.error_message && (
                        <p className="mt-1 line-clamp-3 text-xs text-destructive/80">{translateTaskError(task.error_message)}</p>
                      )}
                    </div>
                  ) : task.status === 'processing' ? '生成中' : '等待中'}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Lightbox (images only) */}
      {!isVideo && lightboxIndex !== null && completedUrls[lightboxIndex] && (
        <ImageLightbox
          url={completedUrls[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={lightboxIndex > 0 ? () => setLightboxIndex((i) => i! - 1) : undefined}
          onNext={lightboxIndex < completedUrls.length - 1 ? () => setLightboxIndex((i) => i! + 1) : undefined}
        />
      )}
    </div>
  )
}
