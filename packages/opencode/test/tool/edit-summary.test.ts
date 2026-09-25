import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EditSummary } from "../../src/tool/edit-summary"
import { ProviderTest } from "../fake/provider"

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
    const provider = await Effect.runPromise(
      Effect.gen(function* () {
        const { Provider } = yield* Effect.promise(() => import("../../src/provider/provider"))
        return yield* Provider.Service
      }).pipe(Effect.provide(fake.layer)),
    )

    await Effect.runPromise(EditSummary.summarizeFile({ provider, path: "a.txt", content: "hello" }).pipe(Effect.exit))

    expect(requested).toEqual([`${fake.model.providerID}/${fake.model.id}`])
  })
})
