import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { contextUsage } from "../../src/util/context-usage"

// Only the fields contextUsage reads are real; the rest is cast away.
function assistant(input: number, output: number, cacheRead = 0) {
  return {
    role: "assistant",
    tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } },
  } as AssistantMessage
}

function user() {
  return { role: "user" } as Message
}

describe("util.contextUsage", () => {
  test("uses the last assistant message against the limit", () => {
    const result = contextUsage([assistant(40_000, 10_000)], 200_000)
    expect(result?.used).toBe(50_000)
    expect(result?.total).toBe(200_000)
    expect(result?.percent).toBe(25)
    expect(result?.warn).toBeFalse()
  })

  test("returns undefined for a session with no messages", () => {
    expect(contextUsage([], 200_000)).toBeUndefined()
  })

  test("returns undefined when only user messages exist", () => {
    expect(contextUsage([user()], 200_000)).toBeUndefined()
  })

  test("counts only the last assistant message, not a sum", () => {
    const result = contextUsage([assistant(10_000, 1_000), user(), assistant(30_000, 2_000)], 200_000)
    expect(result?.used).toBe(32_000)
  })

  test("falls back to the last known value when the latest response has no usage", () => {
    const result = contextUsage([assistant(30_000, 2_000), assistant(0, 0)], 200_000)
    expect(result?.used).toBe(32_000)
  })

  test("drops after compaction instead of continuing to climb", () => {
    const result = contextUsage([assistant(150_000, 5_000), assistant(20_000, 1_000)], 200_000)
    expect(result?.used).toBe(21_000)
    expect(result?.percent).toBe(11)
  })

  test("includes cached tokens in the total", () => {
    expect(contextUsage([assistant(1_000, 1_000, 8_000)], 200_000)?.used).toBe(10_000)
  })

  test("recomputes the percentage for a model with a different window", () => {
    const messages = [assistant(90_000, 10_000)]
    expect(contextUsage(messages, 200_000)?.percent).toBe(50)
    expect(contextUsage(messages, 1_000_000)?.percent).toBe(10)
  })

  test("warns at 80% and above", () => {
    expect(contextUsage([assistant(78_000, 1_000)], 100_000)?.warn).toBeFalse()
    expect(contextUsage([assistant(79_000, 1_000)], 100_000)?.warn).toBeTrue()
    expect(contextUsage([assistant(95_000, 1_000)], 100_000)?.warn).toBeTrue()
  })

  test("reports usage without a percentage when the model limit is unknown", () => {
    const result = contextUsage([assistant(40_000, 10_000)], undefined)
    expect(result?.used).toBe(50_000)
    expect(result?.total).toBeUndefined()
    expect(result?.percent).toBeUndefined()
    expect(result?.warn).toBeFalse()
  })
})