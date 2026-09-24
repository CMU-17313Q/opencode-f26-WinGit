import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { contextFiles } from "../../src/util/context-files"

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

describe("util.contextFiles", () => {
  test("returns nothing for a session with no parts", () => {
    expect(contextFiles([])).toEqual([])
  })

  test("ignores parts that are not file tools", () => {
    expect(contextFiles([text(), tool("bash", undefined)])).toEqual([])
  })

  test("lists a file that was read", () => {
    expect(contextFiles([tool("read", "src/app.ts", "a".repeat(400))])).toEqual([{ path: "src/app.ts", tokens: 100 }])
  })

  test("keeps the order files were added, most recent last", () => {
    const result = contextFiles([tool("read", "a.ts"), tool("read", "b.ts"), tool("edit", "c.ts")])
    expect(result.map((item) => item.path)).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  test("lists a file read twice only once, in its original position", () => {
    const result = contextFiles([tool("read", "a.ts"), tool("read", "b.ts"), tool("read", "a.ts")])
    expect(result.map((item) => item.path)).toEqual(["a.ts", "b.ts"])
  })

  test("uses the most recent read when a file is read twice", () => {
    const result = contextFiles([tool("read", "a.ts", "x".repeat(40)), tool("read", "a.ts", "x".repeat(400))])
    expect(result).toEqual([{ path: "a.ts", tokens: 100 }])
  })

  test("tracks files from read, edit and write", () => {
    const result = contextFiles([tool("read", "a.ts"), tool("edit", "b.ts"), tool("write", "c.ts")])
    expect(result.map((item) => item.path)).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  test("skips tool calls that have not completed", () => {
    expect(contextFiles([running("read", "a.ts")])).toEqual([])
  })

  test("skips file tools with no path", () => {
    expect(contextFiles([tool("read", undefined)])).toEqual([])
  })

  test("keeps paths from different packages separate", () => {
    const result = contextFiles([tool("read", "packages/tui/src/app.ts"), tool("read", "packages/core/src/app.ts")])
    expect(result.map((item) => item.path)).toEqual(["packages/tui/src/app.ts", "packages/core/src/app.ts"])
  })
})
