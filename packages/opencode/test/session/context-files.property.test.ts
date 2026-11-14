import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import path from "path"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_context_property")
// Absolute on every OS (on Windows this becomes C:\repo), so the absolute spellings below stay valid.
const cwd = path.resolve("/repo")
const RUNS = 100

type Call =
  | { tool: "read"; filePath: string; text: string; pruned: boolean }
  | { tool: "write"; filePath: string; text: string }
  | { tool: "edit"; filePath: string; oldString: string; newString: string }
  | { tool: "bash"; command: string }

function toolPart(call: Call): SessionV1.ToolPart {
  const id = PartID.ascending()
  const input =
    call.tool === "read"
      ? { filePath: call.filePath }
      : call.tool === "write"
        ? { filePath: call.filePath, content: call.text }
        : call.tool === "edit"
          ? { filePath: call.filePath, oldString: call.oldString, newString: call.newString }
          : { command: call.command }
  return {
    id,
    messageID: MessageID.make("msg_property"),
    sessionID,
    type: "tool",
    callID: id,
    tool: call.tool,
    state: {
      status: "completed",
      input,
      output: call.tool === "read" ? call.text : "done",
      title: call.tool,
      metadata: {},
      time: { start: 1, end: 2, ...(call.tool === "read" && call.pruned ? { compacted: 3 } : {}) },
    },
  }
}

// One assistant message per turn, in chronological order.
function history(turns: Call[][]): SessionV1.WithParts[] {
  return turns.map((calls, index) => ({
    info: {
      id: MessageID.make(`msg_${String(index).padStart(4, "0")}`),
      parentID: MessageID.make("msg_parent"),
      sessionID,
      role: "assistant",
      time: { created: index + 1 },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      agent: "build",
      mode: "build",
      path: { cwd, root: cwd },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: calls.map(toolPart),
  }))
}

// What /context shows: the same pipeline Session.contextFiles uses, fed the newest-first stream it reads from storage.
function context(turns: Call[][]) {
  return MessageV2.contextFiles(MessageV2.filterCompacted(history(turns).toReversed()))
}

const byPath = (files: { path: string; tokens: number }[]) => files.toSorted((a, b) => a.path.localeCompare(b.path))

// The package's test script runs `bun test --only-failures`, which hides passing tests, so each property prints one
// line after it passes. That keeps the properties visible in the CI log.
const passed = (name: string) => console.log(`[property] ${name}: ${RUNS} generated inputs passed`)

// Generator choices:
// - files: a small pool of repo paths like the ones in the interviews (README.md, app.tsx, notes.md), so the same
//   file is touched several times in one session, which is the case R1, R5 and R6 are about.
// - anySpelling: the read, edit and write tools accept a path relative to the project, "./"-relative, or absolute,
//   and all three open the same file. Users don't see or control which spelling the agent picks.
// - text: half the texts are 0-12 characters, to hit the divide-by-4 rounding edges (and empty files); the rest are
//   up to 3,000 characters, like real source files.
// - calls: reads (some pruned by compaction), edits, writes, and a non-file tool (bash) that must add nothing.
const files = ["README.md", "package.json", "src/app.tsx", "src/util/context-files.ts", "docs/notes.md"]
const file = fc.constantFrom(...files)
const anySpelling = file.chain((name) => fc.constantFrom(name, `./${name}`, path.join(cwd, name)))
const text = fc.oneof(fc.string({ maxLength: 12 }), fc.string({ minLength: 13, maxLength: 3000 }))

const read = (filePath: fc.Arbitrary<string>) =>
  fc.record({ tool: fc.constant("read" as const), filePath, text, pruned: fc.boolean() })
const call = (filePath: fc.Arbitrary<string>): fc.Arbitrary<Call> =>
  fc.oneof(
    { weight: 3, arbitrary: read(filePath) },
    fc.record({ tool: fc.constant("write" as const), filePath, text }),
    fc.record({ tool: fc.constant("edit" as const), filePath, oldString: text, newString: text }),
    fc.record({ tool: fc.constant("bash" as const), command: fc.constantFrom("ls", "cat README.md", "bun test") }),
  )
const session = (filePath: fc.Arbitrary<string>) =>
  fc.array(fc.array(call(filePath), { minLength: 1, maxLength: 4 }), { maxLength: 6 })

describe("/context properties", () => {
  // R1: "Each file appears at most once in the /context list, even if the agent read it more than once."
  // Kind: invariant
  test("R1: each file appears at most once, however the agent spelled its path", () => {
    fc.assert(
      fc.property(session(anySpelling), (turns) => {
        const listed = context(turns).map((entry) => path.resolve(cwd, entry.path))
        expect(new Set(listed).size).toBe(listed.length)
      }),
      { numRuns: RUNS },
    )
    passed("R1: each file appears at most once")
  })

  // R5: "Which files appear, and each file's token count, do not depend on the order the agent read them in."
  // Kind: metamorphic (reordering the reads changes at most the display order)
  test("R5: reading the same files in another order gives the same files and token counts", () => {
    const reads = fc.array(read(anySpelling), { minLength: 1, maxLength: 8 })
    const reordered = reads.chain((list) =>
      fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length })),
    )
    fc.assert(
      fc.property(reordered, ([original, shuffled]) => {
        const before = context(original.map((item) => [item]))
        const after = context(shuffled.map((item) => [item]))
        expect(byPath(after)).toEqual(byPath(before))
      }),
      { numRuns: RUNS },
    )
    passed("R5: read order changes only the display order")
  })

  // R6 (revised in P4B): "A file's token count is the length of the text the agent read for it, divided by 4 and
  // rounded up, so doubling that text doubles the count, give or take one token of rounding."
  // Kind: metamorphic (doubling the input text doubles the output count)
  test("R6: doubling the text the agent read doubles each file's token count", () => {
    const reads = fc.array(fc.array(read(anySpelling), { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 5 })
    fc.assert(
      fc.property(reads, (turns) => {
        const doubled = turns.map((calls) => calls.map((item) => ({ ...item, text: item.text + item.text })))
        const before = context(turns)
        const after = context(doubled)
        expect(after.map((entry) => entry.path)).toEqual(before.map((entry) => entry.path))
        after.forEach((entry, index) => {
          const tokens = before[index]!.tokens
          expect(entry.tokens).toBeGreaterThanOrEqual(2 * tokens - 1)
          expect(entry.tokens).toBeLessThanOrEqual(2 * tokens)
        })
      }),
      { numRuns: RUNS },
    )
    passed("R6: doubling the read text doubles the token count")
  })

  // R8 (revised in P4B): "/context lists exactly the files whose read, edit or write text is still in the model's
  // context: one entry per file, in the order first read, each with its text length divided by 4, rounded up. Reads
  // removed by compaction, and tools that don't open files, add nothing."
  // Kind: model / oracle (compared against a plain loop over the tool calls)
  test("R8: /context matches a simple count over the file tool calls still in context", () => {
    fc.assert(
      fc.property(session(file), (turns) => {
        const order: string[] = []
        const chars: Record<string, number> = {}
        for (const item of turns.flat()) {
          if (item.tool === "bash") continue
          if (item.tool === "read" && item.pruned) continue
          const added = item.tool === "edit" ? item.oldString.length + item.newString.length : item.text.length
          const key = path.resolve(cwd, item.filePath)
          if (!(key in chars)) order.push(key)
          chars[key] = (chars[key] ?? 0) + added
        }
        const expected = order.map((key) => ({ path: key, tokens: Math.ceil(chars[key]! / 4) }))
        const actual = context(turns).map((entry) => ({ path: path.resolve(cwd, entry.path), tokens: entry.tokens }))
        expect(actual).toEqual(expected)
      }),
      { numRuns: RUNS },
    )
    passed("R8: matches the oracle over file tool calls")
  })
})
