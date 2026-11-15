import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { contextUsage, WARN_PERCENT } from "../../src/util/context-usage"

// Only the fields contextUsage reads are real; the rest is cast away.
// IDs are zero-padded so they sort in the order the messages were sent, like real message IDs.
function assistant(id: number, tokens: Tokens) {
  return {
    id: `msg_${String(id).padStart(6, "0")}`,
    role: "assistant",
    tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: tokens.cache },
  } as AssistantMessage
}

function user(id: number) {
  return { id: `msg_${String(id).padStart(6, "0")}`, role: "user" } as Message
}

function total(tokens: Tokens) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

// A provider-reported usage for one reply. Output is at least 1 so the reply counts as a finished reply.
const tokens = fc.record({
  input: fc.integer({ min: 0, max: 400_000 }),
  output: fc.integer({ min: 1, max: 40_000 }),
  reasoning: fc.integer({ min: 0, max: 20_000 }),
  cache: fc.record({ read: fc.integer({ min: 0, max: 400_000 }), write: fc.integer({ min: 0, max: 40_000 }) }),
})

// Context windows from small local models up to 2M-token models.
const limit = fc.integer({ min: 1_000, max: 2_000_000 })

// A conversation: alternating user prompts and replies. Some replies have output 0
// (failed or aborted), which the meter must skip. IDs are assigned in send order.
const history = fc
  .array(fc.tuple(tokens, fc.boolean()), { maxLength: 12 })
  .map((turns) =>
    turns.flatMap(([usage, failed], index): Message[] => [
      user(index * 2),
      assistant(index * 2 + 1, failed ? { ...usage, output: 0 } : usage),
    ]),
  )

describe("context meter properties (P4B, malali)", () => {
  // R1: "When the latest reply's token count reaches 80% or more of the selected model's
  // context window, the meter turns yellow. Below 80% it uses the normal color."
  // Kind: invariant.
  // Generator: a random window, and a reply whose total is placed within a few tokens of the
  // 80% line (or anywhere in the window), so the boundary case 159,999 / 200,000 is hit often.
  test("R1: the meter warns exactly when usage is at or above 80% of the window", () => {
    const nearLine = limit.chain((window) =>
      fc.tuple(
        fc.constant(window),
        fc.oneof(
          fc
            .integer({ min: -3, max: 3 })
            .map((offset) => Math.max(1, Math.ceil((window * WARN_PERCENT) / 100) + offset)),
          fc.integer({ min: 1, max: window }),
        ),
      ),
    )
    fc.assert(
      fc.property(nearLine, ([window, used]) => {
        const result = contextUsage(
          [assistant(1, { input: used - 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })],
          window,
        )
        expect(result?.warn).toBe(used * 100 >= window * WARN_PERCENT)
        // The shown percentage agrees with the color: it never says 80% while the meter is not yellow.
        expect(result!.percent! >= WARN_PERCENT).toBe(result!.warn)
      }),
    )
    // Acceptance criteria from P4A.
    const at = (used: number) =>
      contextUsage([assistant(1, { input: used - 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })], 200_000)
    expect(at(160_000)).toMatchObject({ used: 160_000, percent: 80, warn: true })
    expect(at(159_999)?.warn).toBeFalse()
  })

  // R2: "Switching to another model and back without sending a message returns the meter to
  // exactly the value it showed before the switch."
  // Kind: round-trip.
  // Generator: any conversation and two different windows A and B; the meter is read on A,
  // then on B, then on A again, with the conversation unchanged.
  test("R2: switching to another model and back gives the same reading", () => {
    fc.assert(
      fc.property(history, limit, limit, (messages, a, b) => {
        const before = contextUsage(messages, a)
        contextUsage(messages, b)
        expect(contextUsage(messages, a)).toEqual(before)
      }),
    )
  })

  // R3: "Undoing the last message restores the meter to the value it showed before that message."
  // Kind: model/oracle. The oracle is the meter computed on the conversation as it was before the
  // message was sent; undo marks the user message as the revert point, like session.revert.messageID.
  // Generator: any conversation, plus one more user message and a reply with random usage.
  test("R3: undoing the last message restores the earlier reading", () => {
    fc.assert(
      fc.property(history, tokens, limit, (messages, reply, window) => {
        const prompt = user(messages.length)
        const sent = [...messages, prompt, assistant(messages.length + 1, reply)]
        expect(contextUsage(sent, window, prompt.id)).toEqual(contextUsage(messages, window))
      }),
    )
    // Acceptance criteria from P4A: 40,000 -> 41,200 -> undo -> 40,000.
    const start = [user(0), assistant(1, { input: 39_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } })]
    const sent = [
      ...start,
      user(2),
      assistant(3, { input: 40_200, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]
    expect(contextUsage(sent, 200_000)?.used).toBe(41_200)
    expect(contextUsage(sent, 200_000, sent[2].id)?.used).toBe(40_000)
  })

  // R4: "The same conversation gives the same token count whatever model is selected; only the
  // percentage changes, and it comes from the selected model's window."
  // Kind: metamorphic. Changing the window must not change the count, and a bigger window can
  // only give the same or a smaller percentage.
  // Generator: any conversation and two random windows.
  test("R4: changing the model's window changes the percentage, not the count", () => {
    fc.assert(
      fc.property(history, limit, limit, (messages, a, b) => {
        const small = contextUsage(messages, Math.min(a, b))
        const large = contextUsage(messages, Math.max(a, b))
        expect(large?.used).toBe(small?.used)
        if (!small || !large) return
        expect(large.percent!).toBeLessThanOrEqual(small.percent!)
        expect(small.percent).toBe(Math.floor((small.used * 100) / Math.min(a, b)))
      }),
    )
    // Acceptance criteria from P4A.
    const messages = [assistant(1, { input: 60_000, output: 4_000, reasoning: 0, cache: { read: 0, write: 0 } })]
    expect(contextUsage(messages, 128_000)).toMatchObject({ used: 64_000, total: 128_000, percent: 50 })
    expect(contextUsage(messages, 1_000_000)).toMatchObject({ used: 64_000, total: 1_000_000, percent: 6 })
  })

  // R5 (revised in P4B): "After compaction or truncation, the meter shows the new lower count from
  // the next reply, and the yellow warning goes away if that count is below 80%."
  // Kind: invariant. Whatever came before, the reading after compaction depends only on the
  // reply after compaction.
  // Generator: any conversation (often with high usage), followed by a reply with a lower total.
  test("R5: after compaction the meter follows the new lower count", () => {
    fc.assert(
      fc.property(history, tokens, limit, (messages, after, window) => {
        const result = contextUsage([...messages, user(messages.length), assistant(messages.length + 1, after)], window)
        expect(result?.used).toBe(total(after))
        expect(result?.warn).toBe(total(after) * 100 >= window * WARN_PERCENT)
      }),
    )
    // Acceptance criteria from P4A: 180,000 (90%, yellow), then compaction, then 30,000 (15%, normal).
    const before = [
      user(0),
      assistant(1, { input: 175_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]
    expect(contextUsage(before, 200_000)).toMatchObject({ percent: 90, warn: true })
    const after = [
      ...before,
      user(2),
      assistant(3, { input: 29_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]
    expect(contextUsage(after, 200_000)).toMatchObject({ used: 30_000, percent: 15, warn: false })
  })

  // R6 (revised in P4B): "Sending a message changes the meter by exactly the difference between
  // the provider-reported totals of the new reply and the previous reply. The meter never adds
  // its own amount on top (it does not sum replies)."
  // Kind: metamorphic. Adding one user message and one reply to the conversation moves the count
  // by the reply's reported total minus the previous reading.
  // Generator: any conversation with at least one finished reply, plus a new reply with random usage.
  test("R6: one message moves the meter by the provider-reported difference only", () => {
    fc.assert(
      fc.property(history, tokens, limit, (messages, reply, window) => {
        const before = contextUsage(messages, window)
        fc.pre(before !== undefined)
        const after = contextUsage([...messages, user(messages.length), assistant(messages.length + 1, reply)], window)
        expect(after!.used - before!.used).toBe(total(reply) - before!.used)
      }),
    )
    // Acceptance criteria from P4A: at 20,000, a short message whose reply adds about 300 stays under 21,000.
    const start = [user(0), assistant(1, { input: 19_500, output: 500, reasoning: 0, cache: { read: 0, write: 0 } })]
    const next = [
      ...start,
      user(2),
      assistant(3, { input: 19_800, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]
    expect(contextUsage(next, 200_000)?.used).toBe(20_300)
  })
})
