import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MockLanguageModelV3 } from "ai/test"
import { EditSummary } from "../../src/tool/edit-summary"
import { ProviderTest } from "../fake/provider"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const input = { sessionID: SessionID.create(), abort: AbortSignal.any([]) }
const noSession = Layer.mock(Session.Service, {})
const it = testEffect(Layer.empty)
const durable = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node])))

function language(
  stream: (
    options: LanguageModelV3CallOptions,
  ) => Promise<ReadableStream<LanguageModelV3StreamPart>> | ReadableStream<LanguageModelV3StreamPart>,
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "summary",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unexpected non-streaming request")
    },
    doStream: async (options) => ({ stream: await stream(options) }),
  }
}

const response: LanguageModelV3StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "summary" },
  { type: "text-delta", id: "summary", delta: "A useful summary." },
  { type: "text-end", id: "summary" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
  },
]

describe("EditSummary.summarizeFile model selection", () => {
  test("uses the session model instead of the configured default", async () => {
    const requested: string[] = []
    const session = ProviderTest.model({
      id: ModelV2.ID.make("session-model"),
      providerID: ProviderV2.ID.make("openrouter"),
    })
    const fake = ProviderTest.fake({
      getLanguage: (model) => {
        requested.push(`${model.providerID}/${model.id}`)
        return Effect.die(new Error("stop before any network call"))
      },
    })
    const provider = await Effect.runPromise(
      Effect.gen(function* () {
        const { Provider } = yield* Effect.promise(() => import("../../src/provider/provider"))
        return yield* Provider.Service
      }).pipe(Effect.provide(fake.layer)),
    )

    await Effect.runPromise(
      EditSummary.summarizeFile({ ...input, provider, model: session, path: "a.txt", content: "hello" }).pipe(
        Effect.provide(noSession),
        Effect.exit,
      ),
    )

    expect(requested).toEqual(["openrouter/session-model"])
  })

  test("falls back to the default model when no session model is given", async () => {
    const requested: string[] = []
    const fake = ProviderTest.fake({
      getLanguage: (model) => {
        requested.push(`${model.providerID}/${model.id}`)
        return Effect.die(new Error("stop before any network call"))
      },
    })
    const provider = await Effect.runPromise(
      Effect.gen(function* () {
        const { Provider } = yield* Effect.promise(() => import("../../src/provider/provider"))
        return yield* Provider.Service
      }).pipe(Effect.provide(fake.layer)),
    )

    await Effect.runPromise(
      EditSummary.summarizeFile({ ...input, provider, path: "a.txt", content: "hello" }).pipe(
        Effect.provide(noSession),
        Effect.exit,
      ),
    )

    expect(requested).toEqual([`${fake.model.providerID}/${fake.model.id}`])
  })
})

for (const cancel of ["timeout", "user"] as const) {
  it.effect(`aborts the actual provider stream on ${cancel} cancellation`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>()
      const records = new Map<string, SessionV1.AuxiliaryUsage>()
      const sessions = Layer.mock(Session.Service, {
        updateAuxiliaryUsage: (usage) =>
          Effect.sync(() => {
            records.set(usage.id, usage)
          }),
      })
      const fake = ProviderTest.fake({
        getLanguage: () =>
          Effect.succeed(
            language(
              (options) =>
                new ReadableStream({
                  start(controller) {
                    const signal = options.abortSignal!
                    Deferred.doneUnsafe(started, Effect.succeed(signal))
                    signal.addEventListener(
                      "abort",
                      () => controller.error(new DOMException("aborted", "AbortError")),
                      { once: true },
                    )
                  },
                }),
            ),
          ),
      })
      const provider = yield* Provider.Service.pipe(Effect.provide(fake.layer))
      const controller = new AbortController()
      const fiber = yield* EditSummary.summarizeFile({
        ...input,
        abort: controller.signal,
        provider,
        path: "a.txt",
        content: "hello",
      }).pipe(Effect.provide(sessions), Effect.forkChild)
      const signal = yield* Deferred.await(started)
      expect(signal.aborted).toBe(false)
      if (cancel === "timeout") yield* TestClock.adjust("10 seconds")
      else controller.abort()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && cancel === "user") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(signal.aborted).toBe(true)
      expect([...records.values()]).toMatchObject([{ purpose: "edit-summary", status: "unavailable" }])
    }),
  )
}

durable.instance("persists edit-summary usage before execution and reloads it without chat messages", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const model = ProviderTest.model({
      id: ModelV2.ID.make("selected-summary"),
      providerID: ProviderV2.ID.make("selected"),
      cost: { input: 2, output: 4, cache: { read: 0, write: 0 } },
    })
    const fake = ProviderTest.fake({
      model,
      getLanguage: () =>
        Effect.succeed(
          language(async () => {
            expect(await Effect.runPromise(sessions.auxiliaryUsage(chat.id))).toMatchObject([
              { status: "pending", purpose: "edit-summary" },
            ])
            return new ReadableStream({
              start(controller) {
                response.forEach((part) => controller.enqueue(part))
                controller.close()
              },
            })
          }),
        ),
    })
    const provider = yield* Provider.Service.pipe(Effect.provide(fake.layer))
    const summary = yield* EditSummary.summarizeFile({
      ...input,
      sessionID: chat.id,
      provider,
      model,
      path: "a.txt",
      content: "hello",
    })
    expect(summary).toBe("A useful summary.")
    const usage = yield* sessions.auxiliaryUsage(chat.id)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      purpose: "edit-summary",
      providerID: "selected",
      modelID: "selected-summary",
      status: "complete",
      cost: 0.0024,
    })
    expect(yield* sessions.auxiliaryUsage(chat.id)).toEqual(usage)
    expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
  }),
)

durable.instance("records Copilot's raw billed amount instead of token-based catalog pricing", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const model = ProviderTest.model({
      id: ModelV2.ID.make("copilot-summary"),
      providerID: ProviderV2.ID.make("github-copilot-enterprise"),
      cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    })
    const fake = ProviderTest.fake({
      model,
      getLanguage: () =>
        Effect.succeed(
          language(
            (options) =>
              new ReadableStream({
                start(controller) {
                  controller.enqueue(response[0]!)
                  // Providers only expose their billing payload when raw chunks are requested.
                  if (options.includeRawChunks)
                    controller.enqueue({ type: "raw", rawValue: { copilot_usage: { total_nano_aiu: 4_473_525_000 } } })
                  response.slice(1).forEach((part) => controller.enqueue(part))
                  controller.close()
                },
              }),
          ),
        ),
    })
    const provider = yield* Provider.Service.pipe(Effect.provide(fake.layer))
    // Exercise the resolved fallback model too, rather than assuming input.model exists.
    yield* EditSummary.summarizeFile({ ...input, sessionID: chat.id, provider, path: "a.txt", content: "hello" })
    const usage = yield* sessions.auxiliaryUsage(chat.id)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      purpose: "edit-summary",
      providerID: model.providerID,
      modelID: model.id,
      status: "complete",
      cost: 0.04473525,
    })
    expect(usage[0]?.cost).not.toBe(0.0011)
    expect(yield* sessions.auxiliaryUsage(chat.id)).toEqual(usage)
    expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
  }),
)

describe("EditSummary.summarizeFile timeout", () => {
  test("aborts the underlying provider stream when the timeout fires", async () => {
    let signal: AbortSignal | undefined
    const language = new MockLanguageModelV3({
      doStream: ((options: { abortSignal?: AbortSignal }) => {
        signal = options.abortSignal
        // Never resolves on its own — simulates a provider that is still
        // "in flight" when the Effect-level timeout elapses. A real HTTP
        // client rejects its pending request once its AbortSignal fires;
        // this does the same, so the test fails if the signal is never wired.
        return new Promise(() => {
          signal?.addEventListener("abort", () => {})
        })
      }) as never,
    })
    const fake = ProviderTest.fake({ getLanguage: () => Effect.succeed(language) })
    const provider = await Effect.runPromise(Provider.Service.pipe(Effect.provide(fake.layer)))

    const exit = await Effect.runPromise(
      EditSummary.summarizeFile({
        ...input,
        provider,
        path: "a.txt",
        content: "hello",
        timeout: "30 millis",
      }).pipe(Effect.provide(Layer.mock(Session.Service, { updateAuxiliaryUsage: () => Effect.void })), Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(true)
  })
})
