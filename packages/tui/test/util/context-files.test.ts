import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { contextFiles, type MessageWithParts } from "../../src/util/context-files"

function tool(name: string, filePath: string | undefined, output = "") {
  return {
    type: "tool",
    tool: name,
    state: {
      status: "completed",
      input: filePath === undefined ? {} : { filePath },
      output,
    },
  } as Part
}

function running(name: string, filePath: string) {
  return {
    type: "tool",
    tool: name,
    state: { status: "running", input: { filePath } },
  } as unknown as Part
}

function text() {
  return { type: "text", text: "hello" } as Part
}

function assistant(id: string, ...parts: Part[]): MessageWithParts {
  return { info: { id, role: "assistant" } as Message, parts }
}

function compaction(id: string, tailStartID?: string): MessageWithParts {
  return {
    info: { id, role: "user" } as Message,
    parts: [{ type: "compaction", auto: true, tail_start_id: tailStartID } as Part],
  }
}

function summary(id: string, parentID: string, finished = true): MessageWithParts {
  return {
    info: { id, role: "assistant", summary: true, parentID, finish: finished ? "stop" : undefined } as Message,
    parts: [],
  }
}

function paths(messages: MessageWithParts[]) {
  return contextFiles(messages).map((item) => item.path)
}

describe("util.contextFiles", () => {
  test("returns nothing for a session with no messages", () => {
    expect(contextFiles([])).toEqual([])
  })

  test("ignores parts that are not file tools", () => {
    expect(contextFiles([assistant("m1", text(), tool("bash", undefined))])).toEqual([])
  })

  test("lists a file that was read", () => {
    expect(contextFiles([assistant("m1", tool("read", "src/app.ts", "a".repeat(400)))])).toEqual([
      { path: "src/app.ts", tokens: 100 },
    ])
  })

  test("keeps the order files were added, most recent last", () => {
    const messages = [
      assistant("m1", tool("read", "a.ts"), tool("read", "b.ts")),
      assistant("m2", tool("edit", "c.ts")),
    ]
    expect(paths(messages)).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  test("lists a file read twice only once, in its original position", () => {
    const messages = [
      assistant("m1", tool("read", "a.ts"), tool("read", "b.ts")),
      assistant("m2", tool("read", "a.ts")),
    ]
    expect(paths(messages)).toEqual(["a.ts", "b.ts"])
  })

  test("uses the most recent read when a file is read twice", () => {
    const messages = [
      assistant("m1", tool("read", "a.ts", "x".repeat(40))),
      assistant("m2", tool("read", "a.ts", "x".repeat(400))),
    ]
    expect(contextFiles(messages)).toEqual([{ path: "a.ts", tokens: 100 }])
  })

  test("tracks files from read, edit and write", () => {
    expect(paths([assistant("m1", tool("read", "a.ts"), tool("edit", "b.ts"), tool("write", "c.ts"))])).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ])
  })

  test("skips tool calls that have not completed", () => {
    expect(contextFiles([assistant("m1", running("read", "a.ts"))])).toEqual([])
  })

  test("skips file tools with no path", () => {
    expect(contextFiles([assistant("m1", tool("read", undefined))])).toEqual([])
  })

  test("keeps paths from different packages separate", () => {
    const messages = [
      assistant("m1", tool("read", "packages/tui/src/app.ts"), tool("read", "packages/core/src/app.ts")),
    ]
    expect(paths(messages)).toEqual(["packages/tui/src/app.ts", "packages/core/src/app.ts"])
  })

  test("drops files that were summarized away by compaction", () => {
    const messages = [
      assistant("m1", tool("read", "old.ts")),
      compaction("m2"),
      summary("m3", "m2"),
      assistant("m4", tool("read", "new.ts")),
    ]
    expect(paths(messages)).toEqual(["new.ts"])
  })

  test("keeps files from the tail that compaction retained", () => {
    const messages = [
      assistant("m1", tool("read", "old.ts")),
      assistant("m2", tool("read", "kept.ts")),
      compaction("m3", "m2"),
      summary("m4", "m3"),
      assistant("m5", tool("read", "new.ts")),
    ]
    expect(paths(messages)).toEqual(["kept.ts", "new.ts"])
  })

  test("ignores a compaction whose summary has not finished", () => {
    const messages = [assistant("m1", tool("read", "old.ts")), compaction("m2"), summary("m3", "m2", false)]
    expect(paths(messages)).toEqual(["old.ts"])
  })

  test("uses only the latest compaction", () => {
    const messages = [
      assistant("m1", tool("read", "a.ts")),
      compaction("m2"),
      summary("m3", "m2"),
      assistant("m4", tool("read", "b.ts")),
      compaction("m5"),
      summary("m6", "m5"),
      assistant("m7", tool("read", "c.ts")),
    ]
    expect(paths(messages)).toEqual(["c.ts"])
  })
})
