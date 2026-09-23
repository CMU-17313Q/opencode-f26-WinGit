import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"

export const WARN_PERCENT = 80

export function contextUsage(messages: Message[], limit: number | undefined) {
  const last = messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
  if (!last) return

  const used =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  const percent = limit ? Math.round((used / limit) * 100) : undefined

  return {
    used,
    total: limit || undefined,
    percent,
    warn: percent !== undefined && percent >= WARN_PERCENT,
  }
}
