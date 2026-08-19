const HIDDEN_TOOLS: Record<string, true> = { todowrite: true }

export function isContextGroupToolName(_tool: string): boolean {
  return false
}

export function isToolVisible(tool: string): boolean {
  return !Object.hasOwn(HIDDEN_TOOLS, tool)
}
