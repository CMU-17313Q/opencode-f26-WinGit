import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Session.node), httpApiLayer))

afterEach(disposeAllInstances)

const readTurn = Effect.fn("test.contextReadTurn")(function* (sessionID: SessionID, created: number, paths: string[]) {
  const session = yield* Session.Service
  const instance = yield* TestInstance
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("unconfigured-model") },
  })
  const assistant = yield* session.updateMessage({
    id: MessageID.ascending(),
    parentID: user.id,
    sessionID,
    role: "assistant",
    time: { created: created + 1 },
    providerID: ProviderV2.ID.make("fixture"),
    modelID: ModelV2.ID.make("unconfigured-model"),
    agent: "build",
    mode: "build",
    path: { cwd: instance.directory, root: instance.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const parts: SessionV1.ToolPart[] = []
  for (const filePath of paths) {
    const id = PartID.ascending()
    parts.push(
      yield* session.updatePart({
        id,
        sessionID,
        messageID: assistant.id,
        type: "tool",
        callID: id,
        tool: "read",
        state: {
          status: "completed",
          input: { filePath },
          output: "text",
          title: filePath,
          metadata: {},
          time: { start: created + 1, end: created + 2 },
        },
      }),
    )
  }
  return { user, assistant, parts }
})

const context = Effect.fn("test.contextRequest")(function* (sessionID: SessionID) {
  const instance = yield* TestInstance
  const response = yield* requestInDirectory(`/session/${sessionID}/context_files`, instance.directory)
  expect(response.status).toBe(200)
  return yield* response.json
})

const redo = Effect.fn("test.contextRedo")(function* (sessionID: SessionID) {
  const instance = yield* TestInstance
  const response = yield* requestInDirectory(`/session/${sessionID}/unrevert`, instance.directory, { method: "POST" })
  expect(response.status).toBe(200)
})

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

it.instance("undo projects whole turns and redo restores context without removing history", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* Effect.acquireRelease(session.create({}), (info) => session.remove(info.id).pipe(Effect.orDie))
    yield* readTurn(chat.id, 1, ["keep.ts"])
    const undone = yield* readTurn(chat.id, 3, ["undo.ts"])
    const history = yield* session.messages({ sessionID: chat.id })
    const complete = [
      { path: "keep.ts", tokens: 1 },
      { path: "undo.ts", tokens: 1 },
    ]
    expect(yield* context(chat.id)).toEqual(complete)

    yield* session.setRevert({ sessionID: chat.id, revert: { messageID: undone.user.id }, summary: undefined })
    const marked = yield* session.get(chat.id)
    expect(yield* context(chat.id)).toEqual([{ path: "keep.ts", tokens: 1 }])
    expect(yield* session.messages({ sessionID: chat.id })).toEqual(history)
    expect(yield* session.get(chat.id)).toEqual(marked)

    yield* redo(chat.id)
    expect((yield* session.get(chat.id)).revert).toBeUndefined()
    expect(yield* context(chat.id)).toEqual(complete)
    expect(yield* session.messages({ sessionID: chat.id })).toEqual(history)
  }),
)

it.instance("undo projects part boundaries and follows cleanup semantics when a boundary is missing", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* Effect.acquireRelease(session.create({}), (info) => session.remove(info.id).pipe(Effect.orDie))
    const target = yield* readTurn(chat.id, 1, ["a.ts", "b.ts", "c.ts"])
    yield* readTurn(chat.id, 3, ["later.ts"])
    const history = yield* session.messages({ sessionID: chat.id })
    for (const boundary of [
      { revert: { messageID: target.assistant.id, partID: target.parts[1]!.id }, paths: ["a.ts"] },
      { revert: { messageID: target.assistant.id, partID: target.parts[0]!.id }, paths: [] },
      {
        revert: { messageID: target.assistant.id, partID: PartID.make("prt_missing") },
        paths: ["a.ts", "b.ts", "c.ts"],
      },
      { revert: { messageID: MessageID.make("msg_missing") }, paths: ["a.ts", "b.ts", "c.ts", "later.ts"] },
    ]) {
      yield* session.setRevert({ sessionID: chat.id, revert: boundary.revert, summary: undefined })
      const marked = yield* session.get(chat.id)
      expect(yield* context(chat.id)).toEqual(boundary.paths.map((path) => ({ path, tokens: 1 })))
      expect(yield* session.messages({ sessionID: chat.id })).toEqual(history)
      expect(yield* session.get(chat.id)).toEqual(marked)
    }
    yield* redo(chat.id)
    expect(yield* context(chat.id)).toEqual(["a.ts", "b.ts", "c.ts", "later.ts"].map((path) => ({ path, tokens: 1 })))
    expect(yield* session.messages({ sessionID: chat.id })).toEqual(history)
  }),
)

it.instance("undo removes reverted compaction before selecting retained context and redo restores it", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* Effect.acquireRelease(session.create({}), (info) => session.remove(info.id).pipe(Effect.orDie))
    yield* readTurn(chat.id, 1, ["before-compaction.ts"])
    const compacted = yield* readTurn(chat.id, 3, [])
    const part = yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: compacted.user.id,
      type: "compaction",
      auto: true,
    })
    yield* session.updateMessage({ ...compacted.assistant, summary: true, finish: "stop" })
    yield* readTurn(chat.id, 5, ["after-compaction.ts"])
    const history = yield* session.messages({ sessionID: chat.id })
    const complete = [{ path: "after-compaction.ts", tokens: 1 }]
    expect(yield* context(chat.id)).toEqual(complete)

    for (const revert of [
      { messageID: compacted.user.id },
      { messageID: compacted.user.id, partID: part.id },
      { messageID: compacted.assistant.id },
    ]) {
      yield* session.setRevert({ sessionID: chat.id, revert, summary: undefined })
      const marked = yield* session.get(chat.id)
      expect(yield* context(chat.id)).toEqual([{ path: "before-compaction.ts", tokens: 1 }])
      expect(yield* session.messages({ sessionID: chat.id })).toEqual(history)
      expect(yield* session.get(chat.id)).toEqual(marked)
    }
    yield* redo(chat.id)
    expect(yield* context(chat.id)).toEqual(complete)
    expect(yield* session.messages({ sessionID: chat.id })).toEqual(history)
  }),
)
