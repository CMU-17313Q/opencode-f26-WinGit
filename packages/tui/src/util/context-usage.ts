import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"

export const WARN_PERCENT = 80

// revertID is session.revert.messageID: after an undo, that message and everything after it
// no longer count, the same way the session view hides them.
export function contextUsage(messages: Message[], limit: number | undefined, revertID?: string) {
  const index = revertID ? messages.findIndex((item) => item.id === revertID) : -1
  const last = (index === -1 ? messages : messages.slice(0, index)).findLast(
    (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
  )
  if (!last) return

  const used =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  // Round down so the meter never shows 80% (or turns yellow) before usage really reaches 80%.
  const percent = limit ? Math.floor((used * 100) / limit) : undefined

  return {
    used,
    total: limit || undefined,
    percent,
    warn: percent !== undefined && percent >= WARN_PERCENT,
  }
}
