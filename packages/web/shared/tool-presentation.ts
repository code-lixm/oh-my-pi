function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function xdDeviceName(tool: string, input: unknown): string | undefined {
  if (tool !== "read" && tool !== "write") return undefined

  const path = text(record(input).path)
  if (!path) return undefined

  const normalizedPath = path.trim()
  if (!normalizedPath.toLowerCase().startsWith("xd://")) return undefined

  const name = normalizedPath.slice("xd://".length)
  if (!name || /[/?#]/.test(name)) return undefined
  return name
}

export function isXdToolTransport(tool: string, input: unknown): boolean {
  return xdDeviceName(tool, input) !== undefined
}

export function presentationToolName(tool: string, input: unknown): string {
  return xdDeviceName(tool, input) ?? tool
}

function diffCounts(patch: string | undefined): { additions: number; deletions: number } {
  if (!patch) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

function editPathFromInput(input: Record<string, unknown>): string | undefined {
  const direct = text(input.filePath) ?? text(input.path) ?? text(input.file_path)
  if (direct) return direct
  const source = text(input.input) ?? text(input._input)
  if (!source) return undefined
  return source.match(/^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/m)?.[1]
}

function editFileType(value: Record<string, unknown>): "add" | "update" | "delete" | "move" {
  const type = text(value.type) ?? text(value.op) ?? text(value.status)
  if (type === "add" || type === "added" || type === "create") return "add"
  if (type === "delete" || type === "deleted") return "delete"
  if (type === "move" || text(value.move) || text(value.movePath) || text(value.sourcePath)) return "move"
  return "update"
}

function normalizeEditFile(value: unknown, fallbackPath?: string): Record<string, unknown> | undefined {
  const file = record(value)
  const filePath = text(file.filePath) ?? text(file.path) ?? text(file.file) ?? fallbackPath
  if (!filePath) return undefined
  const relativePath = text(file.relativePath) ?? text(file.file) ?? filePath
  const patch = text(file.patch) ?? text(file.diff)
  const before = text(file.before) ?? text(file.oldText)
  const after = text(file.after) ?? text(file.newText)
  if (!patch && before === undefined && after === undefined) return undefined
  const counts = diffCounts(patch)
  return {
    filePath,
    relativePath,
    type: editFileType(file),
    patch,
    before,
    after,
    additions: typeof file.additions === "number" ? file.additions : counts.additions,
    deletions: typeof file.deletions === "number" ? file.deletions : counts.deletions,
    movePath: text(file.movePath) ?? text(file.move),
  }
}

export function normalizeToolInput(name: string, value: unknown): Record<string, unknown> {
  const input = record(value)
  if (!["read", "edit", "write"].includes(name) || typeof input.filePath === "string") return input
  const filePath = name === "edit" ? editPathFromInput(input) : text(input.path)
  return filePath ? { ...input, filePath } : input
}

export function normalizeToolMetadata(
  name: string,
  value: unknown,
  inputValue: unknown = {},
): Record<string, unknown> {
  const metadata = record(value)
  if (name !== "edit") return metadata

  const input = normalizeToolInput(name, inputValue)
  const inputPath = editPathFromInput(input)
  const direct = normalizeEditFile(metadata, inputPath)
  const perFile = Array.isArray(metadata.perFileResults)
    ? metadata.perFileResults.flatMap((item) => {
        const file = normalizeEditFile(item)
        return file ? [file] : []
      })
    : []
  const legacy = Array.isArray(metadata.files)
    ? metadata.files.flatMap((item) => {
        const file = normalizeEditFile(item, inputPath)
        return file ? [file] : []
      })
    : []
  const files = perFile.length ? perFile : legacy.length ? legacy : direct ? [direct] : []
  if (!files.length) return metadata

  const normalized = { ...metadata, files }
  if (metadata.filediff || files.length !== 1) return normalized
  const file = files[0]!
  return {
    ...normalized,
    filediff: {
      file: file.relativePath,
      patch: file.patch,
      before: file.before,
      after: file.after,
      additions: file.additions,
      deletions: file.deletions,
    },
  }
}
