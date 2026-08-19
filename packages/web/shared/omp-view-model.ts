export interface OmpUserMessage {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string }
}

export interface OmpAssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  parentID: string
  modelID: string
  providerID: string
  mode: string
  path: { cwd: string; root: string }
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  finish: string
  error?: { name: string; data: { message: string } }
}

export type OmpMessage = OmpUserMessage | OmpAssistantMessage

interface OmpBasePart {
  id: string
  sessionID: string
  messageID: string
}

export interface OmpTextPart extends OmpBasePart {
  type: "text"
  text: string
  time?: { start: number; end?: number }
}

export interface OmpReasoningPart extends OmpBasePart {
  type: "reasoning"
  text: string
  time?: { start: number; end?: number }
}

export interface OmpFilePart extends OmpBasePart {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export interface OmpCompactionPart extends OmpBasePart {
  type: "compaction"
  auto: boolean
  summary: string
  warning?: string
  tokensBefore?: number
}

export type OmpToolState =
  | { status: "running"; input: Record<string, unknown>; time: { start: number } }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata: Record<string, unknown>
      time: { start: number; end: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number }
    }

export interface OmpToolPart extends OmpBasePart {
  type: "tool"
  callID: string
  tool: string
  state: OmpToolState
}

export type OmpPart = OmpTextPart | OmpReasoningPart | OmpFilePart | OmpToolPart | OmpCompactionPart

export interface OmpPty {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
}

export const OMP_THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number]

export const OMP_APPROVAL_MODES = ["always-ask", "write", "yolo"] as const
export type OmpApprovalMode = (typeof OMP_APPROVAL_MODES)[number]

export interface OmpComposerRuntime {
  thinking: {
    current: OmpThinkingLevel
    options: OmpThinkingLevel[]
  }
  advisorEnabled: boolean
  approvalMode: OmpApprovalMode
}

export type OmpJsonValue = null | boolean | number | string | OmpJsonValue[] | { [key: string]: OmpJsonValue }

export function toOmpJsonValue(value: unknown): OmpJsonValue {
  const seen = new WeakSet<object>()
  const visit = (input: unknown, depth: number): OmpJsonValue => {
    if (input === null) return null
    if (typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number") return Number.isFinite(input) ? input : null
    if (typeof input === "bigint") return input.toString()
    if (depth >= 32) return "[truncated]"
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1))
    if (typeof input !== "object") return null
    if (seen.has(input)) return "[circular]"
    seen.add(input)
    if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.toISOString() : null
    const output: { [key: string]: OmpJsonValue } = {}
    try {
      for (const [key, item] of Object.entries(input)) {
        if (item !== undefined) output[key] = visit(item, depth + 1)
      }
    } catch {
      return "[unserializable]"
    }
    return output
  }
  return visit(value, 0)
}

export type OmpSessionRuntime = "active" | "parked" | "resuming"
export type OmpConfiguredThinkingLevel = "inherit" | OmpThinkingLevel

export interface OmpSessionModelRef {
  provider: string
  id: string
}

export interface OmpSessionStateView {
  runtime: OmpSessionRuntime
  sessionID: string
  sessionPath?: string
  sessionName?: string
  model?: OmpSessionModelRef
  thinkingLevel?: OmpThinkingLevel
  configuredThinkingLevel?: OmpConfiguredThinkingLevel
  isStreaming: boolean
  isBashRunning?: boolean
  isEvalRunning?: boolean
  isCompacting: boolean
  steeringMode?: "all" | "one-at-a-time"
  followUpMode?: "all" | "one-at-a-time"
  interruptMode?: "immediate" | "wait"
  autoCompactionEnabled?: boolean
  fastModeEnabled?: boolean
  fastModeActive?: boolean
  tokensPerSecond?: number | null
  messageCount?: number
  queuedMessageCount?: number
  lsp?: OmpJsonValue
  activity?: OmpJsonValue
  planMode?: OmpJsonValue
  goalMode?: OmpJsonValue
  vibeMode?: OmpJsonValue
  contextUsage?: OmpJsonValue
  tools: Array<{ name: string; description: string }>
  todos: OmpTodoView[]
}

export interface OmpLoginProviderView {
  id: string
  name: string
  available: boolean
  authenticated: boolean
}

export interface OmpSessionSnapshotView {
  state: OmpSessionStateView
  subagents: OmpJsonValue[]
  jobs: OmpJsonValue | null
  loginProviders: OmpLoginProviderView[]
}

export interface OmpSessionReference {
  id: string
  parentID?: string
  sessionPath?: string
  title: string
}

export interface OmpBranchResultView {
  text: string
  cancelled: boolean
  session: OmpSessionReference
}

export interface OmpTodoView {
  id: string
  content: string
  status: string
  priority: "medium"
}
