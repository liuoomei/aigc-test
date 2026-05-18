'use client'

import { useRef, useCallback } from 'react'
import Image from 'next/image'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useGenerationStore } from '@/stores/generation-store'
import { cn, randomUUID } from '@/lib/utils'
import { ImagePlus, X } from 'lucide-react'

const aspectRatios = [
  { value: '1:1', label: '1:1', desc: '正方形' },
  { value: '4:3', label: '4:3', desc: '横向' },
  { value: '3:4', label: '3:4', desc: '纵向' },
  { value: '16:9', label: '16:9', desc: '宽屏' },
  { value: '9:16', label: '9:16', desc: '竖屏' },
]

const MAX_IMAGES = 5
const MAX_SIZE_MB = 10

export function ParamsPanel() {
  const { aspectRatio, setAspectRatio, referenceImages, addReferenceImage, removeReferenceImage } = useGenerationStore()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      if (referenceImages.length >= MAX_IMAGES) break
      if (!file.type.startsWith('image/')) continue
      if (file.size > MAX_SIZE_MB * 1024 * 1024) continue

      addReferenceImage({
        id: randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      })
    }
    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [referenceImages.length, addReferenceImage])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    handleFiles(e.dataTransfer.files)
  }, [handleFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium mb-2 block">画面比例</Label>
        <div className="grid grid-cols-5 gap-2">
          {aspectRatios.map((ar) => (
            <button
              key={ar.value}
              onClick={() => setAspectRatio(ar.value)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border p-2 text-xs transition-colors hover:bg-accent',
                aspectRatio === ar.value
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border text-muted-foreground'
              )}
            >
              <AspectRatioIcon ratio={ar.value} active={aspectRatio === ar.value} />
              <span>{ar.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <Label className="text-sm font-medium mb-2 block">
          参考图（最多 {MAX_IMAGES} 张）
        </Label>

        {/* Preview grid */}
        {referenceImages.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {referenceImages.map((img) => (
              <div key={img.id} className="relative h-20 w-20 shrink-0 rounded-md overflow-hidden border group">
                <Image
                  src={img.previewUrl}
                  alt="参考图"
                  fill
                  className="object-cover"
                  sizes="80px"
                  unoptimized
                />
                <button
                  onClick={() => removeReferenceImage(img.id)}
                  className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Upload area */}
        {referenceImages.length < MAX_IMAGES && (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-20 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/30"
          >
            <ImagePlus className="h-4 w-4" />
            <span>点击或拖放图片</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
    </div>
  )
}

function AspectRatioIcon({ ratio, active }: { ratio: string; active: boolean }) {
  const [w, h] = ratio.split(':').map(Number)
  const maxSize = 24
  const scale = maxSize / Math.max(w, h)
  const width = Math.round(w * scale)
  const height = Math.round(h * scale)

  return (
    <div
      className={cn(
        'rounded-sm border',
        active ? 'border-primary bg-primary/20' : 'border-muted-foreground/30'
      )}
      style={{ width, height }}
    />
  )
}
