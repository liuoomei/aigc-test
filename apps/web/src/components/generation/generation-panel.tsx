'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { randomUUID } from 'crypto' 
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useGenerationStore } from '@/stores/generation-store'
import { useGenerate } from '@/hooks/use-generate'
import { useVideoGenerate } from '@/hooks/use-video-generate'
import { useTeamFeatures } from '@/hooks/use-team-features'
import { useAuthStore } from '@/stores/auth-store'
import { useGenerationDefaults } from '@/hooks/use-generation-defaults'
import { Sparkles, Loader2, Coins, Image as ImageIcon, Video, Zap, Target, ImagePlus, Trash2, Search, Film, X, UserSquare2, Music, Clapperboard, Play } from 'lucide-react'
import type { BatchResponse } from '@aigc/types'
import { toast } from 'sonner'
import { ApiError, fetchWithAuth, getRequestErrorMessage, reportClientSubmissionError } from '@/lib/api-client'
import { ReferenceImageUploadCompact } from './reference-image-upload-compact'
import { CompanyAImagePicker } from './company-a-image-picker'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { cn } from '@/lib/utils'
import Image from 'next/image'
import { IMAGE_MODEL_CREDITS, VIDEO_PER_SECOND_CREDITS, VIDEO_FLAT_CREDITS } from '@/lib/credits'

const MAX_REF_IMAGES = 10
const MAX_FILE_MB = 20
const MAX_MULTIMODAL_IMAGES = 9
const MAX_MULTIMODAL_VIDEOS = 3
const MAX_MULTIMODAL_AUDIOS = 3
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const ALLOWED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif']
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm']
const ALLOWED_VIDEO_EXTS = ['mp4', 'mov', 'webm']
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/x-m4a']
const ALLOWED_AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac']

function isValidImageFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ALLOWED_IMAGE_TYPES.includes(file.type) || ALLOWED_IMAGE_EXTS.includes(ext)
}
function isValidVideoFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ALLOWED_VIDEO_TYPES.includes(file.type) || ALLOWED_VIDEO_EXTS.includes(ext)
}
function isValidAudioFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ALLOWED_AUDIO_TYPES.includes(file.type) || ALLOWED_AUDIO_EXTS.includes(ext)
}

type ModelResolution = '1k' | '2k' | '3k' | '4k'

const MODEL_OPTIONS: Array<{
  value: 'gemini' | 'gpt-image-2' | 'nano-banana-pro' | 'seedream-5.0-lite' | 'seedream-4.5' | 'seedream-4.0'
  label: string
  icon: React.ElementType
  desc: string
  credits: number
  resolutions: ModelResolution[]
  supportsWatermark: boolean
}> = [
  {
    value: 'gemini',
    label: '全能图片2',
    icon: Zap,
    desc: '快速生成，适合日常使用',
    credits: IMAGE_MODEL_CREDITS['gemini'],
    resolutions: ['1k', '2k', '4k'],
    supportsWatermark: false,
  },
  {
    value: 'gpt-image-2',
    label: '超能图片2',
    icon: Zap,
    desc: '文字渲染准确，UI截图逼真，照片级真实感',
    credits: IMAGE_MODEL_CREDITS['gpt-image-2'],
    resolutions: ['2k'],
    supportsWatermark: false,
  },
  {
    value: 'nano-banana-pro',
    label: '全能图片Pro',
    icon: Target,
    desc: '高质量输出，细节丰富',
    credits: IMAGE_MODEL_CREDITS['nano-banana-pro'],
    resolutions: ['1k', '2k', '4k'],
    supportsWatermark: false,
  },
  {
    value: 'seedream-5.0-lite',
    label: 'Seedream 5.0',
    icon: Sparkles,
    desc: '最新火山引擎模型，联网搜索增强',
    credits: IMAGE_MODEL_CREDITS['seedream-5.0-lite'],
    resolutions: ['2k', '3k'],
    supportsWatermark: true,
  },
  {
    value: 'seedream-4.5',
    label: 'Seedream 4.5',
    icon: Sparkles,
    desc: '高分辨率图像生成',
    credits: IMAGE_MODEL_CREDITS['seedream-4.5'],
    resolutions: ['2k', '4k'],
    supportsWatermark: true,
  },
  {
    value: 'seedream-4.0',
    label: 'Seedream 4.0',
    icon: Sparkles,
    desc: '多分辨率图像生成',
    credits: IMAGE_MODEL_CREDITS['seedream-4.0'],
    resolutions: ['1k', '2k', '4k'],
    supportsWatermark: true,
  },
]

const ALL_RESOLUTION_OPTIONS: Array<{ value: ModelResolution; label: string }> = [
  { value: '1k', label: '1K' },
  { value: '2k', label: '2K' },
  { value: '3k', label: '3K' },
  { value: '4k', label: '4K' },
]

const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
] as const

const QUANTITY_OPTIONS = [1, 2, 3, 4] as const

const VIDEO_MODEL_OPTIONS = {
  multimodal: [
    { value: 'seedance-2.0', label: 'Seedance 2.0', desc: '高级有声视频生成，支持多模态', credits: VIDEO_PER_SECOND_CREDITS['seedance-2.0'], isSeedance: true },
    { value: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast', desc: '快速有声视频生成，支持多模态', credits: VIDEO_PER_SECOND_CREDITS['seedance-2.0-fast'], isSeedance: true },
  ],
  frames: [
    { value: 'veo3.1-fast', label: '全能视频3.1 Fast', desc: '快速高质量视频生成', credits: VIDEO_FLAT_CREDITS['veo3.1-fast'], isSeedance: false },
    { value: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro', desc: '有声视频生成，支持首尾帧', credits: VIDEO_PER_SECOND_CREDITS['seedance-1.5-pro'], isSeedance: true },
    { value: 'seedance-2.0', label: 'Seedance 2.0', desc: '新一代有声视频，支持首尾帧', credits: VIDEO_PER_SECOND_CREDITS['seedance-2.0'], isSeedance: true },
    { value: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast', desc: '新一代快速视频，支持首尾帧', credits: VIDEO_PER_SECOND_CREDITS['seedance-2.0-fast'], isSeedance: true },
  ],
  components: [
    { value: 'veo3.1-components', label: '全能视频3.1', desc: '基于参考图片生成视频', credits: VIDEO_FLAT_CREDITS['veo3.1-components'], isSeedance: false },
    { value: 'seedance-2.0', label: 'Seedance 2.0', desc: '新一代有声视频，支持参考图', credits: VIDEO_PER_SECOND_CREDITS['seedance-2.0'], isSeedance: true },
    { value: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast', desc: '新一代快速视频，支持参考图', credits: VIDEO_PER_SECOND_CREDITS['seedance-2.0-fast'], isSeedance: true },
  ],
}

const VIDEO_ASPECT_RATIOS_DEFAULT = [
  { value: '', label: '自动' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
]

const VIDEO_ASPECT_RATIOS_SEEDANCE = [
  { value: 'adaptive', label: '自适应' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '21:9', label: '21:9' },
]

const VIDEO_RESOLUTIONS = [
  { value: false, label: '720p', desc: '标准' },
  { value: true, label: '1080p', desc: '高清' },
] as const

const SEEDANCE_DURATION_OPTIONS = [
  { value: -1,  label: '自动' },
  { value: 4,   label: '4秒' },
  { value: 5,   label: '5秒' },
  { value: 6,   label: '6秒' },
  { value: 8,   label: '8秒' },
  { value: 10,  label: '10秒' },
  { value: 12,  label: '12秒' },
  { value: 15,  label: '15秒' },
] as const

interface FrameImage {
  id?: string
  previewUrl: string
  dataUrl: string
  file?: File
}

async function getActionImagePayload(image: FrameImage): Promise<{ base64: string; mime: 'image/jpeg' | 'image/png' }> {
  const dataUrl = image.dataUrl.startsWith('data:')
    ? image.dataUrl
    : await fetch(image.dataUrl).then(async (r) => {
      if (!r.ok) throw new Error('reference image fetch failed')
      const blob = await r.blob()
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    })
  const [header, base64] = dataUrl.split(',')
  const rawMime = header?.replace('data:', '').replace(';base64', '')
  const mime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime
  if ((mime !== 'image/jpeg' && mime !== 'image/png') || !base64) {
    throw new Error('ACTION_IMAGE_UNSUPPORTED_FORMAT')
  }
  return { base64, mime }
}

interface GenerationPanelProps {
  onBatchCreated: (batch: BatchResponse) => void
  disabled?: boolean
  initialMode?: 'image' | 'video' | 'avatar' | 'action_imitation'
}

export function GenerationPanel({ onBatchCreated, disabled, initialMode = 'image' }: GenerationPanelProps) {
  const {
    prompt,
    setPrompt,
    modelType,
    setModelType,
    resolution,
    setResolution,
    quantity,
    setQuantity,
    aspectRatio,
    setAspectRatio,
    referenceImages,
    addReferenceImage,
    watermark,
    setWatermark,
    isGenerating,
    videoParams,
    saveAsDefaults,
    saveVideoDefaults,
    saveAvatarDefaults,
    videoDefaults,
    avatarDefaults,
    userDefaults,
    applyServerDefaults,
  } = useGenerationStore()

  const { load: loadDefaults, save: saveDefaults } = useGenerationDefaults()

  // Load server-side defaults once on mount
  useEffect(() => {
    loadDefaults().then((d) => {
      if (d.video) {
        if (d.video.videoModel) setVideoModel(d.video.videoModel)
        if (d.video.videoAspectRatio !== undefined) setVideoAspectRatio(d.video.videoAspectRatio)
        if (d.video.videoUpsample !== undefined) setVideoUpsample(d.video.videoUpsample)
        if (d.video.videoDuration !== undefined) setVideoDuration(d.video.videoDuration)
        if (d.video.videoGenerateAudio !== undefined) setVideoGenerateAudio(d.video.videoGenerateAudio)
        if (d.video.videoCameraFixed !== undefined) setVideoCameraFixed(d.video.videoCameraFixed)
      }
      if (d.avatar?.avatarResolution) {
        setAvatarResolution(d.avatar.avatarResolution as '720p' | '1080p')
      }
      applyServerDefaults({
        userDefaults: d.image ? {
          modelType: (d.image.modelType as any) ?? 'gemini',
          resolution: (d.image.resolution as any) ?? '2k',
          aspectRatio: d.image.aspectRatio ?? '1:1',
          quantity: d.image.quantity ?? 1,
          watermark: d.image.watermark ?? false,
        } : null,
        videoDefaults: d.video ? {
          videoModel: d.video.videoModel ?? 'seedance-2.0',
          videoAspectRatio: d.video.videoAspectRatio ?? '',
          videoUpsample: d.video.videoUpsample ?? false,
          videoDuration: d.video.videoDuration ?? 5,
          videoGenerateAudio: d.video.videoGenerateAudio ?? true,
          videoCameraFixed: d.video.videoCameraFixed ?? false,
        } : null,
        avatarDefaults: d.avatar ? {
          avatarResolution: (d.avatar.avatarResolution as any) ?? '720p',
        } : null,
      })
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const clearReferenceImages = useGenerationStore((s) => s.clearReferenceImages)
  const pendingModule = useGenerationStore((s) => s.pendingModule)
  const clearPendingModule = useGenerationStore((s) => s.clearPendingModule)

  const [mode, setMode] = useState<'image' | 'video' | 'avatar' | 'action_imitation'>(initialMode)
  const [imageDialogOpen, setImageDialogOpen] = useState(false)
  const [companyAPickerOpen, setCompanyAPickerOpen] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Video mode state
  const [videoMode, setVideoMode] = useState<'frames' | 'components' | 'multimodal'>('multimodal')
  const [isVideoUploading, setIsVideoUploading] = useState(false)   // 素材上传中（上传完才调 generateVideo）
  const [videoPrompt, setVideoPrompt] = useState('')
  const [videoModel, setVideoModel] = useState(() => videoDefaults?.videoModel ?? 'seedance-2.0')
  const [videoAspectRatio, setVideoAspectRatio] = useState(() => videoDefaults?.videoAspectRatio ?? '')
  const [videoUpsample, setVideoUpsample] = useState(() => videoDefaults?.videoUpsample ?? false)
  const [videoDuration, setVideoDuration] = useState<number>(() => videoDefaults?.videoDuration ?? 5)
  const [videoGenerateAudio, setVideoGenerateAudio] = useState(() => videoDefaults?.videoGenerateAudio ?? true)
  const [videoCameraFixed, setVideoCameraFixed] = useState(() => videoDefaults?.videoCameraFixed ?? false)
  const [firstFrame, setFirstFrame] = useState<FrameImage | null>(null)
  const [lastFrame, setLastFrame] = useState<FrameImage | null>(null)
  const [framePreviewIndex, setFramePreviewIndex] = useState<0 | 1 | null>(null)
  const firstFrameRef = useRef<HTMLInputElement>(null)
  const lastFrameRef = useRef<HTMLInputElement>(null)

  // Reference components mode state
  const [videoReferenceImages, setVideoReferenceImages] = useState<FrameImage[]>([])
  const [referencePreviewIndex, setReferencePreviewIndex] = useState<number | null>(null)
  const referenceInputRef = useRef<HTMLInputElement>(null)
  const [isReferenceDragging, setIsReferenceDragging] = useState(false)
  const referenceDragCounterRef = useRef(0)

  // Multimodal mode state
  const [multimodalImages, setMultimodalImages] = useState<FrameImage[]>([])
  const [multimodalVideos, setMultimodalVideos] = useState<{ id: string; file: File; previewUrl: string; name: string; duration: number }[]>([])
  const [multimodalAudios, setMultimodalAudios] = useState<{ id: string; file: File; previewUrl: string; name: string; duration: number }[]>([])
  const [multimodalManagerOpen, setMultimodalManagerOpen] = useState(false)
  const [isMultimodalDragging, setIsMultimodalDragging] = useState(false)
  const multimodalDragCounterRef = useRef(0)
  const multimodalImageInputRef = useRef<HTMLInputElement>(null)
  const multimodalVideoInputRef = useRef<HTMLInputElement>(null)
  const multimodalAudioInputRef = useRef<HTMLInputElement>(null)
  const multimodalAllInputRef = useRef<HTMLInputElement>(null)
  // 统一预览层：null=关闭，否则为当前预览的素材信息
  const [mediaPreview, setMediaPreview] = useState<
    | { type: 'image'; url: string; name: string; index: number; total: number }
    | { type: 'video'; url: string; name: string }
    | { type: 'audio'; url: string; name: string; duration: number }
    | null
  >(null)

  // Avatar (数字人) mode state
  const [avatarImage, setAvatarImage] = useState<FrameImage | null>(null)
  const [avatarAudio, setAvatarAudio] = useState<{ id: string; name: string; dataUrl: string; duration: number } | null>(null)
  const [avatarPrompt, setAvatarPrompt] = useState('')
  const [avatarResolution, setAvatarResolution] = useState<'720p' | '1080p'>(() => avatarDefaults?.avatarResolution ?? '720p')
  const [isAvatarGenerating, setIsAvatarGenerating] = useState(false)
  const avatarImageRef = useRef<HTMLInputElement>(null)
  const avatarAudioRef = useRef<HTMLInputElement>(null)

  // Action Imitation (动作模仿) mode state
  const [actionImage, setActionImage] = useState<FrameImage | null>(null)
  const [actionVideo, setActionVideo] = useState<{ file: File; previewUrl: string; duration: number; name: string } | null>(null)
  const [actionVideoPreviewOpen, setActionVideoPreviewOpen] = useState(false)
  const [isActionGenerating, setIsActionGenerating] = useState(false)
  const actionImageRef = useRef<HTMLInputElement>(null)
  const actionVideoRef = useRef<HTMLInputElement>(null)

  const { isCompanyA, showVideoTab, showAvatarTab, showActionImitationTab } = useTeamFeatures()
  const activeWorkspaceId = useAuthStore((s) => s.activeWorkspaceId)
  const isSeedance = videoModel.startsWith('seedance-')

  // Switch to the right tab when applyBatch is called (from history / assets)
  useEffect(() => {
    if (!pendingModule) return
    if (pendingModule === 'video') {
      if (videoParams) {
        setVideoPrompt(videoParams.videoPrompt)
        setVideoModel(videoParams.videoModel)
        setVideoAspectRatio(videoParams.videoAspectRatio)
        setVideoUpsample(videoParams.videoUpsample)
        if (videoParams.videoDuration !== undefined) setVideoDuration(videoParams.videoDuration)
        if (videoParams.videoGenerateAudio !== undefined) setVideoGenerateAudio(videoParams.videoGenerateAudio)
        if (videoParams.videoCameraFixed !== undefined) setVideoCameraFixed(videoParams.videoCameraFixed)
      }
      setMode('video')
    } else if (pendingModule === 'avatar') {
      setAvatarPrompt(prompt)
      setMode('avatar')
    } else if (pendingModule === 'action_imitation') {
      setMode('action_imitation')
    } else {
      setMode('image')
    }
    clearPendingModule()
  }, [pendingModule]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset resolution if the selected model doesn't support the current resolution
  useEffect(() => {
    const model = MODEL_OPTIONS.find(m => m.value === modelType)
    if (model && !model.resolutions.includes(resolution as ModelResolution)) {
      setResolution(model.resolutions[0])
    }
  }, [modelType]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset video aspect ratio when switching between Seedance and non-Seedance
  useEffect(() => {
    const isSeedance = videoModel.startsWith('seedance-')
    if (isSeedance && !VIDEO_ASPECT_RATIOS_SEEDANCE.find(r => r.value === videoAspectRatio)) {
      setVideoAspectRatio('adaptive')
    } else if (!isSeedance && !VIDEO_ASPECT_RATIOS_DEFAULT.find(r => r.value === videoAspectRatio)) {
      setVideoAspectRatio('')
    }
    // seedance-2.0-fast does not support 1080p — downgrade if needed
    if (videoModel === 'seedance-2.0-fast' && videoUpsample) {
      setVideoUpsample(false)
    }
  }, [videoModel]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure current tab is allowed by team feature flags
  useEffect(() => {
    if (mode === 'avatar' && !showAvatarTab) {
      setMode('image')
      return
    }
    if (mode === 'action_imitation' && !showActionImitationTab) {
      setMode('image')
    }
  }, [mode, showAvatarTab, showActionImitationTab])

  // Process dropped / selected image files
  const handleImageFiles = useCallback(async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      if (referenceImages.length >= MAX_REF_IMAGES) {
        toast.error(`最多添加 ${MAX_REF_IMAGES} 张参考图`)
        break
      }

      if (!isValidImageFile(file)) {
        toast.error(`文件「${file.name}」格式不支持，请上传 JPG / PNG / WEBP 格式的图片`)
        continue
      }

      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        toast.error(`图片「${file.name}」过大（${(file.size / 1024 / 1024).toFixed(1)} MB），单张不超过 ${MAX_FILE_MB} MB`)
        continue
      }

      const previewUrl = URL.createObjectURL(file)
      addReferenceImage({
        id: randomUUID(),
        file,
        previewUrl,
      })
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [referenceImages.length, addReferenceImage])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const getDraggedAsset = (dataTransfer: React.DragEvent['dataTransfer']) => ({
    url: dataTransfer.getData('application/x-aigc-asset-url') || dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain'),
    type: dataTransfer.getData('application/x-aigc-asset-type'),
  })

  async function fetchAssetFile(url: string, assetType: string, baseName: string) {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error('fetch failed')
    const blob = await resp.blob()
    const fallbackExt = assetType === 'video' ? 'mp4' : assetType === 'audio' ? 'mp3' : 'jpg'
    const ext = blob.type.split('/')[1] || fallbackExt
    const mime = blob.type || (assetType === 'video' ? 'video/mp4' : assetType === 'audio' ? 'audio/mpeg' : 'image/jpeg')
    return new File([blob], `${baseName}.${ext}`, { type: mime })
  }

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const estimatedCredits = (IMAGE_MODEL_CREDITS[modelType] ?? 5) * quantity

  // Handle Company A image selection — fetch as blob so it integrates with existing upload flow
  const handleSelectCompanyAImage = useCallback(async (url: string, name: string) => {
    if (referenceImages.length >= MAX_REF_IMAGES) {
      toast.error(`最多添加 ${MAX_REF_IMAGES} 张参考图`)
      return
    }
    addReferenceImage({
      id: randomUUID(),
      previewUrl: url,
    })
    toast.success('已添加参考图，提交时会自动加载原图')
  }, [referenceImages.length, addReferenceImage])
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      await handleImageFiles(e.dataTransfer.files)
      return
    }
    const asset = getDraggedAsset(e.dataTransfer)
    if (asset.url) {
      if (asset.type === 'video') {
        toast.error('当前参考区不支持视频参考，请切换到视频的全能参考或动作模仿视频区域')
        return
      }
      await handleSelectCompanyAImage(asset.url, 'asset')
    }
  }, [handleImageFiles, handleSelectCompanyAImage])
  const { generate } = useGenerate()
  const { generate: generateVideo, isGenerating: isVideoGenerating } = useVideoGenerate()

  const handleAvatarGenerate = async () => {
    if (!avatarImage || !avatarAudio) return
    setIsAvatarGenerating(true)
    try {
      const token = useAuthStore.getState().accessToken ?? ''

      // Upload image
      const imageFormData = new FormData()
      const imageBlob = await fetch(avatarImage.dataUrl).then(r => r.blob())
      imageFormData.append('file', imageBlob, `avatar-image.${imageBlob.type.split('/')[1] || 'jpg'}`)
      const imageUploadRes = await fetch('/api/v1/avatar/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: imageFormData,
      })
      if (!imageUploadRes.ok) throw new ApiError(imageUploadRes.status, 'UPLOAD_ERROR', '图片上传失败')
      const imageUpload = (await imageUploadRes.json()) as { url: string }

      // Upload audio
      const audioFormData = new FormData()
      const audioBlob = await fetch(avatarAudio.dataUrl).then(r => r.blob())
      audioFormData.append('file', audioBlob, avatarAudio.name)
      const audioUploadRes = await fetch('/api/v1/avatar/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: audioFormData,
      })
      if (!audioUploadRes.ok) throw new ApiError(audioUploadRes.status, 'UPLOAD_ERROR', '音频上传失败')
      const audioUpload = (await audioUploadRes.json()) as { url: string }

      // Submit generation
      const res = await fetch('/api/v1/avatar/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspace_id: activeWorkspaceId,
          image_url: imageUpload.url,
          audio_url: audioUpload.url,
          audio_duration: avatarAudio.duration,
          prompt: avatarPrompt.trim() || undefined,
          resolution: avatarResolution,
        }),
      })
      const batch = await res.json()
      if (!res.ok) {
        throw new ApiError(res.status, batch?.error?.code ?? 'AVATAR_ERROR', batch?.error?.message ?? '数字人生成失败')
      }
      onBatchCreated(batch)
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
      })
      toast.error(getRequestErrorMessage(err, '数字人生成请求失败，请稍后重试'))
    } finally {
      setIsAvatarGenerating(false)
    }
  }

  const handleActionImitationGenerate = async () => {
    if (!actionImage || !actionVideo) return
    setIsActionGenerating(true)
    try {
      const token = useAuthStore.getState().accessToken ?? ''

      // Upload video
      const videoFormData = new FormData()
      videoFormData.append('file', actionVideo.file, actionVideo.name)
      const videoUploadRes = await fetch('/api/v1/action-imitation/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: videoFormData,
      })
      if (!videoUploadRes.ok) throw new ApiError(videoUploadRes.status, 'UPLOAD_ERROR', '视频上传失败')
      const videoUpload = (await videoUploadRes.json()) as { url: string }

      const actionImagePayload = await getActionImagePayload(actionImage)

      // Submit generation
      const res = await fetch('/api/v1/action-imitation/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspace_id: activeWorkspaceId,
          image_base64: actionImagePayload.base64,
          image_mime: actionImagePayload.mime,
          video_url: videoUpload.url,
          video_duration: actionVideo.duration,
        }),
      })
      const batch = await res.json()
      if (!res.ok) {
        throw new ApiError(res.status, batch?.error?.code ?? 'ACTION_IMITATION_ERROR', batch?.error?.message ?? '动作模仿生成失败')
      }
      onBatchCreated(batch)
    } catch (err) {
      if (err instanceof Error && err.message === 'ACTION_IMAGE_UNSUPPORTED_FORMAT') {
        toast.error('动作模仿仅支持 JPG / PNG 人物图片，请更换图片')
        return
      }
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
      })
      toast.error(getRequestErrorMessage(err, '动作模仿生成请求失败，请稍后重试'))
    } finally {
      setIsActionGenerating(false)
    }
  }

  const handleGenerate = async () => {
    try {
      const batch = await generate()
      if (batch) {
        onBatchCreated(batch)
      }
    } catch (err) {
      toast.error(getRequestErrorMessage(err, '生成请求失败，请稍后重试'))
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isGenerating && !disabled) {
      handleGenerate()
    }
  }

  const readFrameFile = useCallback(async (file: File, silent = false): Promise<FrameImage | null> => {
    if (!isValidImageFile(file)) {
      if (!silent) toast.error(`文件「${file.name}」格式不支持，请上传 JPG / PNG / WEBP 格式的图片`)
      return null
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      if (!silent) toast.error(`图片「${file.name}」过大（${(file.size / 1024 / 1024).toFixed(1)} MB），不超过 ${MAX_FILE_MB} MB`)
      return null
    }
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve({
        id: randomUUID(),
        previewUrl: URL.createObjectURL(file),
        dataUrl: reader.result as string,
        file,
      })
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }, [])

  // Handle reference images for components mode
  const handleReferenceFiles = useCallback(async (files: FileList | null) => {
    if (!files) return
    const MAX_COMPONENT_IMAGES = 3
    const newImages: FrameImage[] = []
    for (const file of Array.from(files)) {
      if (videoReferenceImages.length + newImages.length >= MAX_COMPONENT_IMAGES) {
        toast.error(`最多添加 ${MAX_COMPONENT_IMAGES} 张参考图`)
        break
      }
      const img = await readFrameFile(file)
      if (img) newImages.push(img)
    }
    setVideoReferenceImages(prev => [...prev, ...newImages])
    if (referenceInputRef.current) referenceInputRef.current.value = ''
  }, [videoReferenceImages.length, readFrameFile])

  const handleReferenceDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    referenceDragCounterRef.current++
    if (referenceDragCounterRef.current === 1) setIsReferenceDragging(true)
  }, [])

  const handleReferenceDragLeave = useCallback(() => {
    referenceDragCounterRef.current--
    if (referenceDragCounterRef.current === 0) setIsReferenceDragging(false)
  }, [])

  const handleReferenceDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleReferenceDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    referenceDragCounterRef.current = 0
    setIsReferenceDragging(false)
    if (e.dataTransfer.files.length > 0) {
      await handleReferenceFiles(e.dataTransfer.files)
      return
    }
    const asset = getDraggedAsset(e.dataTransfer)
    if (asset.url) {
      const looksLikeAssetImage = asset.type === 'image' || !asset.type
      if (looksLikeAssetImage) {
        if (videoReferenceImages.length >= 3) {
          toast.error('最多添加 3 张参考图')
          return
        }
        setVideoReferenceImages(prev => prev.length < 3 ? [...prev, {
          id: randomUUID(),
          previewUrl: asset.url,
          dataUrl: asset.url,
        }] : prev)
        return
      }
      try {
        const file = await fetchAssetFile(asset.url, asset.type, 'asset')
        if (isValidImageFile(file)) {
          const img = await readFrameFile(file)
          if (img) setVideoReferenceImages(prev => prev.length < 3 ? [...prev, img] : prev)
          return
        }
        toast.error('当前参考区只支持图片参考')
      } catch {
        toast.error('图片加载失败，请确认网络可访问图片服务器')
      }
    }
  }, [handleReferenceFiles, readFrameFile])

  const handleFrameDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const asset = getDraggedAsset(e.dataTransfer)
    if (!asset.url) return
    if (asset.type === 'video') {
      toast.error('首尾帧区域不支持视频参考，请切换到全能参考或动作模仿的视频区域')
      return
    }
    const looksLikeAssetImage = asset.type === 'image' || !asset.type
    if (looksLikeAssetImage) {
      if (!firstFrame) {
        setFirstFrame({ id: randomUUID(), previewUrl: asset.url, dataUrl: asset.url })
        return
      }
      setLastFrame({ id: randomUUID(), previewUrl: asset.url, dataUrl: asset.url })
      return
    }
    try {
      const file = await fetchAssetFile(asset.url, asset.type, 'frame')
      const img = await readFrameFile(file)
      if (!img) return
      if (!firstFrame) {
        setFirstFrame(img)
        return
      }
      setLastFrame(img)
    } catch {
      toast.error('图片加载失败，请确认网络可访问图片服务器')
    }
  }, [firstFrame, readFrameFile])

  const handleActionVideoDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const asset = getDraggedAsset(e.dataTransfer)
    if (!asset.url) return
    if (asset.type !== 'video') {
      toast.error('当前区域只支持视频参考，请拖拽视频资产')
      return
    }
    try {
      const file = await fetchAssetFile(asset.url, asset.type, 'action-video')
      if (!isValidVideoFile(file)) {
        toast.error(`文件「${file.name}」格式不支持，请上传 MP4 / MOV / WEBM 格式的视频`)
        return
      }
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      video.src = url
      video.onloadedmetadata = () => {
        const dur = video.duration
        URL.revokeObjectURL(url)
        if (dur > 30) { toast.error('驱动视频时长不能超过 30 秒'); return }
        const previewUrl = URL.createObjectURL(file)
        setActionVideo({ file, previewUrl, duration: dur, name: file.name })
      }
    } catch {
      toast.error('视频加载失败，请确认网络可访问视频服务器')
    }
  }, [])

  const handleActionImageDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const asset = getDraggedAsset(e.dataTransfer)
    if (!asset.url) return
    if (asset.type === 'video') {
      toast.error('当前区域只支持图片参考，请拖拽图片资产')
      return
    }
    try {
      const file = await fetchAssetFile(asset.url, asset.type, 'action-image')
      if (file.size > 4.7 * 1024 * 1024) { toast.error('人物图片不能超过 4.7 MB'); return }
      const img = await readFrameFile(file, true)
      if (img) setActionImage(img)
    } catch {
      toast.error('图片加载失败，请确认网络可访问图片服务器')
    }
  }, [readFrameFile])

  const handleAvatarImageDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const asset = getDraggedAsset(e.dataTransfer)
    if (!asset.url) return
    if (asset.type === 'video') {
      toast.error('当前区域只支持图片参考，请拖拽图片资产')
      return
    }
    try {
      const file = await fetchAssetFile(asset.url, asset.type, 'avatar-image')
      if (file.size > 5 * 1024 * 1024) { toast.error('人物图片不能超过 5 MB'); return }
      const img = await readFrameFile(file, true)
      if (img) setAvatarImage(img)
    } catch {
      toast.error('图片加载失败，请确认网络可访问图片服务器')
    }
  }, [readFrameFile])

  const handleAvatarAudioDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const asset = getDraggedAsset(e.dataTransfer)
    if (!asset.url) return
    toast.error('当前区域不支持视频参考，请上传音频文件')
  }, [])

  const removeReferenceImage = useCallback((index: number) => {
    setVideoReferenceImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  const clearReferenceImagesVideo = useCallback(() => {
    setVideoReferenceImages([])
  }, [])

  // Multimodal computed values
  const totalMultimodalCount = multimodalImages.length + multimodalVideos.length + multimodalAudios.length

  // Up to 3 stack previews: images first, then videos, then audio placeholders
  const multimodalStackPreviews: { id: string; type: 'image' | 'video' | 'audio'; previewUrl: string }[] = [
    ...multimodalImages.slice(0, 3).map(img => ({ id: img.id ?? img.previewUrl, type: 'image' as const, previewUrl: img.previewUrl })),
    ...multimodalVideos.slice(0, 3).map(v => ({ id: v.id, type: 'video' as const, previewUrl: v.previewUrl })),
    ...multimodalAudios.slice(0, 3).map(a => ({ id: a.id, type: 'audio' as const, previewUrl: '' })),
  ].slice(0, 3)

  const handleMultimodalDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    multimodalDragCounterRef.current++
    if (multimodalDragCounterRef.current === 1) setIsMultimodalDragging(true)
  }, [])

  const handleMultimodalDragLeave = useCallback(() => {
    multimodalDragCounterRef.current--
    if (multimodalDragCounterRef.current === 0) setIsMultimodalDragging(false)
  }, [])

  // Seedance 模型：所有参考视频的总时长不能超过 15.2 秒
  const SEEDANCE_MAX_TOTAL_VIDEO_DURATION = 15.2

  // 统一的视频校验 + 添加逻辑，供主上传区和素材管理弹窗共用
  const validateAndAddVideo = useCallback((f: File, isSeedance: boolean = false) => {
    if (f.size > 52428800) {
      toast.error(`视频 "${f.name}" 文件过大 (${(f.size / 1024 / 1024).toFixed(1)} MB)，最大支持 50 MB，请压缩后重新添加。`)
      return
    }

    // Seedance format validation
    if (isSeedance) {
      const validTypes = ['video/mp4', 'video/quicktime'];
      if (!validTypes.includes(f.type)) {
        toast.error(`视频 "${f.name}" 格式不支持，Seedance模型仅支持 MP4 / MOV 格式。`)
        return
      }
    }

    const url = URL.createObjectURL(f)
    const video = document.createElement('video')
    video.src = url
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      const pixels = video.videoWidth * video.videoHeight
      const aspectRatio = video.videoWidth / video.videoHeight

      // Seedance specific validations
      if (isSeedance) {
        if (aspectRatio < 0.4 || aspectRatio > 2.5) {
          toast.error(`视频 "${f.name}" 宽高比为 ${aspectRatio.toFixed(2)}，Seedance模型支持的宽高比需在 [0.4, 2.5] 之间。`)
          return
        }
        if (video.videoWidth < 300 || video.videoHeight < 300 || video.videoWidth > 6000 || video.videoHeight > 6000) {
          toast.error(`视频 "${f.name}" 尺寸不符合要求，Seedance模型要求宽和高需在 [300, 6000] 像素之间。`)
          return
        }
        if (pixels < 409600) {
           toast.error(`视频 "${f.name}" 分辨率过低 (${video.videoWidth}x${video.videoHeight})，Seedance模型要求总像素数不低于 640x640。`)
           return
        }
      }

      if (isSeedance && pixels > 927408) {
        toast.error(`视频 "${f.name}" 分辨率过高 (${video.videoWidth}x${video.videoHeight})，Seedance模型最大支持 720p，请降低分辨率后重新添加。`)
        return
      } else if (!isSeedance && pixels > 927408) {
        toast.error(`视频 "${f.name}" 分辨率过高 (${video.videoWidth}x${video.videoHeight})，最高支持 720p，请降低分辨率后重新添加。`)
        return
      }

      if (isSeedance) {
        if (video.duration < 2) {
          toast.error(`视频 "${f.name}" 时长过短 (${video.duration.toFixed(1)}s)，Seedance模型要求单个视频时长不少于 2 秒。`)
          return
        }
        if (video.duration > SEEDANCE_MAX_TOTAL_VIDEO_DURATION) {
          toast.error(`视频 "${f.name}" 时长过长 (${video.duration.toFixed(1)}s)，单个视频不超过 ${SEEDANCE_MAX_TOTAL_VIDEO_DURATION} 秒。`)
          return
        }
      } else {
        if (video.duration > 15.2) {
          toast.error(`视频 "${f.name}" 时长过长 (${video.duration.toFixed(1)}s)，最长支持 15 秒，请裁剪后重新添加。`)
          return
        }
      }

      const newDuration = video.duration
      const previewUrl = URL.createObjectURL(f)

      setMultimodalVideos(prev => {
        if (prev.length >= 3) return prev

        // Seedance：校验加入后的总时长是否超限
        if (isSeedance) {
          const currentTotal = prev.reduce((sum, v) => sum + v.duration, 0)
          if (currentTotal + newDuration > SEEDANCE_MAX_TOTAL_VIDEO_DURATION) {
            const remaining = SEEDANCE_MAX_TOTAL_VIDEO_DURATION - currentTotal
            toast.error(
              `视频 "${f.name}" 时长 ${newDuration.toFixed(1)}s 加入后总时长将超过 ${SEEDANCE_MAX_TOTAL_VIDEO_DURATION}s 限制` +
              `（当前已用 ${currentTotal.toFixed(1)}s，剩余可用 ${remaining.toFixed(1)}s），请使用更短的视频。`
            )
            return prev
          }
        }

        return [...prev, { id: randomUUID(), file: f, previewUrl, name: f.name, duration: newDuration }]
      })
    }
  }, [])

  // 统一的音频校验 + 添加逻辑，供主上传区和素材管理弹窗共用
  const validateAndAddAudio = useCallback((f: File, isSeedance: boolean = false) => {
    if (f.size > 52428800) {
      toast.error(`音频 "${f.name}" 文件过大 (${(f.size / 1024 / 1024).toFixed(1)} MB)，最大支持 50 MB，请压缩后重新添加。`)
      return
    }
    const url = URL.createObjectURL(f)
    const audio = document.createElement('audio')
    audio.src = url
    audio.onloadedmetadata = () => {
      if (audio.duration > 15.2) {
        URL.revokeObjectURL(url)
        toast.error(`音频 "${f.name}" 时长过长 (${audio.duration.toFixed(1)}s)，最长支持 15 秒，请裁剪后重新添加。`)
        return
      }
      setMultimodalAudios(prev => prev.length < 3 ? [...prev, {
        id: randomUUID(), file: f, previewUrl: url, name: f.name, duration: audio.duration,
      }] : prev)
    }
  }, [])

  const handleMultimodalFiles = useCallback(async (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      if (isValidImageFile(f)) {
        if (multimodalImages.length >= MAX_MULTIMODAL_IMAGES) {
          toast.error(`最多添加 ${MAX_MULTIMODAL_IMAGES} 张参考图`)
        } else {
          const img = await readFrameFile(f, true)
          if (img) setMultimodalImages(prev => prev.length < MAX_MULTIMODAL_IMAGES ? [...prev, img] : prev)
        }
      } else if (isValidVideoFile(f)) {
        if (multimodalVideos.length >= MAX_MULTIMODAL_VIDEOS) {
          toast.error(`最多添加 ${MAX_MULTIMODAL_VIDEOS} 个参考视频`)
        } else {
          validateAndAddVideo(f, isSeedance)
        }
      } else if (isValidAudioFile(f)) {
        if (multimodalAudios.length >= MAX_MULTIMODAL_AUDIOS) {
          toast.error(`最多添加 ${MAX_MULTIMODAL_AUDIOS} 个参考音频`)
        } else {
          validateAndAddAudio(f, isSeedance)
        }
      } else {
        toast.error(`文件「${f.name}」格式不支持，请上传 JPG/PNG/WEBP 图片、MP4/MOV/WEBM 视频或 MP3/WAV/M4A/AAC 音频`)
      }
    }
  }, [multimodalImages.length, multimodalVideos.length, multimodalAudios.length, readFrameFile, validateAndAddVideo, validateAndAddAudio])

  const handleMultimodalDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    multimodalDragCounterRef.current = 0
    setIsMultimodalDragging(false)
    if (e.dataTransfer.files.length > 0) {
      await handleMultimodalFiles(e.dataTransfer.files)
      return
    }
    const asset = getDraggedAsset(e.dataTransfer)
    if (!asset.url) return
    try {
      if (asset.type === 'image') {
        if (multimodalImages.length >= MAX_MULTIMODAL_IMAGES) {
          toast.error(`最多添加 ${MAX_MULTIMODAL_IMAGES} 张参考图`)
          return
        }
        setMultimodalImages(prev => prev.length < MAX_MULTIMODAL_IMAGES ? [...prev, {
          id: randomUUID(),
          previewUrl: asset.url,
          dataUrl: asset.url,
        }] : prev)
        return
      }
      const file = await fetchAssetFile(asset.url, asset.type, 'asset')
      if (asset.type === 'video' || isValidVideoFile(file)) {
        if (multimodalVideos.length >= MAX_MULTIMODAL_VIDEOS) {
          toast.error(`最多添加 ${MAX_MULTIMODAL_VIDEOS} 个参考视频`)
          return
        }
        validateAndAddVideo(file, isSeedance)
        return
      }
      if (asset.type === 'image' || isValidImageFile(file)) {
        if (multimodalImages.length >= MAX_MULTIMODAL_IMAGES) {
          toast.error(`最多添加 ${MAX_MULTIMODAL_IMAGES} 张参考图`)
          return
        }
        const img = await readFrameFile(file, true)
        if (img) setMultimodalImages(prev => prev.length < MAX_MULTIMODAL_IMAGES ? [...prev, img] : prev)
      }
    } catch {
      toast.error('素材加载失败，请确认网络可访问素材服务器')
    }
  }, [handleMultimodalFiles, multimodalVideos.length, multimodalImages.length, validateAndAddVideo, isSeedance, readFrameFile])

  // Upload a File (or dataUrl for images) to /videos/upload; returns public URL.
  const uploadToVideoTemp = async (fileOrDataUrl: File | string, filename: string): Promise<string> => {
    const form = new FormData()
    if (fileOrDataUrl instanceof File) {
      form.append('file', fileOrDataUrl, fileOrDataUrl.name)
    } else {
      const res = await fetch(fileOrDataUrl)
      const blob = await res.blob()
      form.append('file', blob, filename)
    }
    const json = await fetchWithAuth<{ url: string }>('/videos/upload', { method: 'POST', body: form })
    return json.url
  }

  const resolveVideoImageInput = async (img: FrameImage, filename: string, requireUrl: boolean): Promise<string> => {
    if (requireUrl) return uploadToVideoTemp(img.file ?? img.dataUrl, filename)
    if (img.dataUrl.startsWith('data:')) return img.dataUrl
    const resp = await fetch(img.dataUrl)
    if (!resp.ok) throw new Error('reference image fetch failed')
    const blob = await resp.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  const handleVideoGenerate = async () => {
    if (!videoPrompt.trim()) return
    setIsVideoUploading(true)
    try {
      const isSeedance2 = videoModel === 'seedance-2.0' || videoModel === 'seedance-2.0-fast'
      const isSeedance = videoModel.startsWith('seedance-')

      // frames Tab：首尾帧 → images 字段
      // components Tab + Seedance 2.0：参考图 → reference_images 字段
      // components Tab + veo3.1-components：参考图 → images 字段（旧逻辑）
      // multimodal Tab：图片 → reference_images，视频 → reference_videos，音频 → reference_audios
      //
      // Seedance API 要求所有媒体文件必须是公网 https:// URL（不接受 base64 data URL）。
      // 因此 Seedance 模型的所有图片/视频/音频均先上传到 /videos/upload 获取临时公网 URL。
      let imagesParam: string[] | undefined
      let referenceImagesParam: string[] | undefined
      let referenceVideosParam: string[] | undefined
      let referenceAudiosParam: string[] | undefined

      if (videoMode === 'frames') {
        const arr: string[] = []
        if (firstFrame) {
          // Seedance 首尾帧也必须是 URL
          const url = await resolveVideoImageInput(firstFrame, 'first_frame.jpg', isSeedance)
          arr.push(url)
        }
        if (lastFrame) {
          const url = await resolveVideoImageInput(lastFrame, 'last_frame.jpg', isSeedance)
          arr.push(url)
        }
        imagesParam = arr.length > 0 ? arr : undefined
      } else if (videoMode === 'multimodal') {
        // 全能参考：全部直接用 File 上传（跳过 base64 中转，避免卡顿）
        if (multimodalImages.length > 0) {
          referenceImagesParam = await Promise.all(
            multimodalImages.map((img, i) => resolveVideoImageInput(img, `ref_image_${i}.jpg`, true))
          )
        }
        if (multimodalVideos.length > 0) {
          referenceVideosParam = await Promise.all(
            multimodalVideos.map((v) => uploadToVideoTemp(v.file, v.name))
          )
        }
        if (multimodalAudios.length > 0) {
          referenceAudiosParam = await Promise.all(
            multimodalAudios.map((a) => uploadToVideoTemp(a.file, a.name))
          )
        }
      } else {
        // components mode
        if (isSeedance2) {
          if (videoReferenceImages.length > 0) {
            referenceImagesParam = await Promise.all(
              videoReferenceImages.map((img, i) => resolveVideoImageInput(img, `ref_image_${i}.jpg`, true))
            )
          }
        } else {
          imagesParam = videoReferenceImages.length > 0
            ? await Promise.all(videoReferenceImages.map((img, i) => resolveVideoImageInput(img, `ref_image_${i}.jpg`, false)))
            : undefined
        }
      }

      const batch = await generateVideo({
        prompt: videoPrompt.trim(),
        workspace_id: activeWorkspaceId ?? '',
        model: videoModel,
        images: imagesParam,
        reference_images: referenceImagesParam,
        reference_videos: referenceVideosParam,
        reference_audios: referenceAudiosParam,
        aspect_ratio: videoAspectRatio || undefined,
        ...(isSeedance ? {
          duration: videoDuration,
          generate_audio: videoGenerateAudio,
          ...(videoMode !== 'frames' ? { camera_fixed: videoCameraFixed } : {}),
          watermark: watermark,
        } : {
          enable_upsample: videoUpsample,
        }),
      })
      if (batch) onBatchCreated(batch)
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
        model: videoModel,
      })
      toast.error(getRequestErrorMessage(err, '视频生成请求失败，请稍后重试'))
    } finally {
      setIsVideoUploading(false)
    }
  }

  const currentModel = MODEL_OPTIONS.find(m => m.value === modelType)
  const showImageQualitySelector = modelType !== 'gpt-image-2'
  const availableResolutions = ALL_RESOLUTION_OPTIONS.filter(r =>
    currentModel?.resolutions.includes(r.value) ?? true
  )

  return (
    <div className="flex flex-col gap-3 h-full">

      {/* 提示词区域 + 书签标签 */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* 书签标签 - 公司A只有图片模式，隐藏标签直接全圆角卡片 */}
        {!isCompanyA && (
          <div className="flex items-end">
            <button
              onClick={() => setMode('image')}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-t-lg border-t border-l border-r text-sm font-medium transition-all relative z-10 -mb-px',
                mode === 'image'
                  ? 'bg-card border-border text-foreground'
                  : 'bg-muted/60 border-muted text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
            >
              <ImageIcon className="h-3.5 w-3.5" />
              图片
            </button>
            {showVideoTab && (
              <button
                onClick={() => setMode('video')}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2 rounded-t-lg border-t border-l border-r text-sm font-medium transition-all relative -mb-px',
                  mode === 'video'
                    ? 'bg-card border-border text-foreground z-10'
                    : 'bg-muted/60 border-muted text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                <Video className="h-3.5 w-3.5" />
                视频
              </button>
            )}
            {showAvatarTab && (
              <button
                onClick={() => setMode('avatar')}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2 rounded-t-lg border-t border-l border-r text-sm font-medium transition-all relative -mb-px',
                  mode === 'avatar'
                    ? 'bg-card border-border text-foreground z-10'
                    : 'bg-muted/60 border-muted text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                <UserSquare2 className="h-3.5 w-3.5" />
                数字人
              </button>
            )}
            {showActionImitationTab && (
              <button
                onClick={() => setMode('action_imitation')}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2 rounded-t-lg border-t border-l border-r text-sm font-medium transition-all relative -mb-px',
                  mode === 'action_imitation'
                    ? 'bg-card border-border text-foreground z-10'
                    : 'bg-muted/60 border-muted text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                <Clapperboard className="h-3.5 w-3.5" />
                动作模仿
              </button>
            )}
          </div>
        )}

        {/* 提示词卡片 */}
        {mode === 'image' ? (
          <div
            className={cn(
              'border border-border bg-card p-4 flex-1 flex flex-col min-h-0 relative transition-colors',
              isCompanyA ? 'rounded-xl' : 'rounded-b-xl rounded-tr-xl',
              isDragging && 'border-primary bg-primary/5'
            )}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {/* 拖拽遮罩提示 */}
            {isDragging && (
              <div className={cn(
                'absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 pointer-events-none',
                isCompanyA ? 'rounded-xl' : 'rounded-b-xl rounded-tr-xl'
              )}>
                <ImagePlus className="h-10 w-10 text-primary" />
                <span className="text-sm font-medium text-primary">松开以添加参考图</span>
              </div>
            )}
            <div className={cn('flex flex-col flex-1 min-h-0 gap-2', isDragging && 'opacity-30 pointer-events-none')}>
              {/* 参考图区域 - 固定高度，保证添加图片前后布局不变 */}
              <div className={cn('shrink-0', isCompanyA ? 'h-[88px]' : 'h-[68px]')}>
                {referenceImages.length > 0 ? (
                  <div
                    onClick={() => setImageDialogOpen(true)}
                    className="cursor-pointer group h-full"
                  >
                    <div className="flex items-center gap-3 h-full">
                      {/* 堆叠图片预览 */}
                      <div className="relative w-16 h-14 shrink-0">
                        {referenceImages.slice(0, 3).map((img, index) => (
                          <div
                            key={img.id}
                            className="absolute rounded-lg border-2 border-background shadow-md overflow-hidden transition-transform group-hover:scale-105"
                            style={{
                              width: '44px',
                              height: '44px',
                              left: `${index * 14}px`,
                              top: `${index * 3}px`,
                              zIndex: 3 - index,
                            }}
                          >
                            <Image
                              src={img.previewUrl}
                              alt=""
                              fill
                              className="object-cover"
                              sizes="44px"
                              unoptimized
                            />
                          </div>
                        ))}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">
                          {referenceImages.length} 张参考图
                        </div>
                        <div className="text-xs text-muted-foreground">
                          点击查看和管理
                        </div>
                      </div>
                      <ImageIcon className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                      {isCompanyA && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setCompanyAPickerOpen(true) }}
                          className="h-6 w-6 rounded-md flex items-center justify-center text-blue-500 hover:bg-blue-500/10 transition-colors shrink-0"
                          title="从图库搜索添加"
                        >
                          <Search className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); clearReferenceImages() }}
                        className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                        title="清空全部参考图"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ) : isCompanyA ? (
                  /* 公司A：全宽上传框 + 右侧居中实体图库按钮 */
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'h-full w-full rounded-xl border-2 border-dashed transition-all cursor-pointer',
                      'border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50',
                      'flex items-center gap-3 px-3'
                    )}
                  >
                    <ImagePlus className="h-6 w-6 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-primary leading-tight">上传参考图</div>
                      <div className="text-[11px] text-primary/60 leading-tight mt-0.5">点击或拖拽 · 最多 {MAX_REF_IMAGES} 张</div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setCompanyAPickerOpen(true) }}
                      className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white text-xs font-medium transition-colors mr-2"
                    >
                      <Search className="h-3.5 w-3.5" />
                      图库搜索
                    </button>
                  </div>
                ) : (
                  /* 无参考图 - 横向全宽，直接触发文件选择 */
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'h-full w-full rounded-xl border-2 border-dashed transition-all cursor-pointer',
                      'border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50',
                      'flex items-center gap-3 px-3'
                    )}
                  >
                    <ImagePlus className="h-6 w-6 text-primary shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-primary leading-tight">上传参考图</div>
                      <div className="text-[11px] text-primary/60 leading-tight mt-0.5">最多 {MAX_REF_IMAGES} 张 · 支持拖拽</div>
                    </div>
                  </div>
                )}
              </div>

              {/* 提示词输入 - 撑满剩余空间 */}
              <div className="flex-1 min-h-0">
                <Textarea
                  placeholder="描述你想要生成的图片...&#10;&#10;Ctrl+Enter 快速生成"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="h-full resize-none"
                  disabled={isGenerating || disabled}
                />
              </div>
            </div>
          </div>
        ) : mode === 'video' ? (
          <div className="rounded-b-xl rounded-tr-xl border border-border bg-card p-4 flex-1 flex flex-col min-h-0 gap-2">
            {/* Video mode switcher */}
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => {
                  setVideoMode('multimodal')
                  if (!VIDEO_MODEL_OPTIONS.multimodal.find(m => m.value === videoModel)) {
                    setVideoModel('seedance-2.0')
                  }
                  setFirstFrame(null)
                  setLastFrame(null)
                  setVideoReferenceImages([])
                }}
                className={cn(
                  'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all',
                  videoMode === 'multimodal'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80'
                )}
              >
                全能参考
              </button>
              <button
                onClick={() => {
                  setVideoMode('frames')
                  if (!VIDEO_MODEL_OPTIONS.frames.find(m => m.value === videoModel)) {
                    setVideoModel('veo3.1-fast')
                  }
                  setVideoReferenceImages([])
                }}
                className={cn(
                  'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all',
                  videoMode === 'frames'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80'
                )}
              >
                首尾帧
              </button>
              <button
                onClick={() => {
                  setVideoMode('components')
                  if (!VIDEO_MODEL_OPTIONS.components.find(m => m.value === videoModel)) {
                    setVideoModel('veo3.1-components')
                  }
                  setFirstFrame(null)
                  setLastFrame(null)
                }}
                className={cn(
                  'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all',
                  videoMode === 'components'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80'
                )}
              >
                参考生视频
              </button>
            </div>

            {/* Image upload area - dynamic based on mode */}
            {videoMode === 'frames' ? (
              <div className="flex gap-2 shrink-0">
                {/* First frame */}
                <div className="flex-1 flex flex-col gap-1">
                  <p className="text-[11px] text-muted-foreground leading-none">首帧图（可选）</p>
                  {firstFrame ? (
                    <div
                      className="relative h-[90px] w-full rounded-lg overflow-hidden border bg-muted group cursor-zoom-in"
                      onClick={() => setFramePreviewIndex(0)}
                    >
                      <Image src={firstFrame.previewUrl} alt="" fill className="object-contain" sizes="200px" unoptimized />
                      <button
                        onClick={(e) => { e.stopPropagation(); setFirstFrame(null); setLastFrame(null) }}
                        className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                      >
                        <X className="h-3 w-3 text-background" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => firstFrameRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={handleFrameDrop}
                      className="h-[90px] w-full rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1"
                    >
                      <Film className="h-4 w-4 text-muted-foreground" />
                      <span className="text-[11px] text-muted-foreground">点击上传</span>
                    </button>
                  )}
                </div>
                {/* Last frame */}
                <div className="flex-1 flex flex-col gap-1">
                  <p className="text-[11px] text-muted-foreground leading-none">尾帧图（可选）</p>
                  {lastFrame ? (
                    <div
                      className="relative h-[90px] w-full rounded-lg overflow-hidden border bg-muted group cursor-zoom-in"
                      onClick={() => setFramePreviewIndex(1)}
                    >
                      <Image src={lastFrame.previewUrl} alt="" fill className="object-contain" sizes="200px" unoptimized />
                      <button
                        onClick={(e) => { e.stopPropagation(); setLastFrame(null) }}
                        className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                      >
                        <X className="h-3 w-3 text-background" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => lastFrameRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={handleFrameDrop}
                      disabled={!firstFrame}
                      className={cn(
                        'h-[90px] w-full rounded-lg border-2 border-dashed transition-all flex flex-col items-center justify-center gap-1',
                        firstFrame
                          ? 'border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 cursor-pointer'
                          : 'border-muted-foreground/15 opacity-50 cursor-not-allowed'
                      )}
                    >
                      <Film className="h-4 w-4 text-muted-foreground" />
                      <span className="text-[11px] text-muted-foreground">点击上传</span>
                    </button>
                  )}
                </div>
              </div>
            ) : videoMode === 'multimodal' ? (
              /* ── 多模态：素材上传 + 素材管理 ── */
              <div
                className={cn(
                  'shrink-0 relative transition-colors',
                  isMultimodalDragging && 'opacity-50'
                )}
                onDragEnter={handleMultimodalDragEnter}
                onDragLeave={handleMultimodalDragLeave}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleMultimodalDrop}
              >
                {isMultimodalDragging && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 pointer-events-none rounded-xl border-2 border-primary bg-primary/5">
                    <ImagePlus className="h-8 w-8 text-primary" />
                    <span className="text-sm font-medium text-primary">松开以添加素材</span>
                  </div>
                )}
                {totalMultimodalCount > 0 ? (
                  /* ── 已有素材：堆叠缩略图 + 管理入口 ── */
                  <div className="flex items-center gap-3 h-[90px]">
                    {/* 堆叠缩略图 */}
                    <div
                      className="relative w-20 h-[70px] shrink-0 cursor-pointer group"
                      onClick={() => setMultimodalManagerOpen(true)}
                    >
                      {/* 最多展示3层堆叠 */}
                      {multimodalStackPreviews.map((item, i) => (
                        <div
                          key={item.id}
                          className="absolute rounded-lg border-2 border-background shadow-md overflow-hidden transition-transform group-hover:scale-105 bg-muted"
                          style={{
                            width: 48, height: 48,
                            left: i * 13,
                            top: i * 4,
                            zIndex: 3 - i,
                          }}
                        >
                          {item.type === 'image' && (
                            <Image src={item.previewUrl} alt="" fill className="object-cover" sizes="48px" unoptimized />
                          )}
                          {item.type === 'video' && (
                            <video src={item.previewUrl} className="absolute inset-0 w-full h-full object-cover" muted playsInline preload="metadata" onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0.001 }} />
                          )}
                          {item.type === 'audio' && (
                            <div className="absolute inset-0 flex items-center justify-center bg-primary/10">
                              <Music className="h-5 w-5 text-primary" />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {/* 素材统计 + 操作 */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">
                        {totalMultimodalCount} 个素材
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 space-x-1.5">
                        {multimodalImages.length > 0 && <span>{multimodalImages.length} 图</span>}
                        {multimodalVideos.length > 0 && <span>{multimodalVideos.length} 视频</span>}
                        {multimodalAudios.length > 0 && <span>{multimodalAudios.length} 音频</span>}
                      </div>
                      <button
                        onClick={() => setMultimodalManagerOpen(true)}
                        className="mt-1 text-xs text-primary hover:underline"
                      >
                        点击管理素材
                      </button>
                    </div>
                    {/* 继续添加 + 清空 */}
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => multimodalAllInputRef.current?.click()}
                        className="h-7 px-2.5 rounded-md border text-xs font-medium hover:bg-muted transition-colors"
                      >
                        添加
                      </button>
                      <button
                        onClick={() => { setMultimodalImages([]); setMultimodalVideos([]); setMultimodalAudios([]) }}
                        className="h-7 px-2.5 rounded-md border text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ── 无素材：全宽上传区 ── */
                  <div
                    onClick={() => multimodalAllInputRef.current?.click()}
                    className="h-[90px] w-full rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all cursor-pointer flex items-center gap-3 px-4"
                  >
                    <ImagePlus className="h-6 w-6 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-primary leading-tight">上传素材</div>
                      <div className="text-[11px] text-primary/60 leading-tight mt-0.5">图片 / 音频 / 视频（最高支持 720p）</div>
                    </div>
                  </div>
                )}

                {/* 统一素材 input（接受图片+视频+音频） */}
                <input
                  ref={multimodalAllInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/x-m4a"
                  multiple
                  className="hidden"
                  onChange={(e) => handleMultimodalFiles(e.target.files)}
                />

                {/* ── 素材管理弹窗 ── */}
                {multimodalManagerOpen && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setMultimodalManagerOpen(false)}>
                    <div className="absolute inset-0 bg-black/40" />
                    <div
                      className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* 弹窗头部 */}
                      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">素材管理</span>
                          <span className="text-xs text-muted-foreground">{totalMultimodalCount} 个</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => multimodalAllInputRef.current?.click()}
                            className="h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                          >
                            继续添加
                          </button>
                          <button
                            onClick={() => setMultimodalManagerOpen(false)}
                            className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-muted transition-colors"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {/* 三栏内容 */}
                      <div className="flex-1 overflow-y-auto">
                        <div className="grid grid-cols-3 divide-x divide-border">

                          {/* ── 图片栏 ── */}
                          <div className="p-4 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">图片 {multimodalImages.length}/9</span>
                              {multimodalImages.length > 0 && (
                                <button onClick={() => setMultimodalImages([])} className="text-[10px] text-destructive hover:underline">清空</button>
                              )}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              {multimodalImages.map((img, idx) => (
                                <div
                                  key={img.id ?? idx}
                                  className="relative aspect-square rounded-lg overflow-hidden border bg-muted group cursor-zoom-in"
                                  onClick={() => setMediaPreview({ type: 'image', url: img.previewUrl, name: img.id ?? `图片${idx + 1}`, index: idx, total: multimodalImages.length })}
                                >
                                  <Image src={img.previewUrl} alt="" fill className="object-cover" sizes="120px" unoptimized />
                                  {/* 悬浮遮罩 */}
                                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                                    <Search className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                                  </div>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setMultimodalImages(prev => prev.filter((_, i) => i !== idx)) }}
                                    className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                                  >
                                    <X className="h-3 w-3 text-background" />
                                  </button>
                                </div>
                              ))}
                              {multimodalImages.length < 9 && (
                                <button
                                  onClick={() => multimodalImageInputRef.current?.click()}
                                  className="aspect-square rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1"
                                >
                                  <ImagePlus className="h-4 w-4 text-muted-foreground" />
                                  <span className="text-[10px] text-muted-foreground">添加</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* ── 视频栏 ── */}
                          <div className="p-4 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">视频 {multimodalVideos.length}/3</span>
                              {multimodalVideos.length > 0 && (
                                <button onClick={() => setMultimodalVideos([])} className="text-[10px] text-destructive hover:underline">清空</button>
                              )}
                            </div>
                            <div className="flex flex-col gap-2">
                              {multimodalVideos.map((v, idx) => (
                                <div key={v.id} className="relative rounded-lg overflow-hidden border bg-black group cursor-pointer aspect-video"
                                  onClick={() => setMediaPreview({ type: 'video', url: v.previewUrl, name: v.name })}
                                >
                                  {/* 静态缩略帧 */}
                                  <video
                                    src={v.previewUrl}
                                    className="absolute inset-0 w-full h-full object-cover"
                                    muted playsInline preload="metadata"
                                    onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0.001 }}
                                  />
                                  {/* 播放按钮遮罩 */}
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
                                    <div className="h-9 w-9 rounded-full bg-white/80 group-hover:bg-white flex items-center justify-center transition-colors shadow">
                                      <Play className="h-4 w-4 text-black ml-0.5" />
                                    </div>
                                  </div>
                                  {/* 文件名 */}
                                  <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/70 to-transparent">
                                    <span className="text-[10px] text-white truncate block">{v.name}</span>
                                  </div>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setMultimodalVideos(prev => prev.filter((_, i) => i !== idx)) }}
                                    className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                                  >
                                    <X className="h-3 w-3 text-background" />
                                  </button>
                                </div>
                              ))}
                              {multimodalVideos.length < 3 && (
                                <button
                                  onClick={() => multimodalVideoInputRef.current?.click()}
                                  className="h-16 rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1"
                                >
                                  <Film className="h-4 w-4 text-muted-foreground" />
                                  <span className="text-[10px] text-muted-foreground">添加视频</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* ── 音频栏 ── */}
                          <div className="p-4 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">音频 {multimodalAudios.length}/3</span>
                              {multimodalAudios.length > 0 && (
                                <button onClick={() => setMultimodalAudios([])} className="text-[10px] text-destructive hover:underline">清空</button>
                              )}
                            </div>
                            <div className="flex flex-col gap-3">
                              {multimodalAudios.map((a, idx) => (
                                <div key={a.id} className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border bg-muted/50 group">
                                  {/* 文件信息行 */}
                                  <div className="flex items-center gap-2">
                                    <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                                      <Music className="h-4 w-4 text-primary" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-xs font-medium truncate">{a.name}</p>
                                      <p className="text-[10px] text-muted-foreground">{a.duration.toFixed(1)}s</p>
                                    </div>
                                    <button
                                      onClick={() => setMultimodalAudios(prev => prev.filter((_, i) => i !== idx))}
                                      className="h-5 w-5 rounded-full hover:bg-foreground/10 flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
                                  {/* 内嵌播放器 */}
                                  <audio
                                    src={a.previewUrl}
                                    controls
                                    className="w-full h-7"
                                    style={{ accentColor: 'hsl(var(--primary))' }}
                                  />
                                </div>
                              ))}
                              {multimodalAudios.length < 3 && (
                                <button
                                  onClick={() => multimodalAudioInputRef.current?.click()}
                                  className="h-12 rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1"
                                >
                                  <Music className="h-4 w-4 text-muted-foreground" />
                                  <span className="text-[10px] text-muted-foreground">添加音频</span>
                                </button>
                              )}
                            </div>
                          </div>

                        </div>
                      </div>

                      {/* ── 图片全屏预览（ImageLightbox） ── */}
                      {mediaPreview?.type === 'image' && (
                        <ImageLightbox
                          url={mediaPreview.url}
                          alt={mediaPreview.name}
                          onClose={() => setMediaPreview(null)}
                          onPrev={mediaPreview.index > 0 ? () => {
                            const prev = multimodalImages[mediaPreview.index - 1]
                            setMediaPreview({ type: 'image', url: prev.previewUrl, name: prev.id ?? `图片${mediaPreview.index}`, index: mediaPreview.index - 1, total: mediaPreview.total })
                          } : undefined}
                          onNext={mediaPreview.index < mediaPreview.total - 1 ? () => {
                            const next = multimodalImages[mediaPreview.index + 1]
                            setMediaPreview({ type: 'image', url: next.previewUrl, name: next.id ?? `图片${mediaPreview.index + 2}`, index: mediaPreview.index + 1, total: mediaPreview.total })
                          } : undefined}
                          footer={<p className="text-sm text-white/80">{mediaPreview.index + 1} / {mediaPreview.total}</p>}
                        />
                      )}

                      {/* ── 视频全屏播放器 ── */}
                      {mediaPreview?.type === 'video' && (
                        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/80" onClick={() => setMediaPreview(null)}>
                          <div className="relative w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-between mb-2 px-1">
                              <p className="text-sm text-white/80 truncate">{mediaPreview.name}</p>
                              <button onClick={() => setMediaPreview(null)} className="h-7 w-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
                                <X className="h-4 w-4 text-white" />
                              </button>
                            </div>
                            <video
                              src={mediaPreview.url}
                              controls
                              autoPlay
                              className="w-full rounded-xl max-h-[70vh] bg-black"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 分类 hidden inputs（弹窗内用） */}
                <input ref={multimodalImageInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="hidden"
                  onChange={async (e) => {
                    const files = e.target.files; if (!files) return
                    const MAX_MM_IMAGES = 9
                    const newImgs: FrameImage[] = []
                    for (const f of Array.from(files)) {
                      if (multimodalImages.length + newImgs.length >= MAX_MM_IMAGES) {
                        toast.error(`最多添加 ${MAX_MM_IMAGES} 张参考图`)
                        break
                      }
                      const img = await readFrameFile(f); if (img) newImgs.push(img)
                    }
                    setMultimodalImages(prev => [...prev, ...newImgs]); e.target.value = ''
                  }}
                />
                <input ref={multimodalVideoInputRef} type="file" accept="video/mp4,video/quicktime,video/webm" multiple className="hidden"
                  onChange={(e) => {
                    const files = e.target.files; if (!files) return
                    for (const f of Array.from(files)) {
                      if (multimodalVideos.length >= 3) {
                        toast.error('最多添加 3 个参考视频')
                        break
                      }
                      if (!isValidVideoFile(f)) {
                        toast.error(`文件「${f.name}」格式不支持，请上传 MP4 / MOV / WEBM 格式的视频`)
                        continue
                      }
                      validateAndAddVideo(f, isSeedance)
                    }
                    e.target.value = ''
                  }}
                />
                <input ref={multimodalAudioInputRef} type="file" accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/x-m4a" multiple className="hidden"
                  onChange={(e) => {
                    const files = e.target.files; if (!files) return
                    for (const f of Array.from(files)) {
                      if (multimodalAudios.length >= 3) {
                        toast.error('最多添加 3 个参考音频')
                        break
                      }
                      if (!isValidAudioFile(f)) {
                        toast.error(`文件「${f.name}」格式不支持，请上传 MP3 / WAV / M4A / AAC 格式的音频`)
                        continue
                      }
                      validateAndAddAudio(f, isSeedance)
                    }
                    e.target.value = ''
                  }}
                />
              </div>
            ) : (
              <div
                className={cn(
                  'shrink-0 relative transition-colors',
                  isReferenceDragging && 'opacity-50'
                )}
                onDragEnter={handleReferenceDragEnter}
                onDragLeave={handleReferenceDragLeave}
                onDragOver={handleReferenceDragOver}
                onDrop={handleReferenceDrop}
              >
                {isReferenceDragging && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 pointer-events-none rounded-xl border-2 border-primary bg-primary/5">
                    <ImagePlus className="h-8 w-8 text-primary" />
                    <span className="text-sm font-medium text-primary">松开以添加参考图</span>
                  </div>
                )}
                {videoReferenceImages.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] text-muted-foreground">{videoReferenceImages.length}/3 张参考图</p>
                      <button
                        onClick={clearReferenceImagesVideo}
                        className="text-[11px] text-destructive hover:underline"
                      >
                        清空全部
                      </button>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {videoReferenceImages.map((img, index) => (
                        <div
                          key={img.id ?? index}
                          className="relative h-[90px] w-[90px] rounded-lg overflow-hidden border bg-muted group cursor-zoom-in"
                          onClick={() => setReferencePreviewIndex(index)}
                        >
                          <Image src={img.previewUrl} alt="" fill className="object-cover" sizes="90px" unoptimized />
                          <button
                            onClick={(e) => { e.stopPropagation(); removeReferenceImage(index) }}
                            className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                          >
                            <X className="h-3 w-3 text-background" />
                          </button>
                        </div>
                      ))}
                      {videoReferenceImages.length < 3 && (
                        <button
                          onClick={() => referenceInputRef.current?.click()}
                          className="h-[90px] w-[90px] rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1"
                        >
                          <ImagePlus className="h-4 w-4 text-muted-foreground" />
                          <span className="text-[11px] text-muted-foreground">添加</span>
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    onClick={() => referenceInputRef.current?.click()}
                    className="h-[90px] w-full rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all cursor-pointer flex items-center gap-3 px-4"
                  >
                    <ImagePlus className="h-6 w-6 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-primary leading-tight">上传参考图片</div>
                      <div className="text-[11px] text-primary/60 leading-tight mt-0.5">1-3张 · 支持拖拽</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Prompt */}
            <div className="flex-1 min-h-0">
              <Textarea
                placeholder="描述你想要生成的视频内容..."
                value={videoPrompt}
                onChange={(e) => setVideoPrompt(e.target.value)}
                className="h-full resize-none"
                disabled={isVideoGenerating || disabled}
              />
            </div>

            {/* Hidden file inputs */}
            <input ref={firstFrameRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) setFirstFrame(await readFrameFile(f))
                e.target.value = ''
              }}
            />
            <input ref={lastFrameRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) setLastFrame(await readFrameFile(f))
                e.target.value = ''
              }}
            />
            <input ref={referenceInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="hidden"
              onChange={(e) => handleReferenceFiles(e.target.files)}
            />

            {/* Frame image lightbox */}
            {framePreviewIndex !== null && (firstFrame || lastFrame) && (() => {
              const frames = [firstFrame, lastFrame].filter(Boolean) as FrameImage[]
              const labels = firstFrame && lastFrame ? ['首帧图', '尾帧图'] : [firstFrame ? '首帧图' : '尾帧图']
              const activeIdx = framePreviewIndex === 1 && firstFrame ? 1 : 0
              const frame = frames[activeIdx]
              if (!frame) return null
              return (
                <ImageLightbox
                  url={frame.previewUrl}
                  alt={labels[activeIdx]}
                  onClose={() => setFramePreviewIndex(null)}
                  onPrev={activeIdx > 0 ? () => setFramePreviewIndex(0) : undefined}
                  onNext={activeIdx < frames.length - 1 ? () => setFramePreviewIndex(1) : undefined}
                  footer={<p className="text-sm text-white/80">{labels[activeIdx]}</p>}
                />
              )
            })()}

            {/* Reference images lightbox */}
            {referencePreviewIndex !== null && videoReferenceImages[referencePreviewIndex] && (
              <ImageLightbox
                url={videoReferenceImages[referencePreviewIndex].previewUrl}
                alt={`参考图 ${referencePreviewIndex + 1}`}
                onClose={() => setReferencePreviewIndex(null)}
                onPrev={referencePreviewIndex > 0 ? () => setReferencePreviewIndex(referencePreviewIndex - 1) : undefined}
                onNext={referencePreviewIndex < videoReferenceImages.length - 1 ? () => setReferencePreviewIndex(referencePreviewIndex + 1) : undefined}
                footer={<p className="text-sm text-white/80">参考图 {referencePreviewIndex + 1}/{videoReferenceImages.length}</p>}
              />
            )}
          </div>
        ) : mode === 'action_imitation' ? (
          <div className="rounded-b-xl rounded-tr-xl border border-border bg-card p-4 flex-1 flex flex-col min-h-0 gap-2">
            {/* 人物图片上传 — 占上半 */}
            <div className="flex-1 min-h-0 flex flex-col">
              <p className="text-[11px] text-muted-foreground mb-1 shrink-0">人物图片（必填，≤4.7MB）</p>
              {actionImage ? (
                <div className="flex-1 min-h-0 relative rounded-lg overflow-hidden border bg-muted group" onDragOver={(e) => e.preventDefault()} onDrop={handleActionImageDrop}>
                  <Image src={actionImage.previewUrl} alt="" fill className="object-contain" sizes="300px" unoptimized />
                  <button
                    onClick={() => setActionImage(null)}
                    className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                  >
                    <X className="h-3 w-3 text-background" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => actionImageRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleActionImageDrop}
                  className="flex-1 min-h-0 w-full rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all flex flex-col items-center justify-center gap-1"
                >
                  <ImagePlus className="h-5 w-5 text-primary shrink-0" />
                  <div className="text-center">
                    <div className="text-sm font-medium text-primary">上传人物图片</div>
                    <div className="text-[11px] text-primary/60">jpg / png · 最大 4.7MB</div>
                  </div>
                </button>
              )}
            </div>

            {/* 驱动视频上传 — 占下半 */}
            <div className="flex-1 min-h-0 flex flex-col">
              <p className="text-[11px] text-muted-foreground mb-1 shrink-0">驱动视频（必填，≤30秒）</p>
              {actionVideo ? (
                <div
                  className="flex-1 min-h-0 relative rounded-lg overflow-hidden border bg-black group cursor-pointer"
                  onClick={() => setActionVideoPreviewOpen(true)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleActionVideoDrop}
                >
                  <video
                    src={actionVideo.previewUrl}
                    className="absolute inset-0 w-full h-full object-contain"
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0.001 }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                    <Play className="h-8 w-8 text-white drop-shadow" />
                  </div>
                  <div className="absolute bottom-1 left-1 right-7">
                    <span className="text-[10px] bg-black/60 text-white rounded px-1 py-0.5 truncate block">
                      {actionVideo.name} · {actionVideo.duration.toFixed(1)}s
                    </span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setActionVideo(null) }}
                    className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                  >
                    <X className="h-3 w-3 text-background" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => actionVideoRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleActionVideoDrop}
                  className="flex-1 min-h-0 w-full rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all flex flex-col items-center justify-center gap-1"
                >
                  <Clapperboard className="h-4 w-4 text-primary shrink-0" />
                  <div className="text-center">
                    <div className="text-sm font-medium text-primary">上传驱动视频</div>
                    <div className="text-[11px] text-primary/60">mp4 / mov / webm · 最大 30s</div>
                  </div>
                </button>
              )}
            </div>

            {/* 提示 */}
            <p className="text-[11px] text-muted-foreground shrink-0">💡 图片与视频中人物比例越接近，效果越好</p>

            {/* 隐藏文件输入 */}
            <input ref={actionImageRef} type="file" accept="image/jpeg,image/png" className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                if (!isValidImageFile(f)) {
                  toast.error(`文件「${f.name}」格式不支持，请上传 JPG / PNG 格式的图片`)
                  e.target.value = ''
                  return
                }
                if (f.size > 4.7 * 1024 * 1024) { toast.error('人物图片不能超过 4.7 MB'); e.target.value = ''; return }
                const img = await readFrameFile(f, true)
                if (img) setActionImage(img)
                e.target.value = ''
              }}
            />
            <input ref={actionVideoRef} type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                if (!isValidVideoFile(f)) {
                  toast.error(`文件「${f.name}」格式不支持，请上传 MP4 / MOV / WEBM 格式的视频`)
                  e.target.value = ''
                  return
                }
                const url = URL.createObjectURL(f)
                const video = document.createElement('video')
                video.src = url
                video.onloadedmetadata = () => {
                  const dur = video.duration
                  URL.revokeObjectURL(url)
                  if (dur > 30) { toast.error('驱动视频时长不能超过 30 秒'); return }
                  const previewUrl = URL.createObjectURL(f)
                  setActionVideo({ file: f, previewUrl, duration: dur, name: f.name })
                }
                e.target.value = ''
              }}
            />

            {/* 视频预览对话框 */}
            {actionVideoPreviewOpen && actionVideo && (
              <Dialog open={actionVideoPreviewOpen} onOpenChange={setActionVideoPreviewOpen}>
                <DialogContent className="max-w-2xl p-2">
                  <video src={actionVideo.previewUrl} controls autoPlay className="w-full rounded-lg max-h-[70vh]" />
                </DialogContent>
              </Dialog>
            )}
          </div>
        ) : (
          <div className="rounded-b-xl rounded-tr-xl border border-border bg-card p-4 flex-1 flex flex-col min-h-0 gap-3">
            {/* 人物图片上传 */}
            <div className="shrink-0">
              <p className="text-[11px] text-muted-foreground mb-1">人物图片（必填，≤5MB）</p>
              {avatarImage ? (
                <div className="relative h-[90px] w-full rounded-lg overflow-hidden border bg-muted group" onDragOver={(e) => e.preventDefault()} onDrop={handleAvatarImageDrop}>
                  <Image src={avatarImage.previewUrl} alt="" fill className="object-contain" sizes="300px" unoptimized />
                  <button
                    onClick={() => setAvatarImage(null)}
                    className="absolute top-1 right-1 h-5 w-5 rounded-full bg-foreground/60 hover:bg-foreground/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                  >
                    <X className="h-3 w-3 text-background" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => avatarImageRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleAvatarImageDrop}
                  className="h-[90px] w-full rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all flex items-center gap-3 px-4"
                >
                  <ImagePlus className="h-5 w-5 text-primary shrink-0" />
                  <div className="text-left">
                    <div className="text-sm font-medium text-primary">上传人物图片</div>
                    <div className="text-[11px] text-primary/60">jpg / png / webp · 最大 5MB</div>
                  </div>
                </button>
              )}
            </div>

            {/* 音频上传 */}
            <div className="shrink-0">
              <p className="text-[11px] text-muted-foreground mb-1">驱动音频（必填，≤60秒）</p>
              {avatarAudio ? (
                <div className="flex items-center gap-3 h-10 px-3 rounded-lg border bg-muted" onDragOver={(e) => e.preventDefault()} onDrop={handleAvatarAudioDrop}>
                  <Music className="h-4 w-4 text-primary shrink-0" />
                  <span className="flex-1 text-sm truncate">{avatarAudio.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{avatarAudio.duration.toFixed(1)}s</span>
                  <button onClick={() => setAvatarAudio(null)} className="h-5 w-5 rounded-full hover:bg-foreground/10 flex items-center justify-center shrink-0">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => avatarAudioRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleAvatarAudioDrop}
                  className="h-10 w-full rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all flex items-center gap-3 px-4"
                >
                  <Music className="h-4 w-4 text-primary shrink-0" />
                  <div className="text-sm font-medium text-primary">上传音频文件</div>
                  <div className="text-[11px] text-primary/60 ml-1">mp3 / wav / m4a · 最大 60s</div>
                </button>
              )}
            </div>

            {/* 提示词 */}
            <div className="flex-1 min-h-0">
              <Textarea
                placeholder="可选：描述动作、运镜或画面风格..."
                value={avatarPrompt}
                onChange={(e) => setAvatarPrompt(e.target.value)}
                className="h-full resize-none"
                disabled={isAvatarGenerating}
              />
            </div>

            {/* 隐藏文件输入 */}
            <input ref={avatarImageRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                if (!isValidImageFile(f)) {
                  toast.error(`文件「${f.name}」格式不支持，请上传 JPG / PNG / WEBP 格式的图片`)
                  e.target.value = ''
                  return
                }
                if (f.size > 5 * 1024 * 1024) { toast.error('人物图片不能超过 5 MB'); e.target.value = ''; return }
                const img = await readFrameFile(f, true)
                if (img) setAvatarImage(img)
                e.target.value = ''
              }}
            />
            <input ref={avatarAudioRef} type="file" accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/x-m4a" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                if (!isValidAudioFile(f)) {
                  toast.error(`文件「${f.name}」格式不支持，请上传 MP3 / WAV / M4A / AAC 格式的音频`)
                  e.target.value = ''
                  return
                }
                const url = URL.createObjectURL(f)
                const audio = document.createElement('audio')
                audio.src = url
                audio.onloadedmetadata = () => {
                  const dur = audio.duration
                  URL.revokeObjectURL(url)
                  if (dur > 60) { toast.error('驱动音频时长不能超过 60 秒'); return }
                  const reader = new FileReader()
                  reader.onload = () => setAvatarAudio({ id: randomUUID(), name: f.name, dataUrl: reader.result as string, duration: dur })
                  reader.readAsDataURL(f)
                }
                e.target.value = ''
              }}
            />
          </div>
        )}
      </div>

      {mode === 'image' && (
        <>
          {/* 生成配置 - 紧凑间距 */}          <div className="rounded-xl border bg-card p-3 relative">
            <button
              className="absolute top-2 right-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-accent"
              disabled={disabled}
              onClick={() => {
                saveAsDefaults()
                saveDefaults({
                  image: { modelType, resolution, aspectRatio, quantity, watermark },
                  video: videoDefaults ?? undefined,
                  avatar: avatarDefaults ?? undefined,
                })
                toast.success('已保存为默认参数')
              }}
            >
              设为默认
            </button>
            <div className="space-y-3">
              {/* 模型选择 */}
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">模型</Label>
                <Select
                  value={modelType}
                  onValueChange={(v) => setModelType(v as 'gemini' | 'gpt-image-2' | 'nano-banana-pro' | 'seedream-5.0-lite' | 'seedream-4.5' | 'seedream-4.0')}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue>
                      {currentModel?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_OPTIONS.map((model) => {
                      const Icon = model.icon
                      return (
                        <SelectItem key={model.value} value={model.value} className="py-2">
                          <div className="flex items-start gap-3">
                            <Icon className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm mb-0.5">{model.label}</div>
                              <div className="text-xs text-muted-foreground leading-snug">
                                {model.desc}
                              </div>
                              <div className="flex items-center gap-1 text-xs font-medium text-primary mt-0.5">
                                <Coins className="h-3 w-3" />
                                {model.credits} 积分/张
                              </div>
                            </div>
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>

              {/* 质量 */}
              {showImageQualitySelector && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">质量</Label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {availableResolutions.map((res) => (
                      <button
                        key={res.value}
                        onClick={() => setResolution(res.value)}
                        disabled={disabled}
                        className={cn(
                          'py-1.5 px-3 rounded-lg border-2 text-sm font-medium transition-all',
                          resolution === res.value
                            ? 'border-primary bg-primary/5 text-primary'
                            : 'border-border hover:border-primary/50',
                          disabled && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        {res.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 画面比例 */}
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">比例</Label>
                <div className="grid grid-cols-5 gap-1.5">
                  {ASPECT_RATIOS.map((ar) => (
                    <button
                      key={ar.value}
                      onClick={() => setAspectRatio(ar.value)}
                      disabled={disabled}
                      className={cn(
                        'flex flex-col items-center gap-1 py-1.5 px-1 rounded-lg border-2 transition-all',
                        aspectRatio === ar.value
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'border-border hover:border-primary/50',
                        disabled && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <div className="flex items-end justify-center h-3.5">
                        <AspectRatioIcon ratio={ar.value} active={aspectRatio === ar.value} />
                      </div>
                      <span className="text-xs font-medium">{ar.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="flex items-center gap-3">
            <Select
              value={String(quantity)}
              onValueChange={(v) => setQuantity(Number(v))}
              disabled={disabled}
            >
              <SelectTrigger className="w-[90px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUANTITY_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 张
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex-1" />

            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Coins className="h-4 w-4 text-amber-500" />
              <span>{estimatedCredits} 积分</span>
            </div>

            <Button
              variant="gradient"
              size="lg"
              className="gap-2 px-8"
              onClick={handleGenerate}
              disabled={isGenerating || disabled || !prompt.trim()}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  生成中...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  生成
                </>
              )}
            </Button>
          </div>

          {/* 参考图管理对话框 */}
          <Dialog open={imageDialogOpen} onOpenChange={setImageDialogOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>参考图片管理</DialogTitle>
              </DialogHeader>
              <div className="mt-4">
                <ReferenceImageUploadCompact expanded />
              </div>
            </DialogContent>
          </Dialog>

          {/* 隐藏文件选择器 - 无图时直接上传 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => handleImageFiles(e.target.files)}
          />

          {/* 公司A图库选择器 */}
          {isCompanyA && (
            <CompanyAImagePicker
              open={companyAPickerOpen}
              onOpenChange={setCompanyAPickerOpen}
              onSelectPoster={handleSelectCompanyAImage}
            />
          )}
        </>
      )}

      {mode === 'video' && (
        <>
          {/* 视频生成配置 */}
          <div className="rounded-xl border bg-card p-3 relative">
            <button
              className="absolute top-2 right-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-accent"
              disabled={isVideoGenerating || disabled}
              onClick={() => {
                const d = { videoModel, videoAspectRatio, videoUpsample, videoDuration, videoGenerateAudio, videoCameraFixed }
                saveVideoDefaults(d)
                saveDefaults({
                  image: userDefaults ?? undefined,
                  video: d,
                  avatar: avatarDefaults ?? undefined,
                })
                toast.success('已保存为默认参数')
              }}
            >
              设为默认
            </button>
            <div className="space-y-3">
              {/* 模型 + 分辨率 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">模型</Label>
                  <Select value={videoModel} onValueChange={setVideoModel} disabled={isVideoGenerating || disabled}>
                    <SelectTrigger className="h-9">
                      <SelectValue>
                        {VIDEO_MODEL_OPTIONS[videoMode].find(m => m.value === videoModel)?.label ?? videoModel}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {VIDEO_MODEL_OPTIONS[videoMode].map((m) => (
                        <SelectItem key={m.value} value={m.value} className="py-2">
                          <div className="flex items-start gap-3">
                            <Film className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm mb-0.5">{m.label}</div>
                              <div className="text-xs text-muted-foreground leading-snug">{m.desc}</div>
                              <div className="flex items-center gap-1 text-xs font-medium text-primary mt-0.5">
                                <Coins className="h-3 w-3" />
                                {m.isSeedance ? `${m.credits} 积分/秒` : `${m.credits} 积分/次`}
                              </div>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">分辨率</Label>
                  <Select
                    value={String(videoUpsample)}
                    onValueChange={(v) => setVideoUpsample(v === 'true')}
                    disabled={isVideoGenerating || disabled}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VIDEO_RESOLUTIONS.filter((r) => !(r.value === true && videoModel === 'seedance-2.0-fast')).map((r) => (
                        <SelectItem key={String(r.value)} value={String(r.value)}>
                          <span className="font-medium">{r.label}</span>
                          <span className="text-xs text-muted-foreground ml-1.5">{r.desc}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Row 2: 比例 [buttons veo] | 比例+时长 [dropdowns seedance] */}
              {isSeedance ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">比例</Label>
                    <Select value={videoAspectRatio} onValueChange={setVideoAspectRatio} disabled={isVideoGenerating || disabled}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VIDEO_ASPECT_RATIOS_SEEDANCE.map((ar) => (
                          <SelectItem key={ar.value} value={ar.value}>{ar.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">时长</Label>
                    <Select value={String(videoDuration)} onValueChange={(v) => setVideoDuration(Number(v))} disabled={isVideoGenerating || disabled}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SEEDANCE_DURATION_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">比例</Label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {VIDEO_ASPECT_RATIOS_DEFAULT.map((ar) => (
                      <button
                        key={ar.value}
                        onClick={() => setVideoAspectRatio(ar.value)}
                        disabled={isVideoGenerating || disabled}
                        className={cn(
                          'py-1.5 px-3 rounded-lg border-2 text-sm font-medium transition-all',
                          videoAspectRatio === ar.value
                            ? 'border-primary bg-primary/5 text-primary'
                            : 'border-border hover:border-primary/50',
                          (isVideoGenerating || disabled) && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        {ar.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Row 3 (Seedance only): 首尾帧仅音频，其他模式音频+镜头 */}
              {isSeedance && (
                videoMode === 'frames' ? (
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">音频</Label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[{ value: true, label: '有声' }, { value: false, label: '无声' }].map((opt) => (
                        <button
                          key={String(opt.value)}
                          onClick={() => setVideoGenerateAudio(opt.value)}
                          disabled={isVideoGenerating || disabled}
                          className={cn(
                            'py-1.5 px-2 rounded-lg border-2 text-sm font-medium transition-all',
                            videoGenerateAudio === opt.value
                              ? 'border-primary bg-primary/5 text-primary'
                              : 'border-border hover:border-primary/50',
                            (isVideoGenerating || disabled) && 'opacity-50 cursor-not-allowed'
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">音频</Label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[{ value: true, label: '有声' }, { value: false, label: '无声' }].map((opt) => (
                          <button
                            key={String(opt.value)}
                            onClick={() => setVideoGenerateAudio(opt.value)}
                            disabled={isVideoGenerating || disabled}
                            className={cn(
                              'py-1.5 px-2 rounded-lg border-2 text-sm font-medium transition-all',
                              videoGenerateAudio === opt.value
                                ? 'border-primary bg-primary/5 text-primary'
                                : 'border-border hover:border-primary/50',
                              (isVideoGenerating || disabled) && 'opacity-50 cursor-not-allowed'
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">镜头</Label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[{ value: false, label: '自由' }, { value: true, label: '固定' }].map((opt) => (
                          <button
                            key={String(opt.value)}
                            onClick={() => setVideoCameraFixed(opt.value)}
                            disabled={isVideoGenerating || disabled}
                            className={cn(
                              'py-1.5 px-2 rounded-lg border-2 text-sm font-medium transition-all',
                              videoCameraFixed === opt.value
                                ? 'border-primary bg-primary/5 text-primary'
                                : 'border-border hover:border-primary/50',
                              (isVideoGenerating || disabled) && 'opacity-50 cursor-not-allowed'
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="flex items-center gap-3">
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Coins className="h-4 w-4 text-amber-500" />
              {isSeedance
                ? <span>{(videoDuration === -1 ? 15 : videoDuration) * (VIDEO_MODEL_OPTIONS[videoMode as keyof typeof VIDEO_MODEL_OPTIONS]?.find((m: any) => m.value === videoModel)?.credits ?? 5)} 积分</span>
                : <span>{VIDEO_MODEL_OPTIONS[videoMode].find(m => m.value === videoModel)?.credits ?? 10} 积分</span>
              }
            </div>
            <Button
              variant="gradient"
              size="lg"
              className="gap-2 px-8"
              onClick={handleVideoGenerate}
              disabled={isVideoGenerating || isVideoUploading || disabled || !videoPrompt.trim() || (videoMode === 'components' && videoReferenceImages.length === 0)}
            >
              {isVideoUploading ? (
                <><Loader2 className="h-4 w-4 animate-spin" />上传中...</>
              ) : isVideoGenerating ? (
                <><Loader2 className="h-4 w-4 animate-spin" />生成中...</>
              ) : (
                <><Sparkles className="h-4 w-4" />生成</>
              )}
            </Button>
          </div>
        </>
      )}

      {mode === 'avatar' && (
        <>
          {/* 数字人配置 */}
          <div className="rounded-xl border bg-card p-3 relative">
            <button
              className="absolute top-2 right-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-accent"
              disabled={isAvatarGenerating}
              onClick={() => {
                saveAvatarDefaults({ avatarResolution })
                saveDefaults({
                  image: userDefaults ?? undefined,
                  video: videoDefaults ?? undefined,
                  avatar: { avatarResolution },
                })
                toast.success('已保存为默认参数')
              }}
            >
              设为默认
            </button>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">分辨率</Label>
                <div className="grid grid-cols-2 gap-1.5">
                  {[{ value: '720p', label: '720p', desc: '标准' }, { value: '1080p', label: '1080p', desc: '高清' }].map((r) => (
                    <button
                      key={r.value}
                      onClick={() => setAvatarResolution(r.value as '720p' | '1080p')}
                      disabled={isAvatarGenerating}
                      className={cn(
                        'py-1.5 px-3 rounded-lg border-2 text-sm font-medium transition-all',
                        avatarResolution === r.value
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'border-border hover:border-primary/50',
                        isAvatarGenerating && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      {r.label} <span className="text-xs font-normal text-muted-foreground">{r.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="flex items-center gap-3">
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Coins className="h-4 w-4 text-amber-500" />
              <span>{avatarAudio ? `${Math.ceil(avatarAudio.duration) * 50} 积分` : '50 积分/秒'}</span>
            </div>
            <Button
              variant="gradient"
              size="lg"
              className="gap-2 px-8"
              onClick={handleAvatarGenerate}
              disabled={isAvatarGenerating || disabled || !avatarImage || !avatarAudio}
            >
              {isAvatarGenerating ? (
                <><Loader2 className="h-4 w-4 animate-spin" />生成中...</>
              ) : (
                <><Sparkles className="h-4 w-4" />生成</>
              )}
            </Button>
          </div>
        </>
      )}

      {mode === 'action_imitation' && (
        <>
          {/* 底部操作栏 */}
          <div className="flex items-center gap-3">
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Coins className="h-4 w-4 text-amber-500" />
              <span>{actionVideo ? `${Math.ceil(actionVideo.duration) * 20} 积分` : '20 积分/秒'}</span>
            </div>
            <Button
              variant="gradient"
              size="lg"
              className="gap-2 px-8"
              onClick={handleActionImitationGenerate}
              disabled={isActionGenerating || disabled || !actionImage || !actionVideo}
            >
              {isActionGenerating ? (
                <><Loader2 className="h-4 w-4 animate-spin" />生成中...</>
              ) : (
                <><Sparkles className="h-4 w-4" />生成</>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function AspectRatioIcon({ ratio, active }: { ratio: string; active: boolean }) {
  const [w, h] = ratio.split(':').map(Number)
  const maxSize = 14
  const scale = maxSize / Math.max(w, h)
  const width = Math.round(w * scale)
  const height = Math.round(h * scale)

  return (
    <div
      className={cn(
        'rounded border-2',
        active ? 'border-primary bg-primary/20' : 'border-current opacity-40'
      )}
      style={{ width, height }}
    />
  )
}
