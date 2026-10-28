import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { compare, cycleKey, findCycles } from "../cycles.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = (name) => path.join(root, "fixtures", name)

function run(dir, baseline) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "check-cycles.mjs"), fixture(dir), "--baseline", fixture(baseline)],
    { encoding: "utf8" },
  )
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test("a project without cycles passes", async () => {
  const found = await findCycles(fixture("clean"))
  assert.deepEqual(found.keys, [])
  assert.equal(run("clean", "baseline-empty.json").code, 0)
})

test("a new two-file cycle fails the check and names both files", async () => {
  const found = await findCycles(fixture("cycle"))
  assert.deepEqual(found.keys, ["a.ts > b.ts"])
  const result = run("cycle", "baseline-empty.json")
  assert.equal(result.code, 1)
  assert.match(result.err, /a\.ts > b\.ts/)
})

test("a cycle that is listed in the baseline passes", () => {
  assert.equal(run("cycle", "baseline-cycle.json").code, 0)
})

test("a file that re-exports itself is not reported as a cycle", async () => {
  const found = await findCycles(fixture("self-reexport"))
  assert.deepEqual(found.keys, [])
  assert.equal(found.selfReexports, 1)
  assert.equal(run("self-reexport", "baseline-empty.json").code, 0)
})

test("a loop made only of type imports is not reported", async () => {
  const found = await findCycles(fixture("type-only"))
  assert.deepEqual(found.keys, [])
  assert.equal(run("type-only", "baseline-empty.json").code, 0)
})

test("a baseline entry that no longer exists passes and is reported for removal", () => {
  const result = run("clean", "baseline-stale.json")
  assert.equal(result.code, 0)
  assert.match(result.out, /gone\.ts > other\.ts/)
})

test("the same cycle gets the same key whichever file it starts at", () => {
  assert.equal(cycleKey(["b.ts", "c.ts", "a.ts"]), "a.ts > b.ts > c.ts")
  assert.equal(cycleKey(["a.ts", "b.ts", "c.ts"]), "a.ts > b.ts > c.ts")
})

test("compare splits new and resolved cycles", () => {
  assert.deepEqual(compare(["a > b", "c > d"], ["c > d", "e > f"]), {
    added: ["a > b"],
    resolved: ["e > f"],
  })
})
