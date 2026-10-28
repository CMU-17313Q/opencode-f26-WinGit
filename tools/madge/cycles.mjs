import madge from "madge"

// Madge only needs the TypeScript parser here. Type-only imports are skipped
// because they disappear at runtime and cannot cause initialization problems.
const options = {
  fileExtensions: ["ts", "tsx"],
  includeNpm: false,
  detectiveOptions: {
    ts: { skipTypeImports: true },
    tsx: { skipTypeImports: true },
  },
}

// Turns a cycle into a stable key: forward slashes, starting at the smallest path.
export function cycleKey(cycle) {
  const files = cycle.map((file) => file.replaceAll("\\", "/"))
  const start = files.indexOf([...files].sort()[0])
  return [...files.slice(start), ...files.slice(0, start)].join(" > ")
}

// The repo's `export * as Foo from "./foo"` convention makes a file import
// itself. Madge reports that as a one-file cycle, which is not a real cycle.
export async function findCycles(dir) {
  const result = await madge(dir, options)
  const all = result.circular()
  const real = all.filter((cycle) => cycle.length > 1)
  return {
    keys: real.map(cycleKey).sort(),
    selfReexports: all.length - real.length,
  }
}

export function compare(found, baseline) {
  return {
    added: found.filter((key) => !baseline.includes(key)),
    resolved: baseline.filter((key) => !found.includes(key)),
  }
}
