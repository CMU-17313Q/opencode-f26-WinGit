import type { Part } from "@opencode-ai/sdk/v2"

const FILE_TOOLS = new Set(["read", "edit", "write"])
const CHARS_PER_TOKEN = 4

export type ContextFile = {
  path: string
  tokens: number
}

export function contextFiles(parts: readonly Part[]): ContextFile[] {
  const files = new Map<string, number>()

  for (const part of parts) {
    if (part.type !== "tool") continue
    if (!FILE_TOOLS.has(part.tool)) continue
    if (part.state.status !== "completed") continue

    const path = part.state.input?.["filePath"]
    if (typeof path !== "string" || path.length === 0) continue

    files.set(path, Math.ceil((part.state.output?.length ?? 0) / CHARS_PER_TOKEN))
  }

  return Array.from(files, ([path, tokens]) => ({ path, tokens }))
}
