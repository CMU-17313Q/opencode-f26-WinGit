// Subprocess integration tests for `opencode run --summary`. See
// `test/lib/cli-process.ts` for the harness and `run-process.test.ts` for the
// general pattern this mirrors.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

const SUMMARY_MARKER = "plain-language summary"

describe("opencode run --summary", () => {
  cliIt.live(
    "prints a summary block before the edit output",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(home, "notes.txt"), "original content"))

        yield* llm.push(
          reply().tool("edit", {
            filePath: "notes.txt",
            oldString: "original content",
            newString: "updated content",
          }),
        )
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes(SUMMARY_MARKER),
          "This file stores a short note used by the test fixture.",
        )
        yield* llm.text("done")

        const result = yield* opencode.run("edit the file", {
          extraArgs: ["--summary", "--dangerously-skip-permissions", "--dir", home],
        })

        opencode.expectExit(result, 0)

        // The summarized content must be the file as it existed BEFORE the
        // edit was applied, not the edited result — the tool computes the
        // summary from `contentOld`, before it writes `contentNew`.
        const hits = yield* llm.hits
        const summaryHit = hits.find((hit) => JSON.stringify(hit.body).includes(SUMMARY_MARKER))
        expect(JSON.stringify(summaryHit?.body)).toContain("original content")
        expect(JSON.stringify(summaryHit?.body)).not.toContain("updated content")

        const summaryIndex = result.stderr.indexOf("This file stores a short note")
        const editIndex = result.stderr.indexOf("Edit notes.txt")
        expect(summaryIndex).toBeGreaterThan(-1)
        expect(editIndex).toBeGreaterThan(-1)
        expect(summaryIndex).toBeLessThan(editIndex)
        expect(result.stdout).toBe("done\n")

        const written = yield* Effect.promise(() => Bun.file(path.join(home, "notes.txt")).text())
        expect(written).toBe("updated content")
      }),
    60_000,
  )

  cliIt.live(
    "still applies the edit when summary generation fails",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(home, "notes.txt"), "original content"))

        yield* llm.push(
          reply().tool("edit", {
            filePath: "notes.txt",
            oldString: "original content",
            newString: "updated content",
          }),
        )
        // The AI SDK retries a 5xx a few times before giving up — queue enough
        // failures that every retry attempt (not just the first) fails too.
        const summaryFailure = () =>
          llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes(SUMMARY_MARKER),
            { type: "http-error", status: 500, body: { error: "simulated summary failure" } },
          )
        yield* summaryFailure()
        yield* summaryFailure()
        yield* summaryFailure()
        yield* summaryFailure()
        yield* llm.text("done")

        const result = yield* opencode.run("edit the file", {
          extraArgs: ["--summary", "--dangerously-skip-permissions", "--dir", home],
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).not.toContain(SUMMARY_MARKER)
        expect(result.stderr).toContain("could not generate a summary")

        const written = yield* Effect.promise(() => Bun.file(path.join(home, "notes.txt")).text())
        expect(written).toBe("updated content")
      }),
    60_000,
  )

  // Regression: child-session (task/subagent) events arrive on a different
  // sessionID than the top-level run, and used to be filtered out before the
  // --summary rendering block ever saw them — see PR #11 review.
  cliIt.live(
    "shows the summary for an edit made inside a subagent task",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const TASK_PROMPT = "SUBAGENT_EDIT_TASK_MARKER replace original content with updated content"
        const CHILD_SUMMARY = "This file is a tiny fixture used by a subagent regression test."

        yield* Effect.promise(() => Bun.write(path.join(home, "notes.txt"), "original content"))

        const isChildTurn = (hit: { body: Record<string, unknown> }) => {
          const messages = (hit.body as { messages?: Array<{ role?: string; content?: unknown }> }).messages
          const firstUser = messages?.find((m) => m.role === "user")
          return typeof firstUser?.content === "string" && firstUser.content.includes("SUBAGENT_EDIT_TASK_MARKER")
        }

        // Parent's first turn: delegate to a subagent.
        yield* llm.push(
          reply().tool("task", {
            description: "edit the file",
            prompt: TASK_PROMPT,
            subagent_type: "general",
          }),
        )
        // Child's first turn: edit the file.
        yield* llm.pushMatch(
          isChildTurn,
          reply().tool("edit", {
            filePath: "notes.txt",
            oldString: "original content",
            newString: "updated content",
          }),
        )
        // The edit tool's own summarize call, made from inside the child session.
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(SUMMARY_MARKER), CHILD_SUMMARY)
        // Child's second turn: report back to the parent.
        yield* llm.textMatch(isChildTurn, "subagent finished")
        // Parent's final turn, after the task tool result.
        yield* llm.text("parent done")

        const result = yield* opencode.run("use a subagent to edit the file", {
          extraArgs: ["--summary", "--dangerously-skip-permissions", "--dir", home],
        })

        opencode.expectExit(result, 0)

        // Rendering a nested edit's own diff is out of scope (only the
        // summary is surfaced for a descendant session) — the subagent's
        // completion still shows as the task tool's own "done" line. Assert
        // the summary printed, and before that completion line.
        const summaryIndex = result.stderr.indexOf(CHILD_SUMMARY)
        const taskDoneIndex = result.stderr.indexOf("edit the file", summaryIndex + CHILD_SUMMARY.length)
        expect(summaryIndex).toBeGreaterThan(-1)
        expect(taskDoneIndex).toBeGreaterThan(-1)

        const written = yield* Effect.promise(() => Bun.file(path.join(home, "notes.txt")).text())
        expect(written).toBe("updated content")
      }),
    60_000,
  )
})
