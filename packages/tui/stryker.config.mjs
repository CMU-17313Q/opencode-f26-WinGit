export default {
  $schema: "../../tools/session-cost-mutation/node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "command",
  commandRunner: {
    command: "bun --no-env-file --config=bunfig.mutation.toml test test/util/session-cost.test.ts",
  },
  coverageAnalysis: "off",
  tsconfigFile: "tsconfig.mutation.json",
  mutate: ["src/util/session-cost.ts"],
  concurrency: 2,
  reporters: ["clear-text", "json", "html"],
  thresholds: { high: 90, low: 80, break: 80 },
  timeoutMS: 10000,
  dryRunTimeoutMinutes: 1,
}
