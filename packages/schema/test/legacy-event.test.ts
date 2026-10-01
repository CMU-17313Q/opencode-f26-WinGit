import { describe, expect, test } from "bun:test"
import { LegacyEvent } from "../src/legacy-event"
import { PermissionV1 } from "../src/permission-v1"
import { QuestionV1 } from "../src/question-v1"
import { Project } from "../src/project"
import { SessionV1 } from "../src/session-v1"
import { Schema } from "effect"
import { SessionID } from "../src/session-id"
import { Provider } from "../src/provider"
import { Model } from "../src/model"

describe("legacy public event schemas", () => {
  test("auxiliary usage omits unknown optional fields and request IDs require the exact prefix", () => {
    const requestID = SessionV1.AuxiliaryRequestID.create()
    expect(requestID).toStartWith("aux_")
    expect(() => Schema.decodeUnknownSync(SessionV1.AuxiliaryRequestID)("auxwrong")).toThrow()
    const usage = Schema.encodeSync(SessionV1.AuxiliaryUsage)({
      id: `${requestID}:0`,
      requestID,
      sessionID: SessionID.create(),
      step: 0,
      purpose: "title",
      providerID: Provider.ID.make("test"),
      modelID: Model.ID.make("title"),
      status: "pending",
      cost: undefined,
      tokens: undefined,
      time: { created: 1, updated: 1 },
    })
    expect(Object.hasOwn(usage, "cost")).toBe(false)
    expect(Object.hasOwn(usage, "tokens")).toBe(false)
  })
  test("owns all SessionV1 definitions", () => {
    expect(SessionV1.Event.Definitions.map((event) => event.type)).toEqual([
      "session.created",
      "session.updated",
      "session.deleted",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "session.auxiliary_usage.updated",
      "message.part.delta",
      "session.diff",
      "session.error",
    ])
    const durable = SessionV1.Event.Definitions.filter((event) => event.durable !== undefined)
    expect(durable).toHaveLength(8)
    expect(durable.every((event) => event.durable?.aggregate === "sessionID")).toBe(true)
    expect(durable.every((event) => event.durable?.version === 1)).toBe(true)
  })

  test("owns the legacy transient public definitions", () => {
    expect([
      SessionV1.PartDelta.type,
      SessionV1.Diff.type,
      SessionV1.Error.type,
      PermissionV1.Event.Asked.type,
      PermissionV1.Event.Replied.type,
      QuestionV1.Event.Asked.type,
      QuestionV1.Event.Replied.type,
      QuestionV1.Event.Rejected.type,
      Project.Event.Updated.type,
      LegacyEvent.CommandExecuted.type,
    ]).toEqual([
      "message.part.delta",
      "session.diff",
      "session.error",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
      "project.updated",
      "command.executed",
    ])
  })
})
