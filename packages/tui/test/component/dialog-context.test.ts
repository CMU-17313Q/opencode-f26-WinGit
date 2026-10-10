import { describe, expect, test } from "bun:test"
import { contextFileRows } from "../../src/component/dialog-context"

describe("dialog context", () => {
  test("formats the backend file rows without changing their order or estimates", () => {
    expect(
      contextFileRows([
        { path: "a.ts", tokens: 10 },
        { path: "b.ts", tokens: 2000 },
      ]),
    ).toEqual([
      { path: "a.ts", size: "~10 tokens" },
      { path: "b.ts", size: "~2,000 tokens" },
    ])
  })

  test("shows no rows for an empty result", () => {
    expect(contextFileRows([])).toEqual([])
  })
})
