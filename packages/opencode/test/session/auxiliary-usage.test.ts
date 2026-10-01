import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionAuxiliaryUsageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

function usage(
  sessionID: SessionID,
  status: SessionV1.AuxiliaryUsage["status"] = "complete",
): SessionV1.AuxiliaryUsage {
  const requestID = SessionV1.AuxiliaryRequestID.create()
  return {
    id: `${requestID}:0`,
    sessionID,
    requestID,
    step: 0,
    purpose: "title",
    providerID: ProviderV2.ID.make("test"),
    modelID: ModelV2.ID.make("title-model"),
    status,
    ...(status === "complete"
      ? {
          cost: 0.03,
          tokens: { total: 175, input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } },
        }
      : {}),
    time: { created: 1000, updated: 1000 },
  }
}

describe("session auxiliary usage", () => {
  it.instance("durably replaces repeated step IDs without duplicating charges or changing conversation totals", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const database = yield* Database.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const pending = usage(created.id, "pending")
      yield* session.updateAuxiliaryUsage(pending)
      expect(yield* session.auxiliaryUsage(created.id)).toEqual([pending])

      const completed = {
        ...usage(created.id),
        id: pending.id,
        requestID: pending.requestID,
        time: { created: pending.time.created, updated: 2000 },
      }
      yield* session.updateAuxiliaryUsage(completed)
      yield* session.updateAuxiliaryUsage(completed)
      const corrected = { ...completed, cost: 0.04, time: { ...completed.time, updated: 3000 } }
      yield* session.updateAuxiliaryUsage(corrected)
      const next = { ...completed, id: `${pending.requestID}:1`, step: 1, cost: 0.02 }
      yield* session.updateAuxiliaryUsage(next)

      expect(yield* session.auxiliaryUsage(created.id)).toEqual([corrected, next])
      const persisted = yield* database.db
        .select()
        .from(SessionAuxiliaryUsageTable)
        .where(eq(SessionAuxiliaryUsageTable.session_id, created.id))
        .orderBy(SessionAuxiliaryUsageTable.id)
        .all()
      expect(persisted.map((row) => row.data)).toEqual([corrected, next])
      expect(persisted.reduce((total, row) => total + (row.data.cost ?? 0), 0)).toBeCloseTo(0.06)
      const saved = yield* session.get(created.id)
      expect(saved.cost).toEqual(created.cost)
      expect(saved.tokens).toEqual(created.tokens)
    }),
  )

  it.instance("keeps auxiliary usage when the title changes or a conversation message is deleted", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const record = usage(created.id)
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID: created.id,
        role: "user",
        agent: "user",
        model: { providerID: record.providerID, modelID: record.modelID },
        time: { created: 1000 },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID: created.id,
        type: "text",
        text: "A prompt whose title request was already charged",
      })
      yield* session.updateAuxiliaryUsage(record)
      yield* session.setTitle({ sessionID: created.id, title: "User-renamed session" })
      expect((yield* session.get(created.id)).title).toBe("User-renamed session")
      expect(yield* session.auxiliaryUsage(created.id)).toEqual([record])

      yield* session.removeMessage({ sessionID: created.id, messageID })
      expect(yield* session.messages({ sessionID: created.id })).toEqual([])
      expect(yield* session.auxiliaryUsage(created.id)).toEqual([record])
    }),
  )

  it.instance("does not copy auxiliary charges into a fork or change the original ledger", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "original" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const record = usage(created.id)
      yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: created.id,
        role: "user",
        agent: "user",
        model: { providerID: record.providerID, modelID: record.modelID },
        time: { created: 1000 },
      })
      yield* session.updateAuxiliaryUsage(record)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(yield* session.messages({ sessionID: fork.id })).toHaveLength(1)
      expect(yield* session.auxiliaryUsage(fork.id)).toEqual([])
      expect(yield* session.auxiliaryUsage(created.id)).toEqual([record])
      const forkUsage = usage(fork.id, "unavailable")
      yield* session.updateAuxiliaryUsage(forkUsage)
      expect(yield* session.auxiliaryUsage(fork.id)).toEqual([forkUsage])
      expect(yield* session.auxiliaryUsage(created.id)).toEqual([record])
    }),
  )

  it.instance("deletes stored auxiliary rows with their session without deleting another session's rows", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const database = yield* Database.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const other = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const record = usage(created.id)
      const otherUsage = usage(other.id)
      yield* session.updateAuxiliaryUsage(record)
      yield* session.updateAuxiliaryUsage(otherUsage)
      expect(yield* session.auxiliaryUsage(created.id)).toEqual([record])

      yield* session.remove(created.id)
      expect(
        yield* database.db
          .select()
          .from(SessionAuxiliaryUsageTable)
          .where(eq(SessionAuxiliaryUsageTable.session_id, created.id))
          .all(),
      ).toEqual([])
      expect(Exit.isFailure(yield* session.auxiliaryUsage(created.id).pipe(Effect.exit))).toBe(true)
      expect(yield* session.auxiliaryUsage(other.id)).toEqual([otherUsage])
    }),
  )

  it.instance("emits pending and completed records with the same payload returned by a durable read", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const pending = usage(created.id, "pending")
      const received: (typeof SessionV1.Event.AuxiliaryUsageUpdated.data.Type)[] = []
      const ready = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== SessionV1.Event.AuxiliaryUsageUpdated.type) return Effect.void
        const data = event.data as typeof SessionV1.Event.AuxiliaryUsageUpdated.data.Type
        if (data.sessionID !== created.id) return Effect.void
        received.push(data)
        if (received.length === 2) Deferred.doneUnsafe(ready, Effect.void)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* session.updateAuxiliaryUsage(pending)
      const completed = {
        ...usage(created.id),
        id: pending.id,
        requestID: pending.requestID,
        time: { created: pending.time.created, updated: 2000 },
      }
      yield* session.updateAuxiliaryUsage(completed)
      yield* awaitWithTimeout(Deferred.await(ready), "auxiliary usage events were not delivered")

      expect(received).toEqual([
        { sessionID: created.id, usage: pending },
        { sessionID: created.id, usage: completed },
      ])
      expect(received[1]!.usage).toEqual((yield* session.auxiliaryUsage(created.id))[0])
    }),
  )
})
