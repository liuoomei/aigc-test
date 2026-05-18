'use client'

import { useCallback } from 'react'
import { apiPost, ApiError, reportClientSubmissionError } from '@/lib/api-client'
import { randomUUID } from '@/lib/utils'
import { useGenerationStore } from '@/stores/generation-store'
import { useAuthStore } from '@/stores/auth-store'
import type { BatchResponse, GenerateImageRequest } from '@aigc/types'

const MODEL_CODE_MAP = {
  gemini: {
    '1k': 'gemini-3.1-flash-image-preview',
    '2k': 'gemini-3.1-flash-image-preview-2k',
    '4k': 'gemini-3.1-flash-image-preview-4k',
  },
  'gpt-image-2': {
    '2k': 'gpt-image-2',
  },
  'nano-banana-pro': {
    '1k': 'nano-banana-2',
    '2k': 'nano-banana-2-2k',
    '4k': 'nano-banana-2-4k',
  },
  'seedream-5.0-lite': {
    '2k': 'seedream-5.0-lite',
    '3k': 'seedream-5.0-lite',
  },
  'seedream-4.5': {
    '2k': 'seedream-4.5',
    '4k': 'seedream-4.5',
  },
  'seedream-4.0': {
    '1k': 'seedream-4.0',
    '2k': 'seedream-4.0',
    '4k': 'seedream-4.0',
  },
} as const

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function imageUrlToDataUrl(url: string): Promise<string> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error('reference image fetch failed')
  const blob = await resp.blob()
  return fileToDataUrl(new File([blob], 'reference', { type: blob.type || 'image/jpeg' }))
}

export function useGenerate() {
  const { prompt, modelType, resolution, quantity, aspectRatio, referenceImages, watermark, setIsGenerating, setActiveBatchId } = useGenerationStore()
  const activeWorkspaceId = useAuthStore((s) => s.activeWorkspaceId)

  const generate = useCallback(async (): Promise<BatchResponse | null> => {
    if (!prompt.trim()) return null

    let resolvedModel: string | undefined
    setIsGenerating(true)
    try {
      const modelMap = MODEL_CODE_MAP[modelType] as Record<string, string> | undefined
      if (!modelMap) throw new Error(`Unknown model type: ${modelType}`)
      const model = modelMap[resolution]
      if (!model) throw new Error(`Unknown resolution for ${modelType}: ${resolution}`)
      resolvedModel = model

      const params: Record<string, unknown> = {
        aspect_ratio: aspectRatio,
        ...(model === 'gpt-image-2' ? {} : { resolution }),
        watermark,
      }

      if (referenceImages.length > 0) {
        params.image = await Promise.all(referenceImages.map(async (img) => {
          if (img.dataUrl) return img.dataUrl
          if (img.file) return fileToDataUrl(img.file)
          return imageUrlToDataUrl(img.previewUrl)
        }))
      }

      const body: GenerateImageRequest = {
        idempotency_key: randomUUID(),
        model,
        prompt: prompt.trim(),
        quantity,
        params,
        workspace_id: activeWorkspaceId ?? '',
      }

      const batch = await apiPost<BatchResponse>('/generate/image', body)
      setActiveBatchId(batch.id)
      return batch
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
      const normalized = rawMessage.toLowerCase()
      const errorCode =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'TIMEOUT'
          : /failed to fetch|fetch failed|networkerror|network request failed|load failed/.test(normalized)
            ? 'NETWORK_ERROR'
            : err instanceof SyntaxError
              ? 'PARSE_ERROR'
              : 'CLIENT_ERROR'

      void reportClientSubmissionError({
        error_code: errorCode,
        detail: rawMessage.slice(0, 500) || undefined,
        http_status: err instanceof ApiError ? err.status : null,
        model: resolvedModel,
      })
      if (err && typeof err === 'object') {
        ;(err as { __clientErrorReported?: boolean }).__clientErrorReported = true
      }
      throw err
    } finally {
      setIsGenerating(false)
    }
  }, [prompt, modelType, resolution, quantity, aspectRatio, referenceImages, watermark, activeWorkspaceId, setIsGenerating, setActiveBatchId])

  return { generate }
}
