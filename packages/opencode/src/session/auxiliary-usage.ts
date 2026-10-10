import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import type { Provider } from "@/provider/provider"
import type { SessionID } from "./schema"
import { Session } from "./session"

/** Collect auxiliary text while recording each provider step independently of messages. */
export const text = <E, R>(
  input: { sessionID: SessionID; model: Provider.Model; purpose?: SessionV1.AuxiliaryUsage["purpose"] },
  stream: Stream.Stream<LLMEvent, E, R>,
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const requestID = SessionV1.AuxiliaryRequestID.create()
    const records = new Map<number, SessionV1.AuxiliaryUsage>()
    // The first observed provider index owns the initial pending row, even if it is not zero.
    const indices = new Map<number, number>()
    const pending = (step: number): SessionV1.AuxiliaryUsage => ({
      id: `${requestID}:${step}`,
      sessionID: input.sessionID,
      requestID,
      step,
      purpose: input.purpose ?? "title",
      providerID: input.model.providerID,
      modelID: input.model.id,
      status: "pending",
      time: { created: Date.now(), updated: Date.now() },
    })
    // Keep the durable write and local state together if cancellation arrives during persistence.
    const save = Effect.fnUntraced(function* (usage: SessionV1.AuxiliaryUsage) {
      yield* sessions.updateAuxiliaryUsage(usage)
      records.set(usage.step, usage)
    }, Effect.uninterruptible)
    return yield* Effect.acquireUseRelease(
      save(pending(0)),
      () =>
        stream.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (event.type !== "step-start" && event.type !== "step-finish") return
              const step = indices.get(event.index) ?? indices.size
              indices.set(event.index, step)
              const record = records.get(step) ?? pending(step)
              if (event.type === "step-start") {
                if (!records.has(step)) yield* save(record)
                return
              }
              // An empty Usage object is not proof of a free request.
              const reported = event.usage
              const complete =
                reported !== undefined &&
                Number.isFinite(reported.inputTokens) &&
                Number.isFinite(reported.outputTokens) &&
                (reported.inputTokens ?? -1) >= 0 &&
                (reported.outputTokens ?? -1) >= 0
              const billed = event.providerMetadata?.["copilot"]?.["totalNanoAiu"]
              const usage =
                reported || (typeof billed === "number" && Number.isFinite(billed) && billed >= 0)
                  ? Session.getUsage({
                      model: input.model,
                      usage: reported ?? new Usage({}),
                      metadata: event.providerMetadata,
                    })
                  : undefined
              yield* save({
                ...record,
                ...usage,
                status: complete ? "complete" : "unavailable",
                time: { ...record.time, updated: Date.now() },
              })
            }),
          ),
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
        ),
      () =>
        Effect.forEach(
          [...records.values()].filter((record) => record.status === "pending"),
          (record) => save({ ...record, status: "unavailable", time: { ...record.time, updated: Date.now() } }),
          { discard: true },
        ),
    )
  })

export * as SessionAuxiliaryUsage from "./auxiliary-usage"
