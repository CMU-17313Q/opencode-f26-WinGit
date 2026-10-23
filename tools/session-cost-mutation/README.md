# Session cost mutation check

This is Chenyu Qiu's individual dynamic quality check for Project 3. It uses StrykerJS, which is on the assignment's starter list. The team still needs another check outside that list.

## What the check does

Stryker makes small changes, called mutants, to a temporary copy of the code. It then runs tests to see whether they notice each change. A mutant is killed when the tests detect it. A surviving mutant may show a missing test or a change that does not affect behavior. See the [official project](https://github.com/stryker-mutator/stryker-js) and [configuration guide](https://stryker-mutator.io/docs/stryker-js/configuration/).

The scope is [session-cost.ts](../../packages/tui/src/util/session-cost.ts), using the existing [Bun accounting tests](../../packages/tui/test/util/session-cost.test.ts). These tests exercise the real helper, including duplicate usage events, other sessions, missing prices, and title and summary usage. This check does not change the product feature or make paid AI calls.

## Why this check

A passing test suite does not show whether its assertions can catch wrong calculations. Mutation testing adds that check. Session cost is a useful small target because incorrect totals or duplicate charges can mislead users.

The main cost is runtime: the command runner executes the selected test file for every mutant. Limiting the scope keeps this manageable. Some mutants may behave the same as the original code, so a low score needs review, not automatic changes made only to improve the number. This check does not test the whole TUI, backend, or real provider bills. It complements normal tests and type checking.

## When it runs and merge policy

The workflow runs on pull requests, pushes to `main`, and manual runs. The job fails if the mutation score is below 80%; failures remain visible, without `continue-on-error`.

The check is initially advisory for merge decisions until the team agrees to make it required. A failed job and a required branch check are different things. This contribution does not change branch protection or repository administrator settings.

## Configuration and local use

Use Node 24.15.0 and Bun 1.3.14 to match CI. The tool package requires Node 24.11.0 or newer. Its own npm lockfile pins StrykerJS 10.0.0 and TypeScript 5.8.2 without adding them to the application's dependency list.

From the repository root:

```sh
npm ci --prefix tools/session-cost-mutation --ignore-scripts
npm --prefix tools/session-cost-mutation run test:baseline
npm --prefix tools/session-cost-mutation test
npm --prefix tools/session-cost-mutation run verify:gate
```

The scripts run inside `packages/tui`. [stryker.config.mjs](../../packages/tui/stryker.config.mjs) selects only the cost helper, uses two workers, and sets score thresholds to 90/80 with failure below 80. Coverage analysis is off because the command runner cannot select individual tests from coverage information. The [mutation TypeScript config](../../packages/tui/tsconfig.mutation.json) defines the small input set. The explicit [Bun config](../../packages/tui/bunfig.mutation.toml) avoids the terminal renderer preload. `--no-env-file` avoids loading dotenv files.

## Reports and maintenance

Reports are `packages/tui/reports/mutation/mutation.html` and `packages/tui/reports/mutation/mutation.json`. The workflow uploads these with the baseline log and `tools/session-cost-mutation/reports/gate-verification.json`.

Local verification on 23 October 2026: all 19 accounting tests passed (48 assertions). Stryker generated 220 mutants: 185 were killed and 35 survived, giving 84.09%, above the 80% gate. There were no timeouts or runtime/compile errors. The four added tests improved the original 80.45% score by checking invalid charges, invalid token counters, row ordering and step-before-message events.

The negative control replaces the tests only in a temporary copy with one deliberately weak assertion. Its score fell to 1.36% and Stryker exited with code 1. The verification command passes only when this expected rejection occurs and the original test file is unchanged. A normal passing suite alone cannot demonstrate this failure path.

For a failure, first check the unchanged-code baseline. Then read surviving mutants and add meaningful missing assertions. Explain equivalent mutants before considering exclusions. Review scope and runtime when the helper changes; update the tool lockfile and rerun both commands when upgrading dependencies.

Writing assistance: OpenAI Codex helped draft this explanation using the linked sources and repository configuration.
