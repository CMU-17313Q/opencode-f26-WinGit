import { expect, test } from "bun:test"
import type { AssistantMessage, AuxiliaryUsage, Event, StepFinishPart } from "@opencode-ai/sdk/v2"
import fc from "fast-check"
import { createSessionCostLedger, formatCost } from "../../src/util/session-cost"

type Charge = {
  kind: "step" | "auxiliary"
  microDollars: number
  tokens: StepFinishPart["tokens"]
}

type UsageRecord = Charge & { id: number; modelID: string }

const sessionID = "session"

const tokens = fc.record({
  input: fc.nat(32_768),
  output: fc.nat(8_192),
  reasoning: fc.nat(2_048),
  cache: fc.record({ read: fc.nat(32_768), write: fc.nat(32_768) }),
})

const charge = fc.record({
  kind: fc.constantFrom("step" as const, "auxiliary" as const),
  microDollars: fc.integer({ min: 1, max: 1_000_000 }),
  tokens,
})

function eventsFor(record: UsageRecord): Event[] {
  const requestID = `request-${record.id}`
  const cost = record.microDollars / 1_000_000
  const usage = { sessionID, providerID: "paid", modelID: record.modelID, cost, tokens: record.tokens }
  if (record.kind === "auxiliary") {
    const auxiliary: AuxiliaryUsage = {
      ...usage,
      id: `${requestID}:0`,
      requestID,
      step: 0,
      purpose: "title",
      status: "complete",
      time: { created: 1, updated: 2 },
    }
    return [
      {
        id: `usage-${requestID}`,
        type: "session.auxiliary_usage.updated",
        properties: { sessionID, usage: auxiliary },
      },
    ]
  }
  const info: AssistantMessage = {
    ...usage,
    id: requestID,
    role: "assistant",
    agent: "build",
    mode: "build",
    parentID: "user",
    path: { cwd: "/tmp", root: "/tmp" },
    time: { created: 1, completed: 2 },
  }
  const part: StepFinishPart = {
    id: `part-${requestID}`,
    messageID: requestID,
    sessionID,
    type: "step-finish",
    reason: "stop",
    cost,
    tokens: record.tokens,
  }
  return [
    { id: `message-${requestID}`, type: "message.updated", properties: { sessionID, info } },
    { id: `step-${requestID}`, type: "message.part.updated", properties: { sessionID, time: 2, part } },
  ]
}

function displayedSummary(records: UsageRecord[]) {
  const ledger = createSessionCostLedger(sessionID)
  records.flatMap(eventsFor).forEach(ledger.apply)
  const summary = ledger.summarize([])
  return {
    total: formatCost(summary.total),
    models: summary.models.map((model) => ({ ...model, cost: formatCost(model.cost) })),
  }
}

// R6: Count a completed usage record once when its stable identity is replayed, and count distinct
// identities even when their recorded costs and token counts match.
// Kind: metamorphic. Generate both usage sources, varying costs and ordinary, cached, and reasoning tokens.
test("R6: replay is idempotent and distinct usage identities add independently", () => {
  fc.assert(
    fc.property(charge, (usage) => {
      const ledger = createSessionCostLedger(sessionID)
      const first = eventsFor({ ...usage, id: 0, modelID: "model-a" })
      first.forEach(ledger.apply)
      const cost = usage.microDollars / 1_000_000
      const row = {
        providerID: "paid",
        modelID: "model-a",
        input: usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write,
        output: usage.tokens.output + usage.tokens.reasoning,
        cost,
      }
      const single = ledger.summarize([])
      expect(single).toEqual({ total: cost, knownTotal: cost, models: [row] })

      first.forEach((event) => ledger.apply({ ...event, id: `replay-${event.id}` }))
      expect(ledger.summarize([])).toEqual(single)

      eventsFor({ ...usage, id: 1, modelID: "model-a" }).forEach(ledger.apply)
      expect(ledger.summarize([])).toEqual({
        total: 2 * cost,
        knownTotal: 2 * cost,
        models: [{ ...row, input: 2 * row.input, output: 2 * row.output, cost: 2 * cost }],
      })
    }),
  )
})

const mixedModelOrders = fc
  .array(charge, { minLength: 2, maxLength: 20 })
  .map((charges) => charges.map((usage, id) => ({ ...usage, id, modelID: id % 2 === 0 ? "model-a" : "model-b" })))
  .chain((original) =>
    fc.shuffledSubarray(original, { minLength: original.length, maxLength: original.length }).map((permuted) => ({
      original,
      permuted,
    })),
  )

function midpointOrder(first: number, second: number, total: number, tokens: StepFinishPart["tokens"]) {
  const charges = [first, second, total - first - second]
  const original = charges.map(
    (microDollars, id): UsageRecord => ({
      id,
      kind: "auxiliary",
      modelID: "model-a",
      microDollars,
      tokens,
    }),
  )
  return { original, permuted: original.toReversed() }
}

const midpointOrders = fc
  .record({
    first: fc.integer({ min: 1, max: 99 }),
    second: fc.integer({ min: 1, max: 99 }),
    increments: fc.integer({ min: 2, max: 30 }),
    tokens,
  })
  .map(({ first, second, increments, tokens }) => midpointOrder(first, second, 100 * increments + 50, tokens))

// R7: Produce the same final cost summary regardless of the arrival order of distinct completed records.
// Kind: metamorphic. Shuffle complete records across models and generate totals at four-decimal rounding
// boundaries, where arrival-order floating-point error can change the displayed amount.
test("R7: permuting completed usage preserves the displayed total and model breakdown", () => {
  fc.assert(
    fc.property(fc.oneof(mixedModelOrders, midpointOrders), ({ original, permuted }) => {
      expect(displayedSummary(permuted)).toEqual(displayedSummary(original))
    }),
  )

  // The shrunk pre-fix case displayed $0.0012 in one order and $0.0013 in the other.
  const regression = midpointOrder(59, 22, 1_250, {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })
  expect(displayedSummary(regression.permuted)).toEqual(displayedSummary(regression.original))
})
