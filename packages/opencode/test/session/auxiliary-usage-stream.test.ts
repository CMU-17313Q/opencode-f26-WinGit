import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionAuxiliaryUsage } from "@/session/auxiliary-usage"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const model: Provider.Model = {
  id: ModelV2.ID.make("title-model"),
  providerID: ProviderV2.ID.make("title-provider"),
  api: { id: "title-model", url: "http://localhost.invalid", npm: "@ai-sdk/anthropic" },
  name: "Title model",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: false,
    interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 2, output: 4, cache: { read: 0.2, write: 2.5 } },
  limit: { context: 100000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function recorder() {
  const records = new Map<string, SessionV1.AuxiliaryUsage>()
  const layer = Layer.mock(Session.Service, {
    updateAuxiliaryUsage: (usage) =>
      Effect.sync(() => {
        records.set(usage.id, usage)
      }),
  })
  const input = { sessionID: SessionID.create(), model }
  return {
    records,
    run: <E, R>(stream: Stream.Stream<LLMEvent, E, R>) =>
      SessionAuxiliaryUsage.text(input, stream).pipe(Effect.provide(layer)),
  }
}

it.effect("records each billed step once, attributes the actual model and ignores aggregate finish", () =>
  Effect.gen(function* () {
    const record = recorder()
    const finish = LLMEvent.stepFinish({ index: 5, reason: "stop", usage: { inputTokens: 1000, outputTokens: 100 } })
    const text = yield* record.run(
      Stream.fromArray([
        LLMEvent.stepStart({ index: 5 }),
        finish,
        finish,
        LLMEvent.stepStart({ index: 6 }),
        LLMEvent.stepFinish({ index: 6, reason: "stop", usage: { inputTokens: 100, outputTokens: 10 } }),
        LLMEvent.finish({ reason: "stop", usage: { inputTokens: 1100, outputTokens: 110 } }),
      ]),
    )
    expect(text).toBe("")
    expect([...record.records.values()]).toMatchObject([
      { step: 0, status: "complete", providerID: "title-provider", modelID: "title-model", cost: 0.0024 },
      { step: 1, status: "complete", cost: 0.00024 },
    ])
    yield* record.run(Stream.make(finish))
    expect(record.records.size).toBe(3)
  }),
)

it.effect("retains settled cost when the stream fails and marks only the unfinished step unavailable", () =>
  Effect.gen(function* () {
    const record = recorder()
    const exit = yield* record
      .run(
        Stream.fromArray([
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1000, outputTokens: 100 } }),
          LLMEvent.stepStart({ index: 1 }),
        ]).pipe(Stream.concat(Stream.fail("provider disconnected"))),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect([...record.records.values()]).toMatchObject([
      { status: "complete", cost: 0.0024 },
      { status: "unavailable" },
    ])
  }),
)

it.effect("cancellation finalizes a pending request as unavailable", () =>
  Effect.gen(function* () {
    const record = recorder()
    const ready = yield* Deferred.make<void>()
    const fiber = yield* record
      .run(Stream.fromEffect(Deferred.succeed(ready, undefined)).pipe(Stream.flatMap(() => Stream.never)))
      .pipe(Effect.forkChild)
    yield* Deferred.await(ready)
    yield* Fiber.interrupt(fiber)
    expect([...record.records.values()]).toMatchObject([{ status: "unavailable" }])
  }),
)

it.effect("distinguishes missing usage from reported zero and keeps metadata-only charges", () =>
  Effect.gen(function* () {
    const record = recorder()
    yield* record.run(Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop" })))
    yield* record.run(Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: {} })))
    yield* record.run(
      Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } })),
    )
    yield* record.run(
      Stream.make(
        LLMEvent.stepFinish({ index: 0, reason: "stop", providerMetadata: { copilot: { totalNanoAiu: 200000000 } } }),
      ),
    )
    const records = [...record.records.values()]
    expect(records.map((row) => row.status)).toEqual(["unavailable", "unavailable", "complete", "unavailable"])
    expect(records[0]?.cost).toBeUndefined()
    expect(records[2]?.cost).toBe(0)
    expect(records[3]?.cost).toBe(0.002)
  }),
)

it.effect("interruption during a completed-step write cannot overwrite its committed cost", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const records = new Map<string, SessionV1.AuxiliaryUsage>()
    const layer = Layer.mock(Session.Service, {
      updateAuxiliaryUsage: (usage) =>
        Effect.gen(function* () {
          if (usage.status === "complete") {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
          records.set(usage.id, usage)
        }),
    })
    const fiber = yield* SessionAuxiliaryUsage.text(
      { sessionID: SessionID.create(), model },
      Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1000, outputTokens: 100 } })),
    ).pipe(Effect.provide(layer), Effect.forkChild)
    yield* Deferred.await(started)
    const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(interrupted)
    expect([...records.values()]).toMatchObject([{ status: "complete", cost: 0.0024 }])
  }),
)

it.effect("normalizes cache usage and retains charges when saving the resulting title fails", () =>
  Effect.gen(function* () {
    const record = recorder()
    const exit = yield* record
      .run(
        Stream.make(
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 100 },
            providerMetadata: { anthropic: { cacheCreationInputTokens: 200 } },
          }),
        ),
      )
      .pipe(Effect.andThen(Effect.fail("title save failed")), Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect([...record.records.values()]).toMatchObject([
      { status: "complete", cost: 0.00232, tokens: { input: 700, output: 100, cache: { read: 100, write: 200 } } },
    ])
  }),
)
