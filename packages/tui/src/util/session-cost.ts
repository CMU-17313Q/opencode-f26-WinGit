import type { AssistantMessage, Event, Message, Part, Provider, StepFinishPart } from "@opencode-ai/sdk/v2"

export type SessionCostSummary = {
  models: {
    providerID: string
    modelID: string
    input: number
    output: number
    cost: number | undefined
  }[]
  total: number | undefined
  knownTotal?: number
}

export type CostProvider = {
  id: string
  models: Record<string, Pick<Provider["models"][string], "cost">>
}

export type CostHistory = { info: Message; parts: Part[] }[]

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

export function formatCost(cost: number | undefined) {
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return "n/a"
  if (cost > 0 && cost < 0.0001) return "<$0.0001"
  return money.format(cost)
}

const count = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0)

function priced(providerID: string, modelID: string, providers: readonly CostProvider[]) {
  const cost = providers.find((provider) => provider.id === providerID)?.models[modelID]?.cost
  if (!cost) return false
  return [cost, ...(cost.tiers ?? []), cost.experimentalOver200K].some(
    (rate) => rate && [rate.input, rate.output, rate.cache.read, rate.cache.write].some((value) => count(value) > 0),
  )
}

/** Retain accounting records independently of the TUI's 100-message display window. */
export function createSessionCostLedger(sessionID: string) {
  const messages = new Map<string, { info?: AssistantMessage; steps: Map<string, StepFinishPart>; hadSteps: boolean }>()

  function entry(messageID: string) {
    const existing = messages.get(messageID)
    if (existing) return existing
    const value = {
      info: undefined as AssistantMessage | undefined,
      steps: new Map<string, StepFinishPart>(),
      hadSteps: false,
    }
    messages.set(messageID, value)
    return value
  }

  function message(info: Message) {
    if (info.sessionID !== sessionID || info.role !== "assistant") return false
    entry(info.id).info = info
    return true
  }

  function part(value: Part) {
    if (value.sessionID !== sessionID || value.type !== "step-finish") return false
    const target = entry(value.messageID)
    target.steps.set(value.id, value)
    target.hadSteps = true
    return true
  }

  function apply(event: Event) {
    switch (event.type) {
      case "message.updated":
        return message(event.properties.info)
      case "message.part.updated":
        return part(event.properties.part)
      case "message.removed":
        if (event.properties.sessionID !== sessionID) return false
        messages.delete(event.properties.messageID)
        return true
      case "message.part.removed":
        if (event.properties.sessionID !== sessionID) return false
        messages.get(event.properties.messageID)?.steps.delete(event.properties.partID)
        return true
      default:
        return false
    }
  }

  function hydrate(history: CostHistory) {
    messages.clear()
    for (const item of history) {
      message(item.info)
      for (const value of item.parts) part(value)
    }
  }

  function summarize(providers: readonly CostProvider[]): SessionCostSummary {
    const models = new Map<string, SessionCostSummary["models"][number]>()
    let knownTotal = 0
    for (const item of messages.values()) {
      if (!item.info) continue
      const info = item.info
      const key = JSON.stringify([info.providerID, info.modelID])
      const existing = models.get(key)
      const model = existing ?? { providerID: info.providerID, modelID: info.modelID, input: 0, output: 0, cost: 0 }
      // Old persisted messages may have no step records. Once step records exist,
      // their removal must not resurrect the assistant's stale aggregate.
      const records = item.hadSteps ? [...item.steps.values()] : [info]
      if (records.length === 0) continue
      for (const record of records) {
        model.input += count(record.tokens.input) + count(record.tokens.cache.read) + count(record.tokens.cache.write)
        model.output += count(record.tokens.output) + count(record.tokens.reasoning)
        // The legacy provider API folds absent prices into zero. A paid recorded
        // charge remains valid even if a model disappears from the catalog; zero
        // with all-zero/missing rates is conservatively n/a (including free/local).
        const available =
          Number.isFinite(record.cost) &&
          record.cost >= 0 &&
          (record.cost > 0 || priced(info.providerID, info.modelID, providers))
        if (available) knownTotal += record.cost
        model.cost = model.cost !== undefined && available ? model.cost + record.cost : undefined
      }
      models.set(key, model)
    }
    const rows = [...models.values()].sort(
      (a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID),
    )
    return { models: rows, total: rows.some((model) => model.cost === undefined) ? undefined : knownTotal, knownTotal }
  }

  return { apply, hydrate, summarize }
}
