import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { compare, findCycles } from "./cycles.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = args.indexOf("--baseline")
const baselineFile = flag >= 0 ? args.splice(flag, 2)[1] : path.join(here, "baseline.json")
const dir = args[0]

if (!dir) {
  console.error("Usage: node check-cycles.mjs <source directory> [--baseline <file>]")
  process.exit(2)
}

const baseline = JSON.parse(readFileSync(baselineFile, "utf8")).cycles
const found = await findCycles(dir)
const { added, resolved } = compare(found.keys, baseline)

console.log(`Scanned ${dir}`)
console.log(`Circular dependencies: ${found.keys.length} real, ${found.selfReexports} one-file self re-exports ignored`)
console.log(`Known (baseline): ${baseline.length}`)

if (resolved.length > 0) {
  console.log("\nNo longer present, please remove from baseline.json:")
  for (const key of resolved) console.log(`  - ${key}`)
}

if (added.length > 0) {
  console.error("\nNew circular dependencies found:")
  for (const key of added) console.error(`  - ${key}`)
  console.error("\nBreak the cycle, or add it to baseline.json if it is intentional.")
  process.exit(1)
}

console.log("\nNo new circular dependencies.")
