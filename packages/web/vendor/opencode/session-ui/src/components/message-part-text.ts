export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

export function visibleUserMessageText(
  parts: readonly { type: string; text?: string; synthetic?: boolean }[],
): string {
  return parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && part.text?.trim() ? [part.text] : []))
    .join("\n\n")
}

export function compactionDisplayText(summary: string, warning?: string): string {
  const body = summary.trim()
  const warningText = warning?.trim()
  return [body, warningText ? `> ${warningText}` : ""].filter(Boolean).join("\n\n")
}

export function isSnapcompactArchiveSource(source: { type?: unknown; clientName?: unknown } | undefined): boolean {
  return source?.type === "resource" && source.clientName === "omp-snapcompact"
}
