import { isToolVisible } from "./tool-visibility"

export interface RenderablePartLike {
  type: string
  text?: string
  tool?: string
  state?: { status?: string }
}

const DEFAULT_RENDERED_PARTS = new Set(["file", "compaction"])

export function isPartRenderable(
  part: RenderablePartLike,
  showReasoningSummaries = true,
  hasRenderer: (type: string) => boolean = (type) => DEFAULT_RENDERED_PARTS.has(type),
): boolean {
  if (part.type === "tool") {
    if (!part.tool || !isToolVisible(part.tool)) return false
    if (part.tool === "question") return part.state?.status !== "pending" && part.state?.status !== "running"
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return hasRenderer(part.type)
}
