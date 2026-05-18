import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAuthStore } from '@/stores/auth-store'
import { loadAiChatHistory, saveAiChatHistory, clearAiChatHistory } from '@/hooks/use-ai-chat-history'
import type { AiChatMessage } from '@/hooks/use-ai-chat-history'
import { cn, randomUUID } from '@/lib/utils'
import { fetchWithAuth } from '@/lib/fetch-with-auth'
import {
  Bot, X, Send, ImageIcon, Video, Trash2, Loader2, Upload, MessageSquare, GripVertical, Copy, Check,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'

type Tab = 'chat' | 'image' // | 'video'

const TAB_CONFIG: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: '对话助手', icon: <MessageSquare className="h-3.5 w-3.5" /> },
  { id: 'image', label: '图片解析', icon: <ImageIcon className="h-3.5 w-3.5" /> },
  // { id: 'video', label: '视频解析', icon: <Video className="h-3.5 w-3.5" /> },
]

export function AiAssistant() {
  const user = useAuthStore((s) => s.user)
  const userId = user?.id ?? 'guest'

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [showHint, setShowHint] = useState(false)

  // Chat tab attachments
  const [chatImage, setChatImage] = useState<{ base64: string; type: string; preview: string; name: string } | null>(null)
  // const [chatVideo, setChatVideo] = useState<{ tempId: string; name: string } | null>(null)
  // const [chatVideoUploading, setChatVideoUploading] = useState(false)

  // Copy state
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Image tab
  const [imageFile, setImageFile] = useState<{ base64: string; type: string; preview: string; name: string } | null>(null)

  // Video tab (hidden)
  // const [videoFile, setVideoFile] = useState<File | null>(null)
  // const [videoUploadProgress, setVideoUploadProgress] = useState(0)
  // const [videoTempId, setVideoTempId] = useState<string | null>(null)

  // Draggable & resizable state
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [width, setWidth] = useState(420)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [resizeEdge, setResizeEdge] = useState<'left' | 'right'>('left')
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [resizeStart, setResizeStart] = useState({ x: 0, width: 0, posX: 0 })

  // Floating button draggable state
  const [buttonPosition, setButtonPosition] = useState({ x: 0, y: 0 })
  const [isButtonDragging, setIsButtonDragging] = useState(false)
  const [buttonDragStart, setButtonDragStart] = useState({ x: 0, y: 0 })
  const buttonDraggedRef = useRef(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const chatImageRef = useRef<HTMLInputElement>(null)
  // const chatVideoRef = useRef<HTMLInputElement>(null)
  const imageTabRef = useRef<HTMLInputElement>(null)
  // const videoTabRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Load history on open
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages(loadAiChatHistory(userId))
    }
  }, [open, userId])

  useEffect(() => {
    if (!user) return
    setShowHint(true)
    const timer = setTimeout(() => setShowHint(false), 6000)
    return () => clearTimeout(timer)
  }, [user?.id])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Save history whenever messages change
  useEffect(() => {
    if (messages.length > 0) saveAiChatHistory(userId, messages)
  }, [messages, userId])

  // Click outside to close
  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      // 检查点击是否在面板或按钮外部
      if (
        panelRef.current && !panelRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }

    // 延迟添加监听器，避免打开时立即触发
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  // Drag & resize handlers
  useEffect(() => {
    if (!isDragging && !isResizing && !isButtonDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        setPosition({
          x: e.clientX - dragStart.x,
          y: e.clientY - dragStart.y,
        })
      } else if (isResizing) {
        const delta = e.clientX - resizeStart.x
        if (resizeEdge === 'left') {
          // 从左边拖动：调整左侧边界（同时改变位置和宽度）
          const targetWidth = resizeStart.width - delta
          const newWidth = Math.max(360, Math.min(800, targetWidth))
          // 计算实际可以移动的距离（考虑宽度限制）
          const actualWidthChange = resizeStart.width - newWidth
          const newLeft = resizeStart.posX + actualWidthChange
          setWidth(newWidth)
          setPosition(prev => ({
            ...prev,
            x: newLeft
          }))
        } else {
          // 从右边拖动：调整右侧边界（只改变宽度）
          const newWidth = Math.max(360, Math.min(800, resizeStart.width + delta))
          setWidth(newWidth)
        }
      } else if (isButtonDragging) {
        const newX = e.clientX - buttonDragStart.x
        const newY = e.clientY - buttonDragStart.y
        // 如果移动超过5px，认为是拖动而不是点击
        if (Math.abs(newX - buttonPosition.x) > 5 || Math.abs(newY - buttonPosition.y) > 5) {
          buttonDraggedRef.current = true
        }
        setButtonPosition({
          x: newX,
          y: newY,
        })
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setIsResizing(false)
      setIsButtonDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, isResizing, isButtonDragging, dragStart, resizeStart, buttonDragStart])

  const handleDragStart = (e: React.MouseEvent) => {
    if (!panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    setDragStart({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
    setIsDragging(true)
  }

  const handleResizeStart = (edge: 'left' | 'right') => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    setResizeEdge(edge)
    setResizeStart({
      x: e.clientX,
      width,
      posX: rect.left, // 使用实际的左边界位置，而不是 position.x
    })
    setIsResizing(true)
  }

  const handleButtonDragStart = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setButtonDragStart({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
    buttonDraggedRef.current = false // 重置拖动标记
    setIsButtonDragging(true)
  }

  const handleButtonClick = (e: React.MouseEvent) => {
    // Only toggle if not dragged (pure click without drag)
    if (!buttonDraggedRef.current) {
      setOpen((v) => !v)
      setShowHint(false)
    }
    buttonDraggedRef.current = false // 重置标记
  }

  function readFileAsBase64(file: File): Promise<{ base64: string; type: string; preview: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        const base64 = dataUrl.split(',')[1]
        resolve({ base64, type: file.type, preview: dataUrl })
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  // Video upload function (hidden)
  // async function uploadVideoFile(file: File): Promise<string> {
  //   const formData = new FormData()
  //   formData.append('file', file)
  //   const token = useAuthStore.getState().accessToken
  //   const res = await fetch('/api/v1/ai-assistant/upload', {
  //     method: 'POST',
  //     headers: token ? { Authorization: `Bearer ${token}` } : {},
  //     body: formData,
  //   })
  //   if (!res.ok) throw new Error('视频上传失败')
  //   const data = await res.json()
  //   return data.temp_id as string
  // }

  async function handleChatImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const result = await readFileAsBase64(file)
    setChatImage({ ...result, name: file.name })
    // setChatVideo(null)
    e.target.value = ''
  }

  // Video pick handler (hidden)
  // async function handleChatVideoPick(e: React.ChangeEvent<HTMLInputElement>) {
  //   const file = e.target.files?.[0]
  //   if (!file) return
  //   setChatVideoUploading(true)
  //   setChatImage(null)
  //   try {
  //     const tempId = await uploadVideoFile(file)
  //     setChatVideo({ tempId, name: file.name })
  //   } catch {
  //     alert('视频上传失败，请重试')
  //   } finally {
  //     setChatVideoUploading(false)
  //   }
  //   e.target.value = ''
  // }

  async function handleImageTabPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const result = await readFileAsBase64(file)
    setImageFile({ ...result, name: file.name })
    e.target.value = ''
  }

  // Video tab pick handler (hidden)
  // async function handleVideoTabPick(e: React.ChangeEvent<HTMLInputElement>) {
  //   const file = e.target.files?.[0]
  //   if (!file) return
  //   setVideoFile(file)
  //   setVideoTempId(null)
  //   setVideoUploadProgress(0)
  //   e.target.value = ''
  // }

  // async function uploadVideoTab() {
  //   if (!videoFile) return null
  //   setVideoUploadProgress(10)
  //   try {
  //     const tempId = await uploadVideoFile(videoFile)
  //     setVideoTempId(tempId)
  //     setVideoUploadProgress(100)
  //     return tempId
  //   } catch {
  //     setVideoUploadProgress(0)
  //     throw new Error('视频上传失败')
  //   }
  // }

  const sendMessage = useCallback(async (opts: {
    message?: string
    tab: Tab
    image_base64?: string | null
    image_type?: string | null
    video_temp_id?: string | null
    userLabel?: string
    imagePreview?: string
    mediaLabel?: string
  }) => {
    const { message = '', tab: sendTab, image_base64, image_type, video_temp_id, userLabel, imagePreview, mediaLabel } = opts

    const userMsg: AiChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: userLabel ?? message,
      imagePreview,
      mediaLabel,
      timestamp: Date.now(),
    }

    const assistantMsg: AiChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setLoading(true)

    // Build history (text only, last 6 messages, content truncated to 12000 chars)
    const history = messages
      .filter((m) => !m.mediaLabel || m.role === 'assistant')
      .slice(-6)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 12000) }))

    try {
      const res = await fetchWithAuth('/api/v1/ai-assistant/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: message || undefined,
          tab: sendTab,
          image_base64: image_base64 ?? null,
          image_type: image_type ?? null,
          video_temp_id: video_temp_id ?? null,
          history,
        }),
      })

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: { message: 'AI助手暂时不可用' } }))
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, content: err?.error?.message ?? 'AI助手暂时不可用，请稍后重试' } : m
        ))
        return
      }

      // Stream SSE with 5-minute timeout
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''
      const startTime = Date.now()
      const TIMEOUT = 5 * 60 * 1000 // 5 minutes

      while (true) {
        if (Date.now() - startTime > TIMEOUT) {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, content: accumulated || '请求超时，请重试' } : m
          ))
          break
        }

        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') break
          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              accumulated += delta
              setMessages((prev) => prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, content: accumulated } : m
              ))
            }
          } catch {}
        }
      }
    } catch (err) {
      setMessages((prev) => prev.map((m) =>
        m.id === assistantMsg.id ? { ...m, content: '请求失败，请检查网络后重试' } : m
      ))
    } finally {
      setLoading(false)
    }
  }, [messages])

  async function handleChatSend() {
    if (loading) return
    const text = input.trim()
    if (!text && !chatImage) return // && !chatVideo

    const opts: Parameters<typeof sendMessage>[0] = { tab: 'chat' }
    if (text) opts.message = text
    if (chatImage) {
      opts.image_base64 = chatImage.base64
      opts.image_type = chatImage.type
      opts.imagePreview = chatImage.preview
      opts.mediaLabel = `[图片: ${chatImage.name}]`
      opts.userLabel = text || `[图片: ${chatImage.name}]`
    }
    // else if (chatVideo) {
    //   opts.video_temp_id = chatVideo.tempId
    //   opts.mediaLabel = `[视频: ${chatVideo.name}]`
    //   opts.userLabel = text || `[视频: ${chatVideo.name}]`
    // }
    else {
      opts.userLabel = text
    }

    setInput('')
    setChatImage(null)
    // setChatVideo(null)
    await sendMessage(opts)
  }

  async function handleImageAnalyze() {
    if (!imageFile || loading) return
    await sendMessage({
      tab: 'image',
      image_base64: imageFile.base64,
      image_type: imageFile.type,
      imagePreview: imageFile.preview,
      mediaLabel: `[图片: ${imageFile.name}]`,
      userLabel: `[图片: ${imageFile.name}]`,
    })
    setImageFile(null)
  }

  // Video analyze handler (hidden)
  // async function handleVideoAnalyze() {
  //   if (!videoFile || loading) return
  //   try {
  //     let tempId = videoTempId
  //     if (!tempId) tempId = await uploadVideoTab()
  //     if (!tempId) return
  //     await sendMessage({
  //       tab: 'video',
  //       video_temp_id: tempId,
  //       mediaLabel: `[视频: ${videoFile.name}]`,
  //       userLabel: `[视频: ${videoFile.name}]`,
  //     })
  //     setVideoFile(null)
  //     setVideoTempId(null)
  //     setVideoUploadProgress(0)
  //   } catch (e: any) {
  //     alert(e.message ?? '视频处理失败')
  //   }
  // }

  function handleClear() {
    setMessages([])
    clearAiChatHistory(userId)
  }

  const handleCopy = useCallback(async (content: string, id: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(id)
      toast.success('已复制到剪贴板')
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      toast.error('复制失败')
    }
  }, [])

  return (
    <>
      {/* Floating button */}
      <button
        ref={buttonRef}
        onMouseDown={handleButtonDragStart}
        onClick={handleButtonClick}
        className={cn(
          'fixed z-50 flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all duration-200 gradient-accent hover:scale-105 active:scale-95 cursor-move',
          open && 'rotate-90',
          showHint && !open && 'ring-4 ring-primary/30 shadow-2xl shadow-primary/40'
        )}
        style={{
          left: buttonPosition.x ? `${buttonPosition.x}px` : 'auto',
          right: buttonPosition.x ? 'auto' : '24px',
          top: buttonPosition.y ? `${buttonPosition.y}px` : 'auto',
          bottom: buttonPosition.y ? 'auto' : '80px',
        }}
        aria-label="AI助手"
      >
        {open ? <X className="h-6 w-6 text-white" /> : <Bot className="h-6 w-6 text-white" />}
      </button>
      {showHint && !open && (
        <div
          className="fixed z-50 w-64 rounded-2xl bg-background p-[2px] text-sm text-foreground shadow-2xl shadow-primary/20 animate-in fade-in slide-in-from-bottom-3 zoom-in-95 duration-500 gradient-accent"
          style={{
            right: buttonPosition.x ? 'auto' : '24px',
            left: buttonPosition.x ? `${Math.max(16, buttonPosition.x - 208)}px` : 'auto',
            bottom: buttonPosition.y ? 'auto' : '152px',
            top: buttonPosition.y ? `${Math.max(16, buttonPosition.y - 104)}px` : 'auto',
          }}
        >
          <div className="relative rounded-[14px] bg-background p-4">
            <button
              type="button"
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setShowHint(false)}
              aria-label="关闭提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-start gap-3 pr-5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full gradient-accent shadow-lg animate-pulse">
                <Bot className="h-5 w-5 text-white" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">试试 Toby.AI 创作助手</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">点这里可以优化提示词、解析图片，帮你更快生成想要的内容。</p>
              </div>
            </div>
          </div>
          <div className="absolute -bottom-2 right-7 h-4 w-4 rotate-45 gradient-accent" />
          <div className="absolute -bottom-[5px] right-[30px] h-3 w-3 rotate-45 bg-background" />
        </div>
      )}

      {/* Chat panel */}
      {open && (
        <div
          ref={panelRef}
          className="fixed z-50 flex flex-col rounded-2xl border border-border bg-background shadow-2xl overflow-hidden"
          style={{
            left: position.x ? `${position.x}px` : 'auto',
            right: position.x ? 'auto' : '104px',
            top: position.y ? `${position.y}px` : '16px',
            width: `${width}px`,
            height: 'calc(100vh - 32px)',
          }}>

          {/* Header - draggable */}
          <div
            className="flex items-center justify-between px-4 py-3 gradient-accent cursor-move"
            onMouseDown={handleDragStart}>
            <div className="flex items-center gap-2">
              <GripVertical className="h-4 w-4 text-white/50" />
              <Bot className="h-5 w-5 text-white" />
              <span className="font-semibold text-white text-sm">Toby.AI 创作助手</span>
            </div>
            <button onClick={handleClear} className="text-red-400 hover:text-red-300 transition-colors" title="清空对话">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          {/* Resize handle - left edge */}
          <div
            className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/50 transition-colors z-10"
            onMouseDown={handleResizeStart('left')}
          />

          {/* Resize handle - right edge */}
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/50 transition-colors z-10"
            onMouseDown={handleResizeStart('right')}
          />

          {/* Messages */}
          <ScrollArea className="flex-1 px-3 py-3 overflow-x-hidden">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground py-12 gap-2">
                <Bot className="h-10 w-10 opacity-20" />
                <p className="text-sm">你好！我是 Toby.AI 创作助手</p>
                <p className="text-xs opacity-60">可以帮你设计提示词、解析图片/视频</p>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={cn(
                'mb-3 flex min-w-0 w-full overflow-hidden',
                msg.role === 'user' ? 'justify-end pl-8' : 'justify-start pr-8'
              )}>
                <div className={cn(
                  'max-w-full min-w-0 rounded-2xl px-3 py-2 text-sm leading-relaxed break-words overflow-hidden relative group',
                  msg.role === 'user'
                    ? 'gradient-accent text-white rounded-br-sm'
                    : 'bg-muted text-foreground rounded-bl-sm'
                )}>
                  {msg.imagePreview && (
                    <img src={msg.imagePreview} alt="附件" className="mb-1.5 max-h-32 rounded-lg object-cover" />
                  )}
                  {msg.content === '' && msg.role === 'assistant'
                    ? <Loader2 className="h-4 w-4 animate-spin opacity-50" />
                    : msg.role === 'assistant'
                    ? (
                      <>
                        <div className="prose prose-sm dark:prose-invert max-w-full break-words overflow-hidden pb-8 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_table]:block [&_table]:overflow-x-auto [&_*]:max-w-full [&_p]:break-words [&_li]:break-words"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
                        {msg.content && (
                          <button
                            onClick={() => handleCopy(msg.content, msg.id)}
                            className="absolute bottom-2 right-2 p-1.5 rounded-md bg-background/80 hover:bg-background border border-border opacity-0 group-hover:opacity-100 transition-opacity"
                            title="复制"
                          >
                            {copiedId === msg.id ? (
                              <Check className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </>
                    )
                    : <span className="whitespace-pre-wrap break-words">{msg.content}</span>
                  }
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </ScrollArea>

          {/* Input area */}
          <div className="border-t border-border bg-background">
            {/* Tab bar */}
            <div className="flex border-b border-border">
              {TAB_CONFIG.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
                    tab === t.id
                      ? 'border-b-2 border-primary text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab: 对话助手 */}
            {tab === 'chat' && (
              <div className="p-3 space-y-2">
                {/* Attachment preview */}
                {chatImage && ( // || chatVideo || chatVideoUploading
                  <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground">
                    {chatImage && (
                      <>
                        <img src={chatImage.preview} alt="" className="h-8 w-8 rounded object-cover" />
                        <span className="flex-1 truncate">{chatImage.name}</span>
                        <button onClick={() => setChatImage(null)} className="hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                      </>
                    )}
                    {/* {chatVideoUploading && <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>上传中...</span></>}
                    {chatVideo && !chatVideoUploading && (
                      <>
                        <Video className="h-4 w-4 shrink-0" />
                        <span className="flex-1 truncate">{chatVideo.name}</span>
                        <button onClick={() => setChatVideo(null)} className="hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                      </>
                    )} */}
                  </div>
                )}
                <div className="flex gap-2 items-end">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); handleChatSend() } }}
                    placeholder="描述需求，或上传图片... (Shift+Enter 发送)"
                    className="min-h-[60px] max-h-[120px] resize-none text-sm"
                    disabled={loading}
                  />
                  <div className="flex flex-col gap-1">
                    <input ref={chatImageRef} type="file" accept="image/*" className="hidden" onChange={handleChatImagePick} />
                    {/* <input ref={chatVideoRef} type="file" accept="video/*" className="hidden" onChange={handleChatVideoPick} /> */}
                    <button onClick={() => chatImageRef.current?.click()} title="附加图片"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-border hover:bg-muted transition-colors">
                      <ImageIcon className="h-4 w-4 text-muted-foreground" />
                    </button>
                    {/* <button onClick={() => chatVideoRef.current?.click()} title="附加视频"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-border hover:bg-muted transition-colors">
                      <Video className="h-4 w-4 text-muted-foreground" />
                    </button> */}
                    <Button size="icon" className="h-8 w-8 gradient-accent" onClick={handleChatSend}
                      disabled={loading || (!input.trim() && !chatImage)}>
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Tab: 图片解析 */}
            {tab === 'image' && (
              <div className="p-3 space-y-2">
                <input ref={imageTabRef} type="file" accept="image/*" className="hidden" onChange={handleImageTabPick} />
                {!imageFile ? (
                  <button onClick={() => imageTabRef.current?.click()}
                    className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border py-6 text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                    <Upload className="h-8 w-8" />
                    <span className="text-sm font-medium">点击上传图片</span>
                    <span className="text-xs opacity-60">JPG / PNG / WEBP</span>
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="relative rounded-xl overflow-hidden bg-muted">
                      <img src={imageFile.preview} alt="预览" className="w-full max-h-40 object-contain" />
                      <button onClick={() => setImageFile(null)}
                        className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <Button className="w-full gradient-accent" onClick={handleImageAnalyze} disabled={loading}>
                      {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />解析中...</> : '开始解析'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Tab: 视频解析 (hidden) */}
            {/* {tab === 'video' && (
              <div className="p-3 space-y-2">
                <input ref={videoTabRef} type="file" accept="video/*" className="hidden" onChange={handleVideoTabPick} />
                {!videoFile ? (
                  <button onClick={() => videoTabRef.current?.click()}
                    className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border py-6 text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                    <Upload className="h-8 w-8" />
                    <span className="text-sm font-medium">点击上传视频</span>
                    <span className="text-xs opacity-60">MP4 / MOV / WEBM ≤ 100MB</span>
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2.5">
                      <Video className="h-5 w-5 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate text-sm">{videoFile.name}</span>
                      <button onClick={() => { setVideoFile(null); setVideoTempId(null); setVideoUploadProgress(0) }}>
                        <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                      </button>
                    </div>
                    {videoUploadProgress > 0 && videoUploadProgress < 100 && (
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div className="h-full gradient-accent transition-all duration-300" style={{ width: `${videoUploadProgress}%` }} />
                      </div>
                    )}
                    <Button className="w-full gradient-accent" onClick={handleVideoAnalyze} disabled={loading}>
                      {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />解析中...</> : '开始解析'}
                    </Button>
                  </div>
                )}
              </div>
            )} */}
          </div>
        </div>
      )}
    </>
  )
}
