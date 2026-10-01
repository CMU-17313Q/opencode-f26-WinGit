import type {
  AssistantMessage,
  AuxiliaryUsage,
  Event,
  Message,
  Part,
  Provider,
  StepFinishPart,
} from "@opencode-ai/sdk/v2"

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
export type CostSnapshot = { history: CostHistory; auxiliary: AuxiliaryUsage[] }

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
  const auxiliary = new Map<string, AuxiliaryUsage>()

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
      case "session.auxiliary_usage.updated":
        return usage(event.properties.usage)
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

  function usage(value: AuxiliaryUsage) {
    if (value.sessionID !== sessionID) return false
    const existing = auxiliary.get(value.id)
    if (existing && existing.time.updated > value.time.updated) return false
    if (existing && existing.status !== "pending" && value.status === "pending") return false
    auxiliary.set(value.id, value)
    return true
  }

  function hydrate(history: CostHistory, records: AuxiliaryUsage[] = []) {
    messages.clear()
    auxiliary.clear()
    for (const item of history) {
      message(item.info)
      for (const value of item.parts) part(value)
    }
    for (const record of records) usage(record)
  }

  function summarize(providers: readonly CostProvider[]): SessionCostSummary {
    const models = new Map<string, SessionCostSummary["models"][number]>()
    let knownTotal = 0
    function add(
      providerID: string,
      modelID: string,
      record: { cost?: number; tokens?: StepFinishPart["tokens"]; status?: AuxiliaryUsage["status"] },
    ) {
      const key = JSON.stringify([providerID, modelID])
      const model = models.get(key) ?? { providerID, modelID, input: 0, output: 0, cost: 0 }
      if (record.tokens) {
        model.input += count(record.tokens.input) + count(record.tokens.cache.read) + count(record.tokens.cache.write)
        model.output += count(record.tokens.output) + count(record.tokens.reasoning)
      }
      // Keep recorded charges even if catalog prices change or disappear. Missing
      // auxiliary usage must never make a partial amount look like a complete bill.
      const cost = record.cost
      const known =
        cost !== undefined && Number.isFinite(cost) && cost >= 0 && (cost > 0 || priced(providerID, modelID, providers))
      if (known) knownTotal += cost
      const complete = record.tokens !== undefined && (record.status === undefined || record.status === "complete")
      model.cost = model.cost !== undefined && known && complete ? model.cost + cost : undefined
      models.set(key, model)
    }
    for (const item of messages.values()) {
      if (!item.info) continue
      const info = item.info
      // Old persisted messages may have no step records. Once step records exist,
      // their removal must not resurrect the assistant's stale aggregate.
      const records = item.hadSteps ? [...item.steps.values()] : [info]
      for (const record of records) add(info.providerID, info.modelID, record)
    }
    for (const record of auxiliary.values()) add(record.providerID, record.modelID, record)
    const rows = [...models.values()].sort(
      (a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID),
    )
    return { models: rows, total: rows.some((model) => model.cost === undefined) ? undefined : knownTotal, knownTotal }
  }

  return { apply, hydrate, summarize }
}
