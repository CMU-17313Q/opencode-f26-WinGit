import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { contextFileRows } from "../../src/component/dialog-context"
import { contextFiles } from "../../src/util/context-files"

function read(filePath: string, output: string) {
  return { type: "tool", tool: "read", state: { status: "completed", input: { filePath }, output } } as unknown as Part
}

describe("dialog context", () => {
  test("shows one row per tracked file, in the same order", () => {
    const files = contextFiles([
      {
        info: { id: "m1", role: "assistant" } as Message,
        parts: [read("a.ts", "x".repeat(40)), read("b.ts", "x".repeat(8000)), read("a.ts", "x".repeat(40))],
      },
    ])

    expect(contextFileRows(files)).toEqual([
      { path: "a.ts", size: "~10 tokens" },
      { path: "b.ts", size: "~2,000 tokens" },
    ])
  })

  test("shows no rows when nothing is in context", () => {
    expect(contextFileRows(contextFiles([]))).toEqual([])
  })
})
