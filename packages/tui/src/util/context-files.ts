import type { CompactionPart, Message, Part } from "@opencode-ai/sdk/v2"

const FILE_TOOLS = new Set(["read", "edit", "write"])
const CHARS_PER_TOKEN = 4

export type ContextFile = {
  path: string
  tokens: number
}

export type MessageWithParts = {
  info: Message
  parts: readonly Part[]
}

function afterCompaction(messages: readonly MessageWithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const compaction = messages[index].parts.find((part): part is CompactionPart => part.type === "compaction")
    if (!compaction) continue

    const summarized = messages.some(
      (msg) =>
        msg.info.role === "assistant" &&
        msg.info.summary &&
        msg.info.finish &&
        !msg.info.error &&
        msg.info.parentID === messages[index].info.id,
    )
    if (!summarized) continue

    const tail = compaction.tail_start_id ? messages.findIndex((msg) => msg.info.id === compaction.tail_start_id) : -1
    return messages.slice(tail >= 0 && tail < index ? tail : index)
  }
  return messages
}

export function contextFiles(messages: readonly MessageWithParts[]): ContextFile[] {
  const files = new Map<string, number>()

  for (const message of afterCompaction(messages)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (!FILE_TOOLS.has(part.tool)) continue
      if (part.state.status !== "completed") continue

      const path = part.state.input?.["filePath"]
      if (typeof path !== "string" || path.length === 0) continue

      files.set(path, Math.ceil((part.state.output?.length ?? 0) / CHARS_PER_TOKEN))
    }
  }

  return Array.from(files, ([path, tokens]) => ({ path, tokens }))
}
