export function formatToolRecord(value: Record<string, unknown> | undefined): string {
  if (!value || Object.keys(value).length === 0) return ""
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function shouldDeferGenericToolContent(deferContent: boolean | undefined, open: boolean | undefined): boolean {
  return deferContent === true && open !== true
}

export interface ParsedToolError {
  cleaned: string
  heading: string
  body: string
}

export function parseToolError(tool: string, error: string): ParsedToolError {
  const cleaned = error.replace(/^Error:\s*/, "").trim()
  const prefix = `${tool} `
  const tail = cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned
  const parts = tail.split(": ")
  const heading = parts.length > 1 ? (parts[0] ?? "").trim() : ""
  const body = parts.length > 1 ? parts.slice(1).join(": ").trim() || cleaned : cleaned
  return { cleaned, heading, body }
}
