
import { afterEach, describe, expect } from "bun:test"
import fc from "fast-check"
import path from "path"
import { $ } from "bun"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EditTool } from "../../src/tool/edit"
import { SessionID, MessageID } from "../../src/session/schema"
import type * as Tool from "../../src/tool/tool"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"

const provider = ProviderTest.fake()

const layer = LayerNode.compile(
  LayerNode.group([
    LSP.node,
    FSUtil.node,
    Format.node,
    EventV2Bridge.node,
    Truncate.node,
    Agent.node,
    Provider.node,
    Session.node,
    SessionProjector.node,
    Config.node,
    Vcs.node,
  ]),
  [[Provider.node, provider.layer]],
)

const it = testEffect(layer)
const MARKER = "__P4B_ORIGINAL_TEXT__"

afterEach(async () => {
  await disposeAllInstances()
})

function attemptRejectedEdit(filePath: string, original: string, reject = true) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(filePath, original)

    const info = yield* EditTool
    const tool = yield* info.init()
    const requests: string[] = []

    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_r1_property"),
      messageID: MessageID.make("msg_r1_property"),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: (request) =>
        Effect.gen(function* () {
          requests.push(request.permission)
          if (reject && request.permission === "protected_branch") {
            yield* Effect.die(new Error("branch rejected"))
          }
        }),
    }

    const exit = yield* tool.execute(
      {
        filePath,
        oldString: MARKER,
        newString: "replacement",
      },
      ctx,
    ).pipe(Effect.exit)

    return {
      exit,
      requests,
      actual: yield* fs.readFileString(filePath),
    }
  })
}

describe("Feature-Branch Safeguard rejection properties", () => {
  // R1: When a user rejects a protected-branch modification,
  // OpenCode must cancel the operation without changing files.
  // Kind: invariant.
  // Generator: random content before and after a fixed marker,
  // covering empty, short, and different surrounding contents.
  it.instance(
    "R1: rejected edits leave generated file contents unchanged",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance

        yield* Effect.promise(() =>
          $`git branch -M main`.cwd(instance.directory).quiet()
        )

        const filePath = path.join(
          instance.directory,
          "protected-r1.txt",
        )

        const services = yield* Effect.context<
          Effect.Services<ReturnType<typeof attemptRejectedEdit>>
        >()
        const run = Effect.runPromiseWith(services)

        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(
              fc.string({ maxLength: 150 }),
              fc.string({ maxLength: 150 }),
              async (prefix, suffix) => {
                const original = `${prefix}${MARKER}${suffix}`
                const result = await run(
                  attemptRejectedEdit(filePath, original)
                )

                expect(result.requests).toEqual([
                  "protected_branch",
                ])
                expect(Exit.isFailure(result.exit)).toBe(true)
                expect(result.actual).toBe(original)


                const next = await run(
                attemptRejectedEdit(filePath, original, false),
                )

                expect(Exit.isSuccess(next.exit)).toBe(true)
                expect(next.requests).toContain("protected_branch")
                expect(next.requests).toContain("edit")
                expect(next.actual).toBe(
                `${prefix}replacement${suffix}`,
                )

              },
            ),
            { numRuns: 40 },
          )
        )
        console.log("[property] R1: rejected modifications preserve files passed")
      }),
    { git: true },
    30000,
  )


  // R5: Outside a Git repository, OpenCode must skip
  // protected-branch confirmation and allow normal edits.
  // Kind: invariant.
  // Generator: random file contents surrounding an edit marker.
  it.instance(
    "R5: non-Git edits succeed without protected-branch confirmation",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const filePath = path.join(instance.directory, "non-git.txt")

        const services = yield* Effect.context<
          Effect.Services<ReturnType<typeof attemptRejectedEdit>>
        >()
        const run = Effect.runPromiseWith(services)

        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(
              fc.string({ maxLength: 120 }),
              fc.string({ maxLength: 120 }),
              async (prefix, suffix) => {
                fc.pre(
                  !prefix.includes(MARKER) &&
                  !suffix.includes(MARKER),
                )

                const original = `${prefix}${MARKER}${suffix}`
                const outcome = await run(
                  attemptRejectedEdit(filePath, original, false),
                )

                expect(Exit.isSuccess(outcome.exit)).toBe(true)
                expect(outcome.requests).not.toContain("protected_branch")
                expect(outcome.requests).toContain("edit")
                expect(outcome.actual).toBe(
                  `${prefix}replacement${suffix}`,
                )
              },
            ),
            { numRuns: 25 },
          )
        )
        console.log("[property] R5: non-Git file modifications passed")
      }),
    { git: false },
    30000,
  )
})
