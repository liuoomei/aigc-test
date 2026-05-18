import type { AppNode, AppEdge, ImageModelType, ImageResolution } from '@/lib/canvas/types'
import { randomUUID } from '@/lib/utils'

// ── Instruction union ────────────────────────────────────────────────────────

export interface AssetTypeHint {
  key: 'character' | 'scene' | 'bgm' | 'voice' | 'reference'
  label: string
  optional: boolean
}

export interface UploadedFile {
  nodeId: string
  name: string
  mimeType: string
  url: string
}

export interface AnnotationOptions {
  roles: string[]    // 从剧本提取的角色名列表
  scenes: string[]   // 从剧本提取的场景名列表
  segments: string[] // 片段序号列表
}

export interface PlanItem {
  id: string
  label: string
  description: string
  selected: boolean
}

export interface StoryboardItem {
  id: string        // e.g. "shot_1"
  label: string     // e.g. "镜头1"
  content: string   // editable prompt text for this shot's text_input node
}

export interface AgentStep {
  stepIndex: number
  totalSteps: number
  label: string
  nodeIds: string[]
  needsRun: boolean
  instruction: string
  nodeType: 'image_gen' | 'video_gen' | 'text_input' | 'mixed'
}

export interface AgentWorkflow {
  strategy: 'create' | 'append'
  summary: string
  reusedNodeIds: string[]
  newNodes: AppNode[]
  newEdges: AppEdge[]
  steps: AgentStep[]
}

export type AgentInstruction =
  | { type: 'ask_upload'; assetTypes: AssetTypeHint[] }
  | { type: 'annotate_assets'; assets: UploadedFile[]; options: AnnotationOptions }
  | { type: 'confirm_plan'; summary: string; estimatedCredits: number; estimatedMinutes: number; items: PlanItem[] }
  | { type: 'autorun'; message: string }
  | { type: 'confirm_storyboard'; items: StoryboardItem[] }
  | { type: 'apply_workflow'; workflow: AgentWorkflow }
  | { type: 'guide_step'; step: AgentStep }
  | { type: 'done' }

// ── Agent state ──────────────────────────────────────────────────────────────

export type AgentPhase =
  | 'idle'
  | 'waiting_llm'
  | 'waiting_user'
  | 'running'
  | 'autorunning'

export interface StepParams {
  modelType?: ImageModelType
  resolution?: ImageResolution
  aspectRatio?: string
  videoModel?: string
  duration?: number
}

export type AgentMessage =
  | {
      id: string
      role: 'user' | 'assistant'
      content: string
      instruction?: AgentInstruction
      implicitNodeId?: string  // 隐式引用的节点 id（选中节点自动关联）
      status: 'streaming' | 'done' | 'error'
    }
  | {
      id: string
      role: 'result'
      nodeId: string
      nodeLabel: string
      outputs: Array<{ url: string; type: 'image' | 'video' }>
    }

export interface CanvasNodeSummary {
  id: string
  type: string
  label: string
  configSummary: string
  hasOutput: boolean
  selectedOutputId: string | null
}

// ── Instruction parser ───────────────────────────────────────────────────────

export function parseAgentResponse(raw: string): {
  text: string
  instruction: AgentInstruction | null
} {
  const match = raw.match(/```instruction\n([\s\S]*?)\n```/)
  if (!match) return { text: raw, instruction: null }

  const text = raw.replace(/```instruction[\s\S]*?```/, '').trim()
  try {
    const parsed = JSON.parse(match[1])
    const instruction = fillInstructionDefaults(parsed)
    return { text, instruction }
  } catch {
    // 解析失败：静默降级，只显示文字
    return { text: raw, instruction: null }
  }
}

function fillInstructionDefaults(raw: any): AgentInstruction | null {
  if (!raw?.type) return null
  switch (raw.type) {
    case 'ask_upload':
      return { type: 'ask_upload', assetTypes: raw.assetTypes ?? [] }
    case 'annotate_assets':
      return {
        type: 'annotate_assets',
        assets: raw.assets ?? [],
        options: {
          roles: raw.options?.roles ?? [],
          scenes: raw.options?.scenes ?? [],
          segments: raw.options?.segments ?? [],
        },
      }
    case 'confirm_plan':
      return {
        type: 'confirm_plan',
        summary: raw.summary ?? '',
        estimatedCredits: raw.estimatedCredits ?? 0,
        estimatedMinutes: raw.estimatedMinutes ?? 0,
        items: (raw.items ?? []).map((item: any) => ({
          id: item.id ?? randomUUID(),
          label: item.label ?? '',
          description: item.description ?? '',
          selected: item.selected ?? true,
        })),
      }
    case 'autorun':
      return { type: 'autorun', message: raw.message ?? '' }
    case 'confirm_storyboard':
      return {
        type: 'confirm_storyboard',
        items: (raw.items ?? []).map((item: any) => ({
          id: item.id ?? randomUUID(),
          label: item.label ?? '',
          content: item.content ?? '',
        })),
      }
    case 'apply_workflow':
      if (!raw.workflow) return null
      return {
        type: 'apply_workflow',
        workflow: {
          strategy: raw.workflow.strategy ?? 'append',
          summary: raw.workflow.summary ?? '',
          reusedNodeIds: raw.workflow.reusedNodeIds ?? [],
          newNodes: raw.workflow.newNodes ?? [],
          newEdges: raw.workflow.newEdges ?? [],
          steps: (raw.workflow.steps ?? []).map(fillStepDefaults),
        },
      }
    case 'guide_step':
      if (!raw.step) return null
      return { type: 'guide_step', step: fillStepDefaults(raw.step) }
    case 'done':
      return { type: 'done' }
    default:
      return null
  }
}

function fillStepDefaults(s: any): AgentStep {
  return {
    stepIndex: s.stepIndex ?? 0,
    totalSteps: s.totalSteps ?? 1,
    label: s.label ?? '',
    nodeIds: s.nodeIds ?? [],
    needsRun: s.needsRun ?? true,
    instruction: s.instruction ?? '',
    nodeType: s.nodeType ?? 'mixed',
  }
}
