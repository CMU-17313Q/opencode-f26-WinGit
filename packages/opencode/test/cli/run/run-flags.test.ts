import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { RunCommand } from "../../../src/cli/cmd/run"

async function parse(argv: string[]) {
  return yargs([])
    .command({ ...RunCommand, handler: () => {} })
    .exitProcess(false)
    .parse(argv)
}

describe("run --summary flag", () => {
  test("defaults to false", async () => {
    const args = await parse(["run", "hello"])
    expect(args.summary).toBe(false)
  })

  test("is set to true when passed", async () => {
    const args = await parse(["run", "--summary", "hello"])
    expect(args.summary).toBe(true)
    expect(args.message).toEqual(["hello"])
  })

  test("supports explicit negation", async () => {
    const args = await parse(["run", "--summary", "--no-summary", "hello"])
    expect(args.summary).toBe(false)
  })
})
