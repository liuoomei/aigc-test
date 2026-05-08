'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import ReactFlow, {
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  useStore,
} from 'reactflow'
import 'reactflow/dist/style.css'

import { useCanvasStructureStore } from '@/stores/canvas/structure-store'
import { useCanvasExecutionStore } from '@/stores/canvas/execution-store'
import { nodeRegistry } from '@/lib/canvas/registry'
import { useCanvasPoller } from '@/hooks/canvas/use-canvas-poller'
import { useCanvasAutosave } from '@/hooks/canvas/use-canvas-autosave'
import { useAuthStore } from '@/stores/auth-store'
import { uploadAssetFile } from '@/lib/canvas/canvas-api'
import { useCanvasSidebarDataStore } from '@/stores/canvas/sidebar-data-store'
import { toast } from 'sonner'
import { randomUUID } from '@/lib/utils'
import { NodeParamPanel } from './node-param-panel'
import type { AppNode, AppEdge } from '@/lib/canvas/types'
import { getUpstreamNodeIds } from '@/lib/canvas/dag'

const nodeTypes = nodeRegistry.getReactFlowTypesMapping()

const NODE_CANVAS_H: Record<string, number> = {
  image_gen: 260,
  text_input: 130,
  asset: 200,
  video_gen: 220,
  script_writer: 100,
  storyboard_splitter: 100,
}

function FloatingParamPanel({
  node,
  canvasId,
  wrapperRef,
  onClose,
  onExecuted,
  onStoryboardExpandedRef,
}: {
  node: AppNode
  canvasId: string
  wrapperRef: React.RefObject<HTMLDivElement>
  onClose: () => void
  onExecuted: () => void
  onStoryboardExpandedRef?: MutableRefObject<((shotNodeIds: string[]) => void) | null>
}) {
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const PANEL_W = ['script_writer', 'storyboard_splitter'].includes(node.type ?? '') ? 320 : 640
  const PANEL_MAX_H = 560
  const NODE_W = node.type === 'script_writer' || node.type === 'storyboard_splitter' ? 240 : 280
  const GAP = 8

  const rect = wrapperRef.current?.getBoundingClientRect()
  if (!rect) return null

  const domNode = wrapperRef.current?.querySelector(`[data-id="${node.id}"]`) as HTMLElement | null
  const nodeScreenH = domNode
    ? domNode.getBoundingClientRect().height
    : (NODE_CANVAS_H[node.type ?? ''] ?? 200) * zoom

  const sx = rect.left + node.position.x * zoom + tx
  const sy = rect.top + node.position.y * zoom + ty

  const rawTop = sy + nodeScreenH + GAP
  const rawLeft = sx + (NODE_W * zoom) / 2 - PANEL_W / 2
  const top = Math.min(rawTop, window.innerHeight - 200)
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - PANEL_W - 8))

  return createPortal(
    <div
      className="fixed z-50 drop-shadow-2xl"
      style={{ top, left, width: PANEL_W, maxHeight: PANEL_MAX_H, overflowY: 'auto' }}
    >
      <NodeParamPanel
        node={node}
        canvasId={canvasId}
        onClose={onClose}
        onExecuted={onExecuted}
        onStoryboardExpandedRef={onStoryboardExpandedRef}
      />
    </div>,
    document.body
  )
}

function Flow({
  canvasId,
  onSave,
  saving,
  lastSaved,
  onKickPollReady,
  onNodeSelected,
  onStoryboardExpandedRef,
}: {
  canvasId: string
  onSave: () => void
  saving: boolean
  lastSaved: Date | null
  onKickPollReady?: (fn: () => void) => void
  onNodeSelected?: (nodeId: string) => boolean
  onStoryboardExpandedRef?: MutableRefObject<((shotNodeIds: string[]) => void) | null>
}) {
  const nodes = useCanvasStructureStore((s) => s.nodes)
  const edges = useCanvasStructureStore((s) => s.edges)
  const onNodesChange = useCanvasStructureStore((s) => s.onNodesChange)
  const onEdgesChange = useCanvasStructureStore((s) => s.onEdgesChange)
  const onConnect = useCanvasStructureStore((s) => s.onConnect)
  const flushHistory = useCanvasStructureStore((s) => s.flushHistory)
  const addNode = useCanvasStructureStore((s) => s.addNode)
  const addNodeWithConfig = useCanvasStructureStore((s) => s.addNodeWithConfig)
  const removeNodes = useCanvasStructureStore((s) => s.removeNodes)
  const generatingNodeIds = useCanvasExecutionStore((s) => s.generatingNodeIds)
  const setHighlightedNodes = useCanvasExecutionStore((s) => s.setHighlightedNodes)
  const { project } = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const token = useAuthStore((s) => s.accessToken)
  const [uploading, setUploading] = useState(false)

  // Track drag-connect source so onConnectEnd can auto-connect to node body
  const connectStartRef = useRef<{ nodeId: string; handleId: string | null } | null>(null)
  const connectCompletedRef = useRef(false)

  const handleConnectStart = useCallback((_: any, params: { nodeId: string | null; handleId: string | null }) => {
    connectStartRef.current = params.nodeId ? { nodeId: params.nodeId, handleId: params.handleId } : null
    connectCompletedRef.current = false
  }, [])

  const handleConnect = useCallback((connection: any) => {
    connectCompletedRef.current = true
    const err = onConnect(connection)
    if (err) toast.error(err)
  }, [onConnect])

  const handleConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    // If already connected via handle, skip
    if (connectCompletedRef.current || !connectStartRef.current) return
    const src = connectStartRef.current
    connectStartRef.current = null

    const clientX = 'touches' in event ? event.changedTouches[0].clientX : event.clientX
    const clientY = 'touches' in event ? event.changedTouches[0].clientY : event.clientY

    // Walk up DOM from cursor position to find a ReactFlow node element
    let el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    let targetNodeId: string | null = null
    while (el && el !== document.body) {
      if (el.classList?.contains('react-flow__node') && el.dataset?.id) {
        targetNodeId = el.dataset.id
        break
      }
      el = el.parentElement
    }

    if (!targetNodeId || targetNodeId === src.nodeId) return

    // Determine best targetHandle: for keyframe video nodes use any-in; default any-in
    const err = onConnect({
      source: src.nodeId,
      sourceHandle: src.handleId,
      target: targetNodeId,
      targetHandle: 'any-in',
    })
    if (err) toast.error(err)
  }, [onConnect])

  const { kickPoll } = useCanvasPoller(canvasId)

  useEffect(() => {
    onKickPollReady?.(kickPoll)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kickPoll])

  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null)

  const handlePaneContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    const canvasPos = project({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    setContextMenu({ x: e.clientX, y: e.clientY, canvasX: canvasPos.x, canvasY: canvasPos.y })
  }, [project])

  const handleContextMenuAdd = useCallback((type: string) => {
    if (!contextMenu) return
    addNode(type, { x: contextMenu.canvasX, y: contextMenu.canvasY })
    setContextMenu(null)
  }, [contextMenu, addNode])

  const [showShortcuts, setShowShortcuts] = useState(false)
  const copiedNodeRef = useRef<AppNode | null>(null)
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const trackingMouseRef = useRef(false)
  const trackMouse = useCallback((e: MouseEvent) => { mousePosRef.current = { x: e.clientX, y: e.clientY } }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return

      const isMod = e.metaKey || e.ctrlKey

      // Undo: Ctrl+Z
      if (isMod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        flushHistory()
        useCanvasStructureStore.getState().undo()
        setHighlightedNodes(new Set())
        void onSave()
        return
      }
      // Redo: Ctrl+Shift+Z or Ctrl+Y
      if ((isMod && e.key === 'z' && e.shiftKey) || (isMod && e.key === 'y')) {
        e.preventDefault()
        flushHistory()
        useCanvasStructureStore.getState().redo()
        setHighlightedNodes(new Set())
        void onSave()
        return
      }

      if (isMod && e.key === 'c' && selectedNodeId) {
        const node = nodes.find((n) => n.id === selectedNodeId)
        if (node) {
          copiedNodeRef.current = node
          if (!trackingMouseRef.current) {
            trackingMouseRef.current = true
            window.addEventListener('mousemove', trackMouse, { passive: true })
          }
        }
        return
      }

      if (isMod && e.key === 'v' && copiedNodeRef.current) {
        const rect = wrapperRef.current?.getBoundingClientRect()
        if (!rect) return
        const pos = project({
          x: mousePosRef.current.x - rect.left,
          y: mousePosRef.current.y - rect.top,
        })
        const newId = `node_${randomUUID()}`
        addNodeWithConfig(
          copiedNodeRef.current.type!,
          { x: pos.x + 20, y: pos.y + 20 },
          { ...copiedNodeRef.current.data.config },
          newId,
        )
        window.removeEventListener('mousemove', trackMouse)
        trackingMouseRef.current = false
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (trackingMouseRef.current) {
        window.removeEventListener('mousemove', trackMouse)
        trackingMouseRef.current = false
      }
    }
  }, [selectedNodeId, nodes, addNodeWithConfig, project, trackMouse, flushHistory, onSave])

  const handleAddNode = useCallback((type: string) => {
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    const existingCount = nodes.filter((n) => n.type === type).length
    const offset = existingCount * 40
    const position = project({ x: rect.width / 2 + offset, y: rect.height / 2 + offset })
    addNode(type, position)
  }, [addNode, project, nodes])

  // Delete key: remove selected node or edge
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdgeId) {
          onEdgesChange([{ type: 'remove', id: selectedEdgeId }])
          setSelectedEdgeId(null)
        } else if (selectedNodeIds.length > 1) {
          removeNodes(selectedNodeIds)
          setSelectedNodeIds([])
          setSelectedNodeId(null)
        } else if (selectedNodeId) {
          removeNodes([selectedNodeId])
          setSelectedNodeId(null)
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedNodeIds, selectedEdgeId, removeNodes, onEdgesChange])

  // Drop file onto canvas → create asset node
  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/')
    )
    if (!files.length) return
    if (!token) { toast.error('请先登录'); return }

    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return

    setUploading(true)
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const position = project({
          x: e.clientX - rect.left + i * 180,
          y: e.clientY - rect.top,
        })
        try {
          const url = await uploadAssetFile(file, token)
          const nodeId = `node_${randomUUID()}`
          addNodeWithConfig('asset', position, {
            url,
            name: file.name,
            mimeType: file.type,
          }, nodeId)
        } catch (err: any) {
          toast.error(`上传 ${file.name} 失败: ${err.message}`)
        }
      }
    } finally {
      setUploading(false)
    }
  }, [token, project, addNodeWithConfig])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  )

  // Compute direct upstream node IDs for lineage highlighting (one layer only)
  const directUpstreamIds = useMemo(
    () => selectedNodeId ? new Set(getUpstreamNodeIds(selectedNodeId, edges)) : new Set<string>(),
    [selectedNodeId, edges]
  )

  // Style edges — full .map() on every selection/generation change.
  // At <200 edges the cost is <1ms; if edge counts grow significantly,
  // consider a diffing approach that only spreads changed edges.
  const styledEdges = useMemo<AppEdge[]>(() => edges.map((edge) => {
    const isUpstream = selectedNodeId
      ? edge.target === selectedNodeId
      : false
    const isActive = generatingNodeIds.has(edge.target)
    const isSelected = edge.id === selectedEdgeId

    if (isSelected) return { ...edge, animated: false, style: { stroke: '#ef4444', strokeWidth: 2 } }
    if (isActive) return { ...edge, animated: true, style: { stroke: '#3b82f6', strokeWidth: 2 } }
    if (isUpstream) return { ...edge, animated: false, style: { stroke: '#a78bfa', strokeWidth: 2 } }
    return { ...edge, animated: false, style: { stroke: '#d4d4d8', strokeWidth: 1.5 } }
  }), [edges, selectedNodeId, selectedEdgeId, generatingNodeIds])

  // Push direct upstream highlight set into execution store so nodes read it directly
  // (avoids recreating all node data objects on selection change)
  useEffect(() => {
    setHighlightedNodes(directUpstreamIds)
  }, [directUpstreamIds, setHighlightedNodes])

  // nodes passed to ReactFlow are stable — no data mutation needed
  const saveLabel = saving
    ? '保存中…'
    : lastSaved
    ? `已保存 ${lastSaved.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : '保存'

  const handleSelectionChange = useCallback(({ nodes: sel }: { nodes: Array<{ id: string }> }) => {
    if (sel.length > 1) {
      const next = sel.map((n) => n.id)
      setSelectedNodeIds((prev) => {
        if (prev.length === next.length && prev.every((id, i) => id === next[i])) return prev
        return next
      })
      return
    }
    setSelectedNodeIds((prev) => (prev.length === 0 ? prev : []))
  }, [])

  const handleNodeClick = useCallback((_e: unknown, node: AppNode) => {
    if (onNodeSelected?.(node.id)) return // consumed by agent — skip selection
    setSelectedEdgeId(null)
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id))
  }, [onNodeSelected])

  const handleEdgeClick = useCallback((_e: unknown, edge: AppEdge) => {
    setSelectedNodeId(null)
    setSelectedEdgeId((prev) => (prev === edge.id ? null : edge.id))
  }, [])

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setSelectedNodeIds((prev) => (prev.length === 0 ? prev : []))
    setContextMenu((prev) => (prev ? null : prev))
  }, [])

  return (
    <div
      className="w-full h-full relative"
      ref={wrapperRef}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      style={{
        background: '#fafafa',
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden',
        WebkitFontSmoothing: 'antialiased',
      } as React.CSSProperties}
    >
      {uploading && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/20 pointer-events-none">
          <div className="bg-white rounded-xl px-4 py-2 shadow-lg text-sm font-medium text-zinc-700">上传中…</div>
        </div>
      )}

      {/* Empty state */}
      {nodes.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-zinc-400">
            <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-zinc-300 flex items-center justify-center">
              <span className="text-2xl">✦</span>
            </div>
            <p className="text-sm font-medium text-zinc-500">右键画布或点击顶部按钮添加节点</p>
            <p className="text-xs text-zinc-400">拖拽图片/视频/音频到画布可快速创建素材节点</p>
          </div>
        </div>
      )}

      {/* Selected edge delete hint */}
      {selectedEdgeId && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="bg-zinc-800/90 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg">
            按 Delete 删除连线
          </div>
        </div>
      )}

      {/* Multi-select hint */}
      {selectedNodeIds.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="bg-zinc-800/90 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg">
            已选中 {selectedNodeIds.length} 个节点 · 按 Delete 批量删除
          </div>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart as any}
        onConnectEnd={handleConnectEnd as any}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick as any}
        onEdgeClick={handleEdgeClick as any}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu as any}
        onSelectionChange={handleSelectionChange as any}
        fitView
        minZoom={0.1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#fafafa' }}
        deleteKeyCode={null}
        panOnDrag
        panOnScroll
        selectionOnDrag={false}
        selectionKeyCode="Control"
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode="Shift"
      >
        <Controls
          className="!bg-white !border-zinc-200 [&>button]:!bg-white [&>button]:!border-zinc-200 [&>button]:!text-zinc-500 [&>button:hover]:!bg-zinc-100 [&>button:hover]:!text-zinc-800"
        />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'image_gen') return '#3b82f6'
            if (node.type === 'video_gen') return '#7c3aed'
            if (node.type === 'text_input') return '#6b7280'
            if (node.type === 'asset') return '#10b981'
            return '#d4d4d8'
          }}
          maskColor="rgba(250,250,250,0.7)"
          className="!bg-white/90 !border-zinc-200 !rounded-xl"
          style={{ width: 140, height: 90 }}
        />
        <Panel
          position="top-left"
          className="bg-white/90 backdrop-blur-md p-2 rounded-xl border border-zinc-200 shadow-md flex gap-2"
        >
          <button
            data-testid="canvas-add-node-text"
            onClick={() => handleAddNode('text_input')}
            className="px-3 py-1.5 text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-600 hover:text-zinc-900 rounded-lg border border-zinc-200 transition-colors"
          >
            + 纯文本
          </button>
          <button
            data-testid="canvas-add-node-image"
            onClick={() => handleAddNode('image_gen')}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow transition-colors"
          >
            + AI生图
          </button>
          <button
            data-testid="canvas-add-node-asset"
            onClick={() => handleAddNode('asset')}
            className="px-3 py-1.5 text-xs font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-600 hover:text-zinc-900 rounded-lg border border-zinc-200 transition-colors"
          >
            + 素材
          </button>
          <button
            data-testid="canvas-add-node-video"
            onClick={() => handleAddNode('video_gen')}
            className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white rounded-lg shadow transition-colors"
          >
            + AI视频
          </button>
        </Panel>
        <Panel position="top-right" className="flex gap-1.5">
          <button
            onClick={() => {
              flushHistory()
              useCanvasStructureStore.getState().undo()
              setHighlightedNodes(new Set())
              void onSave()
            }}
            className="px-2 py-1.5 text-xs font-medium bg-white hover:bg-zinc-50 text-zinc-500 rounded-lg border border-zinc-200 shadow-sm transition-colors"
            title="撤销 (Ctrl+Z)"
          >
            ↩
          </button>
          <button
            onClick={() => {
              flushHistory()
              useCanvasStructureStore.getState().redo()
              setHighlightedNodes(new Set())
              void onSave()
            }}
            className="px-2 py-1.5 text-xs font-medium bg-white hover:bg-zinc-50 text-zinc-500 rounded-lg border border-zinc-200 shadow-sm transition-colors"
            title="重做 (Ctrl+Shift+Z)"
          >
            ↪
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white hover:bg-zinc-50 text-zinc-500 rounded-lg border border-zinc-200 shadow-sm transition-colors disabled:opacity-60 min-w-[80px] justify-center"
          >
            {saving && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
            {saveLabel}
          </button>
          <button
            onClick={() => setShowShortcuts((v) => !v)}
            className={`px-2 py-1.5 text-xs font-medium rounded-lg border shadow-sm transition-colors ${showShortcuts ? 'bg-zinc-800 text-white border-zinc-700' : 'bg-white hover:bg-zinc-50 text-zinc-500 border-zinc-200'}`}
            title="快捷键"
          >
            ?
          </button>
        </Panel>

        {showShortcuts && (
          <Panel position="top-right" className="mt-10">
            <div className="bg-zinc-900/95 text-white text-xs rounded-xl shadow-2xl p-4 w-56 space-y-2.5">
              <div className="font-semibold text-zinc-300 mb-1">快捷键</div>
              {[
                ['Ctrl+Z', '撤销'],
                ['Ctrl+Shift+Z', '重做'],
                ['Ctrl+C', '复制节点'],
                ['Ctrl+V', '粘贴节点'],
                ['Delete / ⌫', '删除节点/连线'],
                ['右键画布', '添加节点菜单'],
                ['Shift+拖拽', '多选节点'],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <kbd className="bg-zinc-700 text-zinc-200 px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap">{key}</kbd>
                  <span className="text-zinc-400 text-right">{desc}</span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </ReactFlow>

      {selectedNode && (
        <FloatingParamPanel
          node={selectedNode}
          canvasId={canvasId}
          wrapperRef={wrapperRef}
          onClose={() => setSelectedNodeId(null)}
          onExecuted={kickPoll}
          onStoryboardExpandedRef={onStoryboardExpandedRef}
        />
      )}

      {/* Right-click context menu */}
      {contextMenu && createPortal(
        <div
          className="fixed z-50 bg-white border border-zinc-200 rounded-xl shadow-xl py-1 min-w-[140px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <button
            onClick={() => handleContextMenuAdd('text_input')}
            className="w-full text-left px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            + 纯文本节点
          </button>
          <button
            onClick={() => handleContextMenuAdd('image_gen')}
            className="w-full text-left px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            + AI 生图节点
          </button>
          <button
            onClick={() => handleContextMenuAdd('asset')}
            className="w-full text-left px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            + 素材节点
          </button>
          <button
            onClick={() => handleContextMenuAdd('video_gen')}
            className="w-full text-left px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            + AI 视频节点
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}

export function CanvasEditor({ canvasId, onKickPollReady, onNodeSelected, onStoryboardExpandedRef }: { canvasId: string; onKickPollReady?: (fn: () => void) => void; onNodeSelected?: (nodeId: string) => boolean; onStoryboardExpandedRef?: MutableRefObject<((shotNodeIds: string[]) => void) | null> }) {
  const token = useAuthStore((s) => s.accessToken)
  const prefetchSidebar = useCanvasSidebarDataStore((s) => s.prefetch)

  const { save, saving, lastSaved } = useCanvasAutosave(canvasId)

  useEffect(() => {
    if (!canvasId || !token) return
    prefetchSidebar(canvasId, token)
  }, [canvasId, token, prefetchSidebar])

  return (
    <ReactFlowProvider>
      <Flow canvasId={canvasId} onSave={save} saving={saving} lastSaved={lastSaved} onKickPollReady={onKickPollReady} onNodeSelected={onNodeSelected} onStoryboardExpandedRef={onStoryboardExpandedRef} />
    </ReactFlowProvider>
  )
}
