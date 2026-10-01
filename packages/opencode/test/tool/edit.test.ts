import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EditSummaryFlag } from "@/tool/edit-summary-flag"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { TestClock } from "effect/testing"
import { Config } from "@/config/config"
import { Vcs } from "@/project/vcs"
import { $ } from "bun"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function makeRecordingCtx() {
  const requests: Parameters<Tool.Context["ask"]>[0][] = []

  const next: Tool.Context = {
    ...ctx,
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
      }),
  }

  return { requests, ctx: next }
}

afterEach(async () => {
  await disposeAllInstances()
})

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

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  for (const outcome of ["cancel", "timeout", "failure", "cancel-after-summary"] as const) {
    it.instance(`summary ${outcome} respects cancellation and fail-open boundaries`, () =>
      Effect.gen(function* () {
        const before = EditSummaryFlag.isEnabled()
        EditSummaryFlag.set(true)
        yield* Effect.addFinalizer(() => Effect.sync(() => EditSummaryFlag.set(before)))
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        const filepath = path.join(test.directory, "summary.txt")
        yield* put(filepath, "old content")
        const controller = new AbortController()
        const started = yield* Deferred.make<AbortSignal>()
        const metadata: unknown[] = []
        const language: LanguageModelV3 = {
          specificationVersion: "v3",
          provider: "test",
          modelId: "summary",
          supportedUrls: {},
          doGenerate: async () => {
            throw new Error("unexpected non-streaming request")
          },
          doStream: async (options) => ({
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(stream) {
                const signal = options.abortSignal!
                Deferred.doneUnsafe(started, Effect.succeed(signal))
                if (outcome === "failure") {
                  stream.enqueue({ type: "error", error: new Error("provider failed") })
                  stream.close()
                  return
                }
                if (outcome === "cancel-after-summary") {
                  stream.enqueue({ type: "text-start", id: "summary" })
                  stream.enqueue({ type: "text-delta", id: "summary", delta: "Summary" })
                  stream.enqueue({ type: "text-end", id: "summary" })
                  stream.enqueue({
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 2, text: 2, reasoning: 0 },
                    },
                  })
                  stream.close()
                  return
                }
                signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")), {
                  once: true,
                })
              },
            }),
          }),
        }
        const base = yield* Provider.Service
        const fiber = yield* run(
          { filePath: filepath, oldString: "old", newString: "new" },
          {
            ...ctx,
            sessionID: chat.id,
            abort: controller.signal,
            extra: { model: provider.model },
            metadata: (value) =>
              Effect.sync(() => {
                metadata.push(value.metadata)
              }),
            ask: () =>
              Effect.sync(() => {
                if (outcome === "cancel-after-summary") controller.abort()
              }),
          },
        ).pipe(
          Effect.provideService(Provider.Service, { ...base, getLanguage: () => Effect.succeed(language) }),
          Effect.forkChild,
        )
        const signal = yield* Deferred.await(started)
        if (outcome === "cancel") controller.abort()
        if (outcome === "timeout") yield* TestClock.adjust("10 seconds")
        const exit = yield* Fiber.await(fiber)
        const cancelled = outcome === "cancel" || outcome === "cancel-after-summary"
        expect(Exit.isFailure(exit)).toBe(cancelled)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(yield* load(filepath)).toBe(cancelled ? "old content" : "new content")
        expect(signal.aborted).toBe(true)
        if (!cancelled) expect(metadata).toContainEqual({ summaryFailed: true })
        const usage = yield* sessions.auxiliaryUsage(chat.id)
        expect(usage).toHaveLength(1)
        expect(usage[0]?.status).toBe(outcome === "cancel-after-summary" ? "complete" : "unavailable")
      }).pipe(Effect.provide(TestClock.layer())),
    )
  }

  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("rejects empty oldString on existing files and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const original = `${bom}using System;\n`
        yield* put(filepath, original)

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "using Up;\n" })).message).toContain(
          "oldString cannot be empty",
        )

        const content = yield* loadRaw(filepath)
        expect(content).toBe(original)
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("rejects loose block-anchor matches and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = [
          "function configure() {",
          "  keepImportantState()",
          "  removeAllUserData()",
          "  archiveBackups()",
          "  auditLog()",
          "}",
        ].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects block-anchor matches with unrelated middle content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })

  describe("protected branch safeguard", () => {
    it.instance(
      "asks for confirmation before editing on main",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          yield* Effect.promise(() => $`git branch -M main`.cwd(test.directory).quiet())

          const filepath = path.join(test.directory, "protected.txt")
          yield* put(filepath, "old content")

          const { requests, ctx: recordingCtx } = makeRecordingCtx()

          yield* run(
            {
              filePath: filepath,
              oldString: "old content",
              newString: "new content",
            },
            recordingCtx,
          )

          const request = requests.find((item) => item.permission === "protected_branch")

          expect(request).toBeDefined()
          expect(request?.patterns).toEqual(["main"])
          expect(request?.always).toEqual([])
          expect(request?.metadata.branch).toBe("main")
        }),
      { git: true },
    )

    it.instance(
      "does not ask for protected branch confirmation on a feature branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          yield* Effect.promise(() => $`git branch -M feature/test`.cwd(test.directory).quiet())

          const filepath = path.join(test.directory, "feature.txt")
          yield* put(filepath, "old content")

          const { requests, ctx: recordingCtx } = makeRecordingCtx()

          yield* run(
            {
              filePath: filepath,
              oldString: "old content",
              newString: "new content",
            },
            recordingCtx,
          )

          const request = requests.find((item) => item.permission === "protected_branch")

          expect(request).toBeUndefined()
        }),
      { git: true },
    )
  })
})
