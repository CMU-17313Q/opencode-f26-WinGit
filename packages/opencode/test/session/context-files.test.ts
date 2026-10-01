import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Provider } from "@/provider/provider"

const sessionID = SessionID.make("ses_context")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Context fixture",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function tool(name: string, filePath: string, output = "", input: Record<string, unknown> = {}): SessionV1.ToolPart {
  const id = PartID.ascending()
  return {
    id,
    messageID: MessageID.make("msg_fixture"),
    sessionID,
    type: "tool",
    callID: id,
    tool: name,
    state: {
      status: "completed",
      input: { filePath, ...input },
      output,
      title: name,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function assistant(id: string, created: number, ...parts: SessionV1.Part[]): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      parentID: MessageID.make("msg_parent"),
      sessionID,
      role: "assistant",
      time: { created },
      modelID: model.id,
      providerID: model.providerID,
      agent: "build",
      mode: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}

function compact(id: string, created: number, tail?: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: MessageID.make(id),
        sessionID,
        type: "compaction",
        auto: true,
        ...(tail ? { tail_start_id: MessageID.make(tail) } : {}),
      },
    ],
  }
}

function summary(id: string, created: number, parent: string, finished = true): SessionV1.WithParts {
  const message = assistant(id, created)
  if (message.info.role === "assistant") {
    message.info.parentID = MessageID.make(parent)
    message.info.summary = true
    if (finished) message.info.finish = "stop"
  }
  return message
}

function retained(messages: SessionV1.WithParts[]) {
  return MessageV2.contextFiles(MessageV2.filterCompacted(messages.toReversed()))
}

describe("retained file-tool context", () => {
  test("ignores non-file tools, user-only parts and missing file paths", () => {
    const missing = tool("read", "", "untracked")
    expect(retained([compact("msg_user", 0), assistant("msg_a", 1, tool("bash", "a.ts", "ignored"), missing)])).toEqual(
      [],
    )
    expect(MessageV2.contextFiles([])).toEqual([])
  })

  test("sums retained read, write and edit text without duplicating paths or changing first appearance", () => {
    const messages = [
      assistant("msg_z", 1, tool("read", "packages/a.ts", "a".repeat(40)), tool("read", "b.ts", "b".repeat(8))),
      assistant("msg_a", 2, tool("read", "packages/a.ts", "a".repeat(400))),
      assistant(
        "msg_b",
        3,
        tool("edit", "packages/a.ts", "Edit applied successfully.", { oldString: "old!", newString: "new!" }),
        tool("write", "c.ts", "Wrote file successfully.", { content: "x".repeat(20) }),
        tool("edit", "d.ts", "done", { oldString: "old!", newString: "next" }),
      ),
    ]
    expect(retained(messages)).toEqual([
      { path: "packages/a.ts", tokens: 112 },
      { path: "b.ts", tokens: 2 },
      { path: "c.ts", tokens: 5 },
      { path: "d.ts", tokens: 2 },
    ])
    expect(MessageV2.contextFiles(messages.toReversed())).toEqual(retained(messages))
  })

  test("drops pruned read output, preserves surviving input contributions, and counts a later reread", async () => {
    const read = tool("read", "a.ts", "removed".repeat(100))
    if (read.state.status === "completed") read.state.time.compacted = 3
    const write = tool("write", "written.ts", "removed", { content: "kept" })
    if (write.state.status === "completed") write.state.time.compacted = 3
    const edit = tool("edit", "a.ts", "removed", { oldString: "old!", newString: "next" })
    if (edit.state.status === "completed") edit.state.time.compacted = 3
    expect(retained([assistant("msg_pruned", 1, read)])).toEqual([])

    const messages = [
      assistant("msg_pruned", 1, read, write, edit),
      assistant("msg_reread", 2, tool("read", "a.ts", "new text")),
    ]
    expect(retained(messages)).toEqual([
      { path: "written.ts", tokens: 1 },
      { path: "a.ts", tokens: 4 },
    ])
    const replay = await MessageV2.toModelMessages(messages, model)
    expect(JSON.stringify(replay)).not.toContain("removedremoved")
    expect(JSON.stringify(replay)).toContain("[Old tool result content cleared]")
    expect(JSON.stringify(replay)).toContain('"content":"kept"')
    expect(JSON.stringify(replay)).toContain('"oldString":"old!"')
  })

  test("preserves earlier valid content when a later read was pruned", () => {
    const pruned = tool("read", "a.ts", "gone".repeat(100))
    if (pruned.state.status === "completed") pruned.state.time.compacted = 3
    expect(retained([assistant("msg_a", 1, tool("read", "a.ts", "kept")), assistant("msg_b", 2, pruned)])).toEqual([
      { path: "a.ts", tokens: 1 },
    ])
  })

  test("retains interrupted read output and write/edit inputs, without counting read errors or unfinished reads", async () => {
    const partial = tool("read", "partial.ts")
    partial.state = {
      status: "error",
      input: { filePath: "partial.ts" },
      error: "interrupted",
      metadata: { interrupted: true, output: "part" },
      time: { start: 1, end: 2 },
    }
    const failed = tool("read", "failed.ts")
    failed.state = { ...partial.state, input: { filePath: "failed.ts" }, metadata: {} }
    const running = tool("read", "running.ts")
    running.state = { status: "running", input: { filePath: "running.ts" }, time: { start: 1 } }
    const write = tool("write", "write.ts")
    write.state = { ...partial.state, input: { filePath: "write.ts", content: "body" }, metadata: {} }
    const edit = tool("edit", "edit.ts")
    edit.state = { status: "pending", input: { filePath: "edit.ts", oldString: "old!", newString: "next" }, raw: "" }
    const messages = [assistant("msg_a", 1, partial, failed, running, write, edit)]
    expect(retained(messages)).toEqual([
      { path: "partial.ts", tokens: 1 },
      { path: "write.ts", tokens: 1 },
      { path: "edit.ts", tokens: 2 },
    ])
    const replay = await MessageV2.toModelMessages(messages, model)
    expect(JSON.stringify(replay)).toContain('"value":"part"')
    expect(JSON.stringify(replay)).toContain('"content":"body"')
    expect(JSON.stringify(replay)).toContain('"newString":"next"')
  })

  test("uses the same failed-assistant and aborted-assistant policy as model conversion", async () => {
    const failed = assistant("msg_failed", 1, tool("read", "failed.ts", "lost"))
    const aborted = assistant("msg_aborted", 2, tool("read", "aborted.ts", "kept"))
    if (failed.info.role === "assistant")
      failed.info.error = new SessionV1.APIError({ message: "failure", isRetryable: true }).toObject()
    if (aborted.info.role === "assistant")
      aborted.info.error = new SessionV1.AbortedError({ message: "aborted" }).toObject()
    expect(retained([failed, aborted])).toEqual([{ path: "aborted.ts", tokens: 1 }])
    const replay = JSON.stringify(await MessageV2.toModelMessages([failed, aborted], model))
    expect(replay).not.toContain("failed.ts")
    expect(replay).toContain("aborted.ts")
  })

  test("uses completed compaction boundaries and preserves the retained tail", () => {
    const before = assistant("msg_old", 1, tool("read", "old.ts", "old!"))
    const tail = assistant("msg_tail", 2, tool("read", "kept.ts", "kept"))
    const after = assistant("msg_after", 5, tool("read", "new.ts", "new!"))
    expect(retained([before, compact("msg_compact", 3), summary("msg_summary", 4, "msg_compact"), after])).toEqual([
      { path: "new.ts", tokens: 1 },
    ])
    expect(
      retained([before, tail, compact("msg_compact", 3, "msg_tail"), summary("msg_summary", 4, "msg_compact"), after]),
    ).toEqual([
      { path: "kept.ts", tokens: 1 },
      { path: "new.ts", tokens: 1 },
    ])
  })

  test("does not drop history for unfinished or failed compaction summaries", () => {
    const before = assistant("msg_old", 1, tool("read", "old.ts", "old!"))
    const unfinished = summary("msg_summary", 3, "msg_compact", false)
    expect(retained([before, compact("msg_compact", 2), unfinished])).toEqual([{ path: "old.ts", tokens: 1 }])
    const failed = summary("msg_failed_summary", 3, "msg_compact")
    if (failed.info.role === "assistant")
      failed.info.error = new SessionV1.APIError({ message: "failed summary", isRetryable: true }).toObject()
    expect(retained([before, compact("msg_compact", 2), failed])).toEqual([{ path: "old.ts", tokens: 1 }])
  })

  test("uses only the latest successful compaction when later compaction is unfinished", () => {
    expect(
      retained([
        assistant("msg_a", 1, tool("read", "a.ts", "old!")),
        compact("msg_c1", 2),
        summary("msg_s1", 3, "msg_c1"),
        assistant("msg_b", 4, tool("read", "b.ts", "old!")),
        compact("msg_c2", 5),
        summary("msg_s2", 6, "msg_c2"),
        assistant("msg_c", 7, tool("read", "c.ts", "kept")),
        compact("msg_c3", 8),
        summary("msg_s3", 9, "msg_c3", false),
      ]),
    ).toEqual([{ path: "c.ts", tokens: 1 }])
  })
})
