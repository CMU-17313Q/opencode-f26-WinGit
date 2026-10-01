import { describe, expect, test } from "bun:test"
import type { AssistantMessage, AuxiliaryUsage, Event, StepFinishPart } from "@opencode-ai/sdk/v2"
import { createSessionCostLedger, formatCost, type CostProvider } from "../../src/util/session-cost"

const providers: CostProvider[] = [
  { id: "paid", models: { model: { cost: { input: 2, output: 6, cache: { read: 0.5, write: 1 } } } } },
  { id: "free", models: { model: { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } } },
]

function assistant(id = "message", providerID = "paid"): AssistantMessage {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    providerID,
    modelID: "model",
    agent: "build",
    mode: "build",
    parentID: "user",
    path: { cwd: "/tmp", root: "/tmp" },
    time: { created: 1, completed: 2 },
    cost: 0.01,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 15 } },
  }
}

function step(id = "part", messageID = "message", cost = 0.001): StepFinishPart {
  return {
    id,
    messageID,
    sessionID: "session",
    type: "step-finish",
    reason: "stop",
    cost,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 15 } },
  }
}

function update(part: StepFinishPart): Event {
  return { id: "event", type: "message.part.updated", properties: { sessionID: "session", time: 2, part } }
}

function title(overrides: Partial<AuxiliaryUsage> = {}): AuxiliaryUsage {
  return {
    id: "aux_title:0",
    requestID: "aux_title",
    sessionID: "session",
    step: 0,
    purpose: "title",
    providerID: "paid",
    modelID: "small",
    status: "complete",
    cost: 0.0002,
    tokens: { input: 40, output: 5, reasoning: 2, cache: { read: 10, write: 0 } },
    time: { created: 1, updated: 2 },
    ...overrides,
  }
}

describe("session cost accounting", () => {
  test("includes title usage under its actual model without needing a visible message", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [step()] }], [title()])
    const summary = ledger.summarize(providers)
    expect(summary.models).toEqual([
      { providerID: "paid", modelID: "model", input: 125, output: 25, cost: 0.001 },
      { providerID: "paid", modelID: "small", input: 50, output: 7, cost: 0.0002 },
    ])
    expect(summary.total).toBeCloseTo(0.0012)
  })

  test("replaces repeated title events, keeps separate steps, and ignores other sessions", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([], [title({ status: "pending", cost: undefined, tokens: undefined })])
    expect(ledger.summarize(providers).total).toBeUndefined()
    const event: Event = {
      id: "title-event",
      type: "session.auxiliary_usage.updated",
      properties: { sessionID: "session", usage: title() },
    }
    ledger.apply(event)
    ledger.apply(event)
    expect(ledger.summarize(providers).total).toBe(0.0002)
    ledger.apply({ ...event, properties: { sessionID: "session", usage: title({ id: "aux_title:1", step: 1 }) } })
    expect(ledger.summarize(providers).total).toBe(0.0004)
    expect(
      ledger.apply({ ...event, properties: { sessionID: "other", usage: title({ sessionID: "other" }) } }),
    ).toBeFalse()
    expect(ledger.summarize(providers).total).toBe(0.0004)
  })

  test("incomplete title usage makes the total unavailable while retaining known charges", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate(
      [{ info: assistant(), parts: [step()] }],
      [title({ status: "unavailable", cost: undefined, tokens: undefined })],
    )
    expect(ledger.summarize(providers)).toMatchObject({ total: undefined, knownTotal: 0.001 })
    ledger.hydrate([], [title({ status: "unavailable" })])
    expect(ledger.summarize(providers)).toMatchObject({ total: undefined, knownTotal: 0.0002 })
  })

  test("a pending event cannot overwrite a newer completed title snapshot", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([], [title()])
    ledger.apply({
      id: "old-pending",
      type: "session.auxiliary_usage.updated",
      properties: {
        sessionID: "session",
        usage: title({ status: "pending", cost: undefined, tokens: undefined }),
      },
    })
    ledger.apply({
      id: "old-unavailable",
      type: "session.auxiliary_usage.updated",
      properties: {
        sessionID: "session",
        usage: title({ status: "unavailable", cost: undefined, tokens: undefined, time: { created: 1, updated: 1 } }),
      },
    })
    expect(ledger.summarize(providers).total).toBe(0.0002)
  })

  test("title charges survive conversation removal and rehydrate only for their own session", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [step()] }], [title()])
    ledger.apply({ id: "delete", type: "message.removed", properties: { sessionID: "session", messageID: "message" } })
    expect(ledger.summarize(providers).total).toBe(0.0002)
    const fork = createSessionCostLedger("fork")
    fork.hydrate([], [title()])
    expect(fork.summarize(providers).total).toBe(0)
  })

  test("counts each billable step including cache and reasoning, not only the last message tokens", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [step("a"), step("b", "message", 0.002)] }])
    expect(ledger.summarize(providers)).toEqual({
      models: [{ providerID: "paid", modelID: "model", input: 250, output: 50, cost: 0.003 }],
      total: 0.003,
      knownTotal: 0.003,
    })
  })

  test("preserves recorded prices rather than repricing old turns with today's rates", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [step("a", "message", 1.25)] }])
    expect(ledger.summarize([]).total).toBe(1.25)
    expect(ledger.summarize(providers).total).toBe(1.25)
  })

  test("retains a known subtotal when one model has both paid and unpriced historical steps", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [step("known", "message", 0.25), step("unknown", "message", 0)] }])
    expect(ledger.summarize([])).toMatchObject({ total: undefined, knownTotal: 0.25 })
  })

  test("groups by both provider and model, and marks a mixed unknown total n/a", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([
      { info: assistant("paid", "paid"), parts: [step("p", "paid")] },
      { info: assistant("free", "free"), parts: [step("f", "free", 0)] },
      { info: assistant("missing", "missing"), parts: [step("m", "missing", 0)] },
    ])
    const summary = ledger.summarize(providers)
    expect(summary.models).toHaveLength(3)
    expect(summary.models.find((item) => item.providerID === "free")?.cost).toBeUndefined()
    expect(summary.models.find((item) => item.providerID === "missing")?.cost).toBeUndefined()
    expect(summary.total).toBeUndefined()
    expect(summary.knownTotal).toBe(0.001)
  })

  test("repeated events replace a contribution and removed steps do not fall back to stale message cost", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [step()] }])
    ledger.apply(update(step()))
    ledger.apply(update(step("part", "message", 0.5)))
    expect(ledger.summarize(providers).total).toBe(0.5)
    ledger.apply({
      id: "remove",
      type: "message.part.removed",
      properties: { sessionID: "session", messageID: "message", partID: "part" },
    })
    expect(ledger.summarize(providers).total).toBe(0)
  })

  test("complete history keeps usage across compaction and beyond the visible 100 messages", () => {
    const ledger = createSessionCostLedger("session")
    const history = Array.from({ length: 120 }, (_, index) => ({
      info: assistant(`message${index}`),
      parts: [step(`part${index}`, `message${index}`, 1)],
    }))
    ledger.hydrate([
      ...history,
      { info: { ...assistant("summary"), summary: true, mode: "compaction" }, parts: [step("summary", "summary", 2)] },
    ])
    expect(ledger.summarize(providers).total).toBe(122)
    ledger.apply(update(step("after", "after", 3)))
    ledger.apply({
      id: "message",
      type: "message.updated",
      properties: { sessionID: "session", info: assistant("after") },
    })
    expect(ledger.summarize(providers).total).toBe(125)
    ledger.apply({ id: "remove", type: "message.removed", properties: { sessionID: "session", messageID: "after" } })
    expect(ledger.summarize(providers).total).toBe(122)
  })

  test("supports legacy messages without step records and ignores other sessions", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [] }])
    expect(ledger.summarize(providers).models[0]).toMatchObject({ input: 125, output: 25, cost: 0.01 })
    expect(ledger.apply(update({ ...step(), sessionID: "other" }))).toBeFalse()
    expect(ledger.summarize(providers).total).toBe(0.01)
  })

  test("a known paid rate permits zero cost, but free/local zero rates remain unavailable", () => {
    const ledger = createSessionCostLedger("session")
    ledger.hydrate([{ info: assistant(), parts: [step("p", "message", 0)] }])
    expect(ledger.summarize(providers).total).toBe(0)
    expect(ledger.summarize([]).total).toBeUndefined()
  })

  test("formats small dollar amounts and unavailable estimates", () => {
    expect(formatCost(undefined)).toBe("n/a")
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(0.0012)).toBe("$0.0012")
    expect(formatCost(0.00001)).toBe("<$0.0001")
    expect(formatCost(Number.NaN)).toBe("n/a")
  })
})
