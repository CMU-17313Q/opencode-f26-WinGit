import { readFileSync } from "node:fs"

const report = JSON.parse(readFileSync(process.argv[2], "utf8"))
const order = ["critical", "high", "medium", "low"]
const findings = report.data.flatMap((file) =>
  file.results
    .filter((result) => result.vulnerabilities?.length)
    .map((result) => ({
      component: result.component,
      version: result.version,
      severity: order.find((level) => result.vulnerabilities.some((v) => v.severity === level)) ?? "unknown",
      count: result.vulnerabilities.length,
    })),
)
const unique = [...new Map(findings.map((f) => [`${f.component}@${f.version}`, f])).values()]

console.log(`Retire.js ${report.version}: ${unique.length} vulnerable component(s)`)
unique.forEach((f) => console.log(`- ${f.component}@${f.version}: ${f.count} advisory(ies), severity ${f.severity}`))
