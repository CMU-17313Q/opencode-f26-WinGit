// Subprocess integration tests for `opencode run --summary`. See
// `test/lib/cli-process.ts` for the harness and `run-process.test.ts` for the
// general pattern this mirrors.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@opencode-ai/sdk/v2"
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
          llm.pushMatch((hit) => JSON.stringify(hit.body).includes(SUMMARY_MARKER), {
            type: "http-error",
            status: 500,
            body: { error: "simulated summary failure" },
          })
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

  for (const failed of [false, true]) {
    cliIt.live(
      `shows a subagent's ${failed ? "summary warning" : "summary"} while keeping its ordinary output private`,
      ({ llm, opencode, home }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(home, "child.txt"), "original child content"))
          yield* llm.push(
            reply().tool("task", {
              description: "Edit the child note",
              prompt: "Edit child.txt",
              subagent_type: "general",
            }),
            reply().tool("edit", {
              filePath: "child.txt",
              oldString: "original child content",
              newString: "updated child content",
            }),
          )
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes(SUMMARY_MARKER),
            failed
              ? { type: "http-error", status: 400, body: { error: "summary unavailable" } }
              : reply().text("CHILD_SUMMARY_MARKER describes the original child note.").stop(),
          )
          yield* llm.text("PRIVATE_CHILD_REPLY")
          yield* llm.text("root finished")

          const result = yield* opencode.run("delegate this edit", {
            extraArgs: ["--summary", "--dangerously-skip-permissions", "--title", "Child summary test", "--dir", home],
          })
          opencode.expectExit(result, 0)
          const marker = failed ? "could not generate a summary" : "CHILD_SUMMARY_MARKER"
          expect(result.stderr.split(marker)).toHaveLength(2)
          expect(result.stdout).toBe("root finished\n")
          expect(result.stderr).not.toContain("PRIVATE_CHILD_REPLY")
          expect(result.stderr).not.toContain("Edit child.txt")
          const hits = yield* llm.hits
          const summaryHit = hits.find((hit) => JSON.stringify(hit.body).includes(SUMMARY_MARKER))
          expect(JSON.stringify(summaryHit?.body)).toContain("original child content")
          expect(JSON.stringify(summaryHit?.body)).not.toContain("updated child content")
          expect(yield* Effect.promise(() => Bun.file(path.join(home, "child.txt")).text())).toBe(
            "updated child content",
          )
        }),
      60_000,
    )
  }

  for (const format of ["default", "json"] as const) {
    cliIt.live(
      `replays nested summaries once without leaking unrelated sessions in ${format} output`,
      ({ opencode, home }) =>
        Effect.gen(function* () {
          const tool = (
            sessionID: string,
            id: string,
            name: string,
            metadata: Record<string, unknown>,
            input: Record<string, unknown>,
          ): Event => ({
            id: `event-${sessionID}-${id}`,
            type: "message.part.updated",
            properties: {
              sessionID,
              time: 1,
              part: {
                id,
                sessionID,
                messageID: `message-${sessionID}`,
                type: "tool",
                callID: id,
                tool: name,
                state: { status: "running", input, metadata, time: { start: 1 } },
              },
            },
          })
          const child = tool(
            "child",
            "shared-edit-id",
            "edit",
            { summary: "FIRST_LEVEL_SUMMARY" },
            { filePath: "child.txt" },
          )
          const warning = tool(
            "grandchild",
            "failed-edit",
            "edit",
            { summaryFailed: true },
            { filePath: "warning.txt" },
          )
          const text = (sessionID: string, value: string): Event => ({
            id: `event-text-${sessionID}`,
            type: "message.part.updated",
            properties: {
              sessionID,
              time: 2,
              part: {
                id: `text-${sessionID}`,
                sessionID,
                messageID: `message-${sessionID}`,
                type: "text",
                text: value,
                time: { start: 1, end: 2 },
              },
            },
          })
          const permission = (sessionID: string, id: string, name = "protected_branch"): Event => ({
            id: `event-${id}`,
            type: "permission.asked",
            properties: { id, sessionID, permission: name, patterns: ["main"], always: [], metadata: {} },
          })
          const events: Event[] = [
            tool(
              "unrelated",
              "unrelated-task",
              "task",
              { sessionId: "unrelated-child" },
              { description: "Unrelated task", subagent_type: "general" },
            ),
            permission("unrelated-child", "unrelated-protected"),
            tool(
              "unrelated-child",
              "private-edit",
              "edit",
              { summary: "UNRELATED_SUMMARY" },
              { filePath: "private.txt" },
            ),
            tool(
              "root",
              "root-task",
              "task",
              { sessionId: "child" },
              { description: "Root task", subagent_type: "general" },
            ),
            tool(
              "child",
              "child-task",
              "task",
              { sessionId: "grandchild" },
              { description: "Nested task", subagent_type: "general" },
            ),
            permission("child", "child-protected"),
            permission("grandchild", "grandchild-protected"),
            permission("child", "child-bash", "bash"),
            child,
            child,
            tool(
              "grandchild",
              "shared-edit-id",
              "edit",
              { summary: "NESTED_REPLAY_SUMMARY" },
              { filePath: "grandchild.txt" },
            ),
            warning,
            warning,
            text("child", "PRIVATE_CHILD_TEXT"),
            text("unrelated", "UNRELATED_TEXT"),
            {
              id: "event-child-idle",
              type: "session.status",
              properties: { sessionID: "child", status: { type: "idle" } },
            },
            tool("root", "root-edit", "edit", { summary: "ROOT_REPLAY_SUMMARY" }, { filePath: "root.txt" }),
            {
              id: "event-root-edit-complete",
              type: "message.part.updated",
              properties: {
                sessionID: "root",
                time: 2,
                part: {
                  id: "root-edit",
                  sessionID: "root",
                  messageID: "message-root",
                  type: "tool",
                  callID: "root-edit",
                  tool: "edit",
                  state: {
                    status: "completed",
                    input: { filePath: "root.txt" },
                    metadata: {},
                    title: "root.txt",
                    output: "Edit applied successfully.",
                    time: { start: 1, end: 2 },
                  },
                },
              },
            },
            text("root", "ROOT_FINAL"),
            {
              id: "event-permission",
              type: "permission.asked",
              properties: {
                id: "replay-permission",
                sessionID: "root",
                permission: "edit",
                patterns: ["root.txt"],
                always: [],
                metadata: {},
              },
            },
            {
              id: "event-root-idle",
              type: "session.status",
              properties: { sessionID: "root", status: { type: "idle" } },
            },
          ]
          const consumed = Promise.withResolvers<void>()
          const replies: { id: string; reply: string }[] = []
          // Replay server events through the real CLI transport, including events
          // a live single-run fixture cannot naturally produce (duplicates and strangers).
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                async fetch(request) {
                  const url = new URL(request.url)
                  if (url.pathname === "/session/root" && request.method === "GET") {
                    return Response.json({ id: "root", title: "Replay", directory: home })
                  }
                  if (url.pathname === "/config") return Response.json({})
                  if (url.pathname === "/event") {
                    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                      headers: { "content-type": "text/event-stream" },
                    })
                  }
                  if (url.pathname.startsWith("/permission/") && url.pathname.endsWith("/reply")) {
                    const id = url.pathname.split("/")[2]
                    replies.push({ id, reply: (await request.json()).reply })
                    if (id === "replay-permission") consumed.resolve()
                    return Response.json(true)
                  }
                  if (url.pathname === "/session/root/message" && request.method === "POST") {
                    // Attach mode does not await its output loop. A permission
                    // reply acknowledges that all preceding replay events were consumed.
                    await consumed.promise
                    return Response.json({})
                  }
                  return new Response(`Unexpected request: ${request.method} ${url.pathname}`, { status: 404 })
                },
              }),
            ),
            (server) =>
              Effect.promise(async () => {
                await server.stop(true)
              }),
          )
          const result = yield* opencode.run("replay", {
            format,
            extraArgs: [
              "--summary",
              "--dangerously-skip-permissions",
              "--attach",
              server.url.toString(),
              "--session",
              "root",
              "--dir",
              home,
            ],
          })
          opencode.expectExit(result, 0)
          expect(replies).toEqual([
            { id: "child-protected", reply: "once" },
            { id: "grandchild-protected", reply: "once" },
            { id: "replay-permission", reply: "once" },
          ])
          for (const marker of [
            "FIRST_LEVEL_SUMMARY",
            "NESTED_REPLAY_SUMMARY",
            "ROOT_REPLAY_SUMMARY",
            "could not generate a summary for warning.txt",
          ]) {
            expect(result.stderr.split(marker)).toHaveLength(2)
          }
          for (const marker of ["UNRELATED_SUMMARY", "UNRELATED_TEXT", "PRIVATE_CHILD_TEXT", "Nested task"]) {
            expect(result.stdout + result.stderr).not.toContain(marker)
          }
          if (format === "default") {
            expect(result.stdout).toBe("ROOT_FINAL\n")
            const editIndex = result.stderr.indexOf("Edit root.txt")
            expect(editIndex).toBeGreaterThan(result.stderr.indexOf("ROOT_REPLAY_SUMMARY"))
          } else {
            const output = opencode.parseJsonEvents(result.stdout)
            expect(output.map((event) => event.type)).toEqual(["tool_use", "text"])
            expect(output.every((event) => event.sessionID === "root")).toBe(true)
          }
        }),
      60_000,
    )
  }

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
