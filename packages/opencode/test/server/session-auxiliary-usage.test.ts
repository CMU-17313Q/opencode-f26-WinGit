import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Session.node), httpApiLayer))

afterEach(disposeAllInstances)

it.instance("returns saved auxiliary usage without adding conversation messages", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* TestInstance
    const chat = yield* Effect.acquireRelease(sessions.create({}), (value) => sessions.remove(value.id).pipe(Effect.orDie))
    const url = `/session/${chat.id}/auxiliary_usage`
    const empty = yield* requestInDirectory(url, instance.directory)
    expect(empty.status).toBe(200)
    expect(yield* empty.json).toEqual([])

    const requestID = SessionV1.AuxiliaryRequestID.create()
    const usage: SessionV1.AuxiliaryUsage = {
      id: `${requestID}:0`,
      requestID,
      sessionID: chat.id,
      step: 0,
      purpose: "title",
      providerID: ProviderV2.ID.make("fixture"),
      modelID: ModelV2.ID.make("title-model"),
      status: "complete",
      cost: 0.0002,
      tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }
    yield* sessions.updateAuxiliaryUsage(usage)
    const response = yield* requestInDirectory(url, instance.directory)
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual([usage])
    const messages = yield* requestInDirectory(`/session/${chat.id}/message`, instance.directory)
    expect(yield* messages.json).toEqual([])
  }),
)

it.instance("returns 404 for an unknown session instead of claiming zero usage", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const response = yield* requestInDirectory("/session/ses_missing/auxiliary_usage", instance.directory)
    expect(response.status).toBe(404)
  }),
)
