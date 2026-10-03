import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MockLanguageModelV3 } from "ai/test"
import { EditSummary } from "../../src/tool/edit-summary"
import { ProviderTest } from "../fake/provider"

async function providerFromFake(fake: ReturnType<typeof ProviderTest.fake>) {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const { Provider } = yield* Effect.promise(() => import("../../src/provider/provider"))
      return yield* Provider.Service
    }).pipe(Effect.provide(fake.layer)),
  )
}

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
    const provider = await providerFromFake(fake)

    await Effect.runPromise(
      EditSummary.summarizeFile({ provider, model: session, path: "a.txt", content: "hello" }).pipe(Effect.exit),
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
    const provider = await providerFromFake(fake)

    await Effect.runPromise(EditSummary.summarizeFile({ provider, path: "a.txt", content: "hello" }).pipe(Effect.exit))

    expect(requested).toEqual([`${fake.model.providerID}/${fake.model.id}`])
  })
})

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
    const provider = await providerFromFake(fake)

    const exit = await Effect.runPromise(
      EditSummary.summarizeFile({
        provider,
        path: "a.txt",
        content: "hello",
        timeout: "30 millis",
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(true)
  })
})
