# Madge circular dependency check

This is Mohammed Al-Ali's individual static quality check for Project 3. It uses [Madge](https://github.com/pahen/madge), which is not on the assignment's starter list.

## What the check does

Madge reads the import statements of every file and builds a graph of which file depends on which. A circular dependency is a loop in that graph: file A imports B, and B imports A, directly or through other files. Loops can cause confusing start-up problems, because one file may run before the file it needs has finished loading, and they make code harder to change.

The type checker and unit tests do not report these loops, so this check adds coverage they do not have.

## Scope

The check scans `packages/tui/src` (about 190 files). It is a manageable part of the application, and its imports are relative paths that Madge can follow.

Two behaviors are tuned for this repository:

- **Type-only imports are skipped.** `import type { X } from "../builtins"` disappears when the code is compiled, so it cannot cause a start-up problem. Without this setting Madge reports 17 loops in the TUI, most of them `builtins.ts` with its plugins. With it, 5 remain.
- **One-file "loops" are ignored.** The repository's style guide has files end with `export * as Foo from "./foo"`, so a file imports itself. Madge reports this as a loop of one file. These are not real problems. Four such files are ignored.

That leaves one real loop, `component/dialog-model.tsx` and `component/dialog-provider.tsx`. The model dialog opens the provider dialog so a user can connect a provider, and the provider dialog opens the model dialog afterwards. Each import is only used inside a click handler, so it works today. Breaking it would mean changing user interface code only to satisfy a check, so it is recorded in `baseline.json` as a known loop.

## How it decides pass or fail

`check-cycles.mjs` compares the loops it finds with `baseline.json`:

- A loop that is **not** in the baseline fails the check and the file names are printed.
- A loop that is in the baseline passes.
- A baseline entry that no longer exists is reported so it can be removed. This does not fail the check.

This way the existing loop does not block anyone, but a new one cannot be added unnoticed. To accept a new loop on purpose, add it to `baseline.json` in the same pull request so a reviewer sees it.

## When it runs and merge policy

The workflow `.github/workflows/madge.yml` runs on pull requests, pushes to `main` and manual runs. A failed job stays visible. It is advisory for merging until the team agrees to make it a required check, which is a branch-protection setting this contribution does not change.

## Local use

Use Node 22 or newer. From this folder:

```bash
npm ci --ignore-scripts
npm test
npm run check
```

`npm test` runs the check against small fixture projects in `fixtures/`: no loop, a real loop, a loop listed in the baseline, a file that re-exports itself, a loop made only of type imports, and a baseline entry that is out of date. `npm run check` scans the real TUI source. The tool has its own lockfile, so Madge 8.0.0 and TypeScript 5.9.3 are not added to the application's dependencies.

## Limits

- Only `packages/tui/src` is scanned. `packages/opencode/src` uses the `@/` import alias, which Madge skips unless it is configured, so loops through those imports would be missed. It can be added later with an alias-aware configuration.
- Imports of other workspace packages (for example `@opencode-ai/core`) are not followed, so loops that cross package boundaries are not detected.
- Madge finds loops in static imports. It does not see imports created at run time.
- The check does not say whether a loop is harmful, only that it exists. A human decides whether to fix it.
