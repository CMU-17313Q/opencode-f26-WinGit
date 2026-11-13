// Property-based checks for `opencode run --summary` (Project 4B).
//
// Each property names the requirement it checks (ID and wording, from the Project 4A table in
// traceability/muhamma4.md) and its kind: round-trip, invariant or metamorphic.
//
// R6 and R8 are not covered. Whether the model names the right language and libraries, or invents a name, depends on
// what the model writes, which is not deterministic. R6 was dropped (see the traceability file).
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fc from "fast-check"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EditSummary } from "../../src/tool/edit-summary"
import { EditSummaryFlag } from "../../src/tool/edit-summary-flag"
import { EditTool } from "../../src/tool/edit"
import { ProviderTest } from "../fake/provider"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { LSP } from "@/lsp/lsp"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Vcs } from "@/project/vcs"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const MAX_CONTENT_CHARS = 20_000
const TRUNCATION_MARKER = "\n...(truncated)"
const noSession = Layer.mock(Session.Service, { updateAuxiliaryUsage: () => Effect.void })

function streamOf(text: string): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "summary" },
        { type: "text-delta", id: "summary", delta: text },
        { type: "text-end", id: "summary" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]
      parts.forEach((part) => controller.enqueue(part))
      controller.close()
    },
  })
}

const promptText = (options: LanguageModelV3CallOptions) =>
  options.prompt
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("")

// A language model that records the prompt it was asked to summarize and answers with `reply`.
function recordingLanguage(prompts: string[], reply: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "summary",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unexpected non-streaming request")
    },
    doStream: async (options: LanguageModelV3CallOptions) => {
      prompts.push(promptText(options))
      return { stream: streamOf(reply) }
    },
  }
}

async function summarizer(prompts: string[], reply: string) {
  const fake = ProviderTest.fake({ getLanguage: () => Effect.succeed(recordingLanguage(prompts, reply)) })
  const provider = await Effect.runPromise(Provider.Service.pipe(Effect.provide(fake.layer)))
  return (filePath: string, content: string) =>
    Effect.runPromise(
      EditSummary.summarizeFile({
        provider,
        sessionID: SessionID.create(),
        abort: AbortSignal.any([]),
        path: filePath,
        content,
      }).pipe(Effect.provide(noSession)),
    )
}

// Text of the file as the model saw it: everything after the "File: <path>" header line.
const seenContent = (prompt: string, filePath: string) =>
  prompt.slice(prompt.indexOf(`File: ${filePath}\n\n`) + `File: ${filePath}\n\n`.length)

// Generator choices:
// - fileName: realistic names with the extensions the feature is used on (ts, py, txt).
// - fileContent: half arbitrary text, half code-like text built from the characters real source files are made of
//   (braces, semicolons, tabs, CRLF and bare newlines, accented and CJK characters), plus the empty file.
//   Plain random strings rarely produce line endings or brackets, which is where text handling usually breaks.
// - fileSize: random sizes plus the exact boundaries around the 20,000-character cap (0, 1, 19,999, 20,000,
//   20,001, 40,000). A plain integer range almost never lands on the cap, and an off-by-one there is the bug
//   interviewees would feel as "the summary ignores the end of my file".
const fileName = fc.stringMatching(/^[a-z]{1,8}\.(ts|py|txt)$/)
const codeLike = fc.string({ unit: fc.constantFrom(..."abc xyz_{}();=\t\n\r字é\"'".split("")), maxLength: 2000 })
const fileContent = fc.oneof(fc.string({ maxLength: 2000 }), codeLike, fc.constant(""))
const fileSize = fc.oneof(
  fc.constantFrom(0, 1, MAX_CONTENT_CHARS - 1, MAX_CONTENT_CHARS, MAX_CONTENT_CHARS + 1, 2 * MAX_CONTENT_CHARS),
  fc.integer({ min: 0, max: 60_000 }),
)

describe("--summary properties: what the model is given", () => {
  // R1: "The summary is read-only information: it is printed before the edit's diff, is generated from the pre-edit
  //     file, and never applies, approves, or changes the edit."  (the "generated from the pre-edit file" part)
  // R3: "The summary describes the file as it currently is" (the request holds the current content unchanged).
  // Kind: invariant
  test("R1/R3: any file under the size limit reaches the model verbatim", async () => {
    const prompts: string[] = []
    const summarize = await summarizer(prompts, "ok")
    await fc.assert(
      fc.asyncProperty(fileName, fileContent, async (name, content) => {
        prompts.length = 0
        await summarize(`/repo/${name}`, content)
        expect(prompts).toHaveLength(1)
        expect(seenContent(prompts[0]!, `/repo/${name}`)).toBe(content)
      }),
      { numRuns: 100 },
    )
  })

  // R2: "Running --summary twice on the same unchanged file gives summaries with the same gist (same purpose and
  //     main parts); only wording may differ." The code controls the input, so the checkable form is that an
  //     unchanged file sends an identical request every time.
  // Kind: invariant
  test("R2: summarizing the same unchanged file twice sends identical requests", async () => {
    const prompts: string[] = []
    const summarize = await summarizer(prompts, "ok")
    await fc.assert(
      fc.asyncProperty(fileName, fileContent, async (name, content) => {
        prompts.length = 0
        await summarize(`/repo/${name}`, content)
        await summarize(`/repo/${name}`, content)
        expect(prompts).toHaveLength(2)
        expect(prompts[1]).toBe(prompts[0])
      }),
      { numRuns: 40 },
    )
  })

  // R3: "The summary describes the file as it currently is: content that is still in the file stays in the summary,
  //     and content that was removed is not mentioned." Checked on the request: still-present text is sent, removed
  //     text is not, and putting it back brings it back (the acceptance case "Put B back, run again").
  // Kind: round-trip (remove, then restore)
  // Generator: unique identifier-like names (FN_ plus six capitals) stand in for functions A and B, so a name
  // cannot appear by accident inside the random padding that stands in for the rest of the file.
  test("R3: text removed from a file is absent from the request, text kept is present", async () => {
    const prompts: string[] = []
    const summarize = await summarizer(prompts, "ok")
    await fc.assert(
      fc.asyncProperty(
        fileContent,
        fc.stringMatching(/^FN_[A-Z]{6}$/),
        fc.stringMatching(/^FN_[A-Z]{6}$/),
        async (padding, kept, removed) => {
          fc.pre(kept !== removed && !padding.includes(kept) && !padding.includes(removed))
          prompts.length = 0
          await summarize("/repo/a.ts", `${padding}\n${kept}`)
          expect(prompts[0]).toContain(kept)
          expect(prompts[0]).not.toContain(removed)
          // Putting the removed function back brings it back.
          prompts.length = 0
          await summarize("/repo/a.ts", `${padding}\n${kept}\n${removed}`)
          expect(prompts[0]).toContain(kept)
          expect(prompts[0]).toContain(removed)
        },
      ),
      { numRuns: 100 },
    )
  })

  // R4: "A long file may make the summary slower, but it must not block the edit." The cap on what is sent keeps
  //     the request small enough to finish within the time limit, at every size up to and past the cap.
  // Kind: invariant (the content sent never exceeds the cap plus the truncation marker; below the cap it is unchanged)
  test("R4: the content sent is capped at the limit plus a truncation marker", async () => {
    const prompts: string[] = []
    const summarize = await summarizer(prompts, "ok")
    await fc.assert(
      fc.asyncProperty(fileSize, fc.constantFrom("a", "é", "\n", "字"), async (length, ch) => {
        prompts.length = 0
        const content = ch.repeat(length)
        await summarize("/repo/big.txt", content)
        const seen = seenContent(prompts[0]!, "/repo/big.txt")
        expect(seen.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS + TRUNCATION_MARKER.length)
        if (length <= MAX_CONTENT_CHARS) expect(seen).toBe(content)
        else expect(seen).toBe(content.slice(0, MAX_CONTENT_CHARS) + TRUNCATION_MARKER)
      }),
      { numRuns: 40 },
    )
  })

  // R7: "Across file sizes, the request asks for the same purpose and 3-6 sentence form." (the revised wording)
  //     Changing the file's size and name must not change the instruction.
  // Kind: metamorphic (the input size changes in a known way, the instruction must stay the same)
  test("R7: the 3-6 sentence instruction does not depend on file size or name", async () => {
    const prompts: string[] = []
    const summarize = await summarizer(prompts, "ok")
    await fc.assert(
      fc.asyncProperty(fileName, fileSize, async (name, length) => {
        prompts.length = 0
        await summarize(`/repo/${name}`, "x".repeat(length))
        expect(prompts[0]).toContain("3-6 sentence")
        expect(prompts[0]!.split("\n\n")[0]).toBe(
          "Write a concise 3-6 sentence plain-language summary of this file's purpose and structure.",
        )
      }),
      { numRuns: 40 },
    )
  })
})

describe("--summary properties: what the user is shown", () => {
  // R1: the summary is read-only information, so what is shown is the model's own text, only trimmed.
  // Kind: invariant
  // Generator: a body of words and punctuation with 0-5 spaces, tabs or newlines on each side, because models
  // often wrap their reply in blank lines and the trim is what the user sees as a clean block.
  test("R1/R5: the text shown is the model's reply, trimmed, whatever the padding", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9.,]+( [A-Za-z0-9.,]+){0,20}$/),
        fc.stringMatching(/^[ \t\n]{0,5}$/),
        fc.stringMatching(/^[ \t\n]{0,5}$/),
        async (body, before, after) => {
          const summarize = await summarizer([], `${before}${body}${after}`)
          expect(await summarize("/repo/a.ts", "x")).toBe(body)
        },
      ),
      { numRuns: 50 },
    )
  })
})

// ---- Edit-tool level: the summary never changes the edit (R1) and failure never blocks it (R4, R5) ----

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

const MARK = "\u0000MARK"

describe("--summary properties: the edit itself", () => {
  // R1: "...never applies, approves, or changes the edit": "The edit result is identical to the same prompt run
  //     without the flag."
  // R4: "A long file may make the summary slower, but it must not block the edit: the edit goes through."
  // R5: "A failed summary shows a clear warning rather than nothing": the edit reports summaryFailed.
  // Kind: metamorphic (turning the flag on, or making the provider fail, must not change the edited file)
  // Generator: random text before and after a fixed marker that is the edited string, plus a random replacement;
  // each generated file is edited three times (flag off, flag on, flag on with failing provider) and all three
  // must land on the same bytes.
  it.instance("R1/R4/R5: the edited file is identical with the flag off, on, and on with a failing provider", () =>
    Effect.gen(function* () {
      const before = EditSummaryFlag.isEnabled()
      yield* Effect.addFinalizer(() => Effect.sync(() => EditSummaryFlag.set(before)))
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const fsUtil = yield* FSUtil.Service
      const base = yield* Provider.Service

      const prompts: string[] = []
      const languages = {
        success: recordingLanguage(prompts, "A summary."),
        failure: {
          ...recordingLanguage(prompts, ""),
          doStream: async (options: LanguageModelV3CallOptions) => ({
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                prompts.push(promptText(options))
                controller.enqueue({ type: "error", error: new Error("provider failed") })
                controller.close()
              },
            }),
          }),
        } satisfies LanguageModelV3,
      }

      const editWith = (mode: "off" | "success" | "failure", filepath: string, newString: string) =>
        Effect.gen(function* () {
          EditSummaryFlag.set(mode !== "off")
          const metadata: Record<string, unknown>[] = []
          // The tool captures Provider.Service when it is built, so resolve it under the fake provider too.
          yield* Effect.gen(function* () {
            const info = yield* EditTool
            const tool = yield* info.init()
            return yield* tool.execute(
              { filePath: filepath, oldString: MARK, newString },
              {
                sessionID: chat.id,
                messageID: MessageID.make("msg_test"),
                callID: "",
                agent: "build",
                abort: AbortSignal.any([]),
                messages: [],
                extra: { model: provider.model },
                metadata: (value) => Effect.sync(() => void metadata.push(value.metadata ?? {})),
                ask: () => Effect.void,
              },
            )
          }).pipe(
            Effect.provideService(Provider.Service, {
              ...base,
              getLanguage: () => Effect.succeed(mode === "failure" ? languages.failure : languages.success),
            }),
          )
          return { metadata, content: yield* fsUtil.readFileString(filepath) }
        })

      const services = yield* Effect.context<Effect.Services<ReturnType<typeof editWith>>>()
      const run = Effect.runPromiseWith(services)
      let index = 0
      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(
            fc.string({ maxLength: 300 }),
            fc.string({ maxLength: 300 }),
            fc.string({ maxLength: 300 }),
            async (head, tail, replacement) => {
              const original = `${head}${MARK}${tail}`
              const filepath = path.join(test.directory, `case-${index++}.txt`)
              const expected = `${head}${replacement}${tail}`
              const results = await run(
                Effect.gen(function* () {
                  const outcomes = []
                  for (const mode of ["off", "success", "failure"] as const) {
                    yield* fsUtil.writeWithDirs(filepath, original)
                    prompts.length = 0
                    const outcome = yield* editWith(mode, filepath, replacement)
                    outcomes.push({ mode, ...outcome, prompt: prompts[0] })
                  }
                  return outcomes
                }).pipe(Effect.provide(TestClock.layer())),
              )
              for (const result of results) {
                // R1/R4: the edit lands exactly the same way regardless of the flag or a failing summary.
                expect(result.content).toBe(expected)
                // R1/R3: when a summary is requested, it is built from the pre-edit file.
                if (result.mode !== "off") expect(seenContent(result.prompt!, filepath)).toBe(original)
              }
              // With the flag off the edit reports its usual diff metadata but nothing about a summary.
              expect(
                results[0]!.metadata.some((value) => value && ("summary" in value || "summaryFailed" in value)),
              ).toBe(false)
              // R1: a successful summary is read-only metadata; R5: a failed one is reported, not silent.
              expect(results[1]!.metadata).toContainEqual({ summary: "A summary." })
              expect(results[2]!.metadata).toContainEqual({ summaryFailed: true })
            },
          ),
          { numRuns: 25 },
        ),
      )
    }),
  )
})
