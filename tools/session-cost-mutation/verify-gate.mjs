import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import config from "../../packages/tui/stryker.config.mjs"

const source = fileURLToPath(new URL("../../packages/tui/", import.meta.url))
const cli = fileURLToPath(new URL("./node_modules/@stryker-mutator/core/bin/stryker.js", import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), "wingit-mutation-gate-"))
const before = createHash("sha256")
  .update(readFileSync(join(source, "test/util/session-cost.test.ts")))
  .digest("hex")

try {
  ;["src/util/session-cost.ts", "bunfig.mutation.toml", "stryker.config.mjs", "tsconfig.mutation.json"].forEach(
    (path) => {
      mkdirSync(dirname(join(temporary, path)), { recursive: true })
      copyFileSync(join(source, path), join(temporary, path))
    },
  )
  mkdirSync(join(temporary, "test/util"), { recursive: true })
  writeFileSync(
    join(temporary, "test/util/session-cost.test.ts"),
    'import { expect, test } from "bun:test"\n' +
      'import { createSessionCostLedger } from "../../src/util/session-cost"\n' +
      'test("deliberately weak control", () => expect(typeof createSessionCostLedger).toBe("function"))\n',
  )
  const result = spawnSync(process.execPath, [cli, "run"], { cwd: temporary, encoding: "utf8", timeout: 120000 })
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true })
  writeFileSync(
    new URL("./reports/weakened-tests.log", import.meta.url),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  )
  if (result.error) throw result.error

  const report = JSON.parse(readFileSync(join(temporary, "reports/mutation/mutation.json"), "utf8"))
  const mutants = Object.values(report.files).flatMap((file) => file.mutants)
  const detected = mutants.filter((mutant) => ["Killed", "Timeout"].includes(mutant.status)).length
  const survived = mutants.filter((mutant) => ["Survived", "NoCoverage"].includes(mutant.status)).length
  const score = (100 * detected) / (detected + survived)
  const after = createHash("sha256")
    .update(readFileSync(join(source, "test/util/session-cost.test.ts")))
    .digest("hex")
  const evidence = {
    expectedExitCode: 1,
    actualExitCode: result.status,
    mutants: mutants.length,
    detected,
    survived,
    mutationScore: score,
    breakThreshold: config.thresholds.break,
    originalTestsUnchanged: before === after,
  }
  writeFileSync(new URL("./reports/gate-verification.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
  if (result.status !== 1 || survived === 0 || !(score < config.thresholds.break) || before !== after) {
    throw new Error("The weakened tests did not fail the mutation-score gate as expected")
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
