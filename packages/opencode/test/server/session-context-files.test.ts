import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Session.node), httpApiLayer))

afterEach(disposeAllInstances)

it.instance("queries retained file text beyond the TUI cache and reflects pruning without mutating history", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const instance = yield* TestInstance
    const chat = yield* Effect.acquireRelease(session.create({}), (info) => session.remove(info.id).pipe(Effect.orDie))
    const url = `/session/${chat.id}/context_files`
    const empty = yield* requestInDirectory(url, instance.directory)
    expect(empty.status).toBe(200)
    expect(yield* empty.json).toEqual([])

    const parent = MessageID.ascending()
    yield* session.updateMessage({
      id: parent,
      sessionID: chat.id,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("unconfigured-model") },
    })
    const messageID = MessageID.ascending()
    yield* session.updateMessage({
      id: messageID,
      parentID: parent,
      sessionID: chat.id,
      role: "assistant",
      time: { created: 1 },
      providerID: ProviderV2.ID.make("fixture"),
      modelID: ModelV2.ID.make("unconfigured-model"),
      agent: "build",
      mode: "build",
      path: { cwd: instance.directory, root: instance.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const read: SessionV1.ToolPart = {
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID,
      type: "tool",
      callID: "early-read",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "early.ts" },
        output: "x".repeat(400),
        title: "early.ts",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
    yield* session.updatePart(read)
    for (const index of Array.from({ length: 100 }, (_, index) => index)) {
      yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "user",
        time: { created: index + 2 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("unconfigured-model") },
      })
    }
    expect(yield* session.messages({ sessionID: chat.id, limit: 100 })).toHaveLength(100)
    const response = yield* requestInDirectory(url, instance.directory)
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual([{ path: "early.ts", tokens: 100 }])
    expect(yield* session.contextFiles(chat.id)).toEqual([{ path: "early.ts", tokens: 100 }])

    if (read.state.status === "completed") read.state.time.compacted = 200
    yield* session.updatePart(read)
    const pruned = yield* requestInDirectory(url, instance.directory)
    expect(pruned.status).toBe(200)
    expect(yield* pruned.json).toEqual([])
    const history = yield* session.messages({ sessionID: chat.id })
    expect(history).toHaveLength(102)
    const persisted = history.find((message) => message.info.id === messageID)
    expect(persisted?.parts[0]).toMatchObject({ state: { output: "x".repeat(400), time: { compacted: 200 } } })
  }),
)

it.instance("returns 404 for an unknown session instead of an empty context list", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const response = yield* requestInDirectory("/session/ses_missing/context_files", instance.directory)
    expect(response.status).toBe(404)
  }),
)
