# User Guide

This document collects, per feature, how to use it and how to test it. Each
team member adds their own section below for the feature they implemented.

---

## `opencode run --summary` — pre-edit file context

**Added by:** Yasa Khan (PR #11, closes #3)

### What it does

When you run opencode non-interactively (`opencode run "..."`) with the
`--summary` flag, and the agent edits an existing file, opencode prints a
short (3-6 sentence) AI-generated summary of that file's purpose and
structure, right before it shows the edit's diff. This gives you context on a
file you may not have opened yourself, especially useful when working in an
unfamiliar codebase or reviewing a long agent run after the fact.

Without the flag, nothing changes — no summary is printed and there is no
added latency or extra model call.

### How to use it

1. Make sure opencode has a working provider configured (`opencode auth
   login`), since generating a summary makes a real model call.
2. Run any edit-triggering prompt with the flag added:

   ```bash
   cd packages/opencode
   echo "print('hello world')" > /tmp/summary-test.py
   bun run --conditions=browser ./src/index.ts run --summary \
     "in /tmp/summary-test.py, change the print statement to say 'hi there' instead"
   ```

3. You should see a block like this, printed **before** the `← Edit` diff:

   ```
   ℹ Summary: /tmp/summary-test.py
   This file is a simple Python script that prints "hello world" to the
   console. It contains only one line of code...
   ```

### How to test it manually

- **Flag on vs. off.** Run the same prompt once with `--summary` and once
  without it. With the flag, the summary block appears before the diff; without
  it, no summary is printed and the run should feel no slower.
- **Failure doesn't block the edit.** Temporarily break your model access
  (invalid key, no network) and run with `--summary`. You should see a
  `could not generate a summary for ...` warning, and the edit should still
  complete normally rather than hang or crash.
- **Help text.** `bun run --conditions=browser ./src/index.ts run --help`
  should list `--summary` with a description.
- **Scope limits to be aware of when testing:** the flag only has an effect in
  non-interactive `opencode run` (not the TUI), it only fires when the agent
  uses the `edit` tool specifically (not `write`, `apply_patch`, or shell
  commands like `sed`), and it is a no-op when attaching to a remote server
  with `--attach`.
- **Subagent edits.** If the agent delegates the edit to a subagent (a `task`
  tool call), the summary for that nested edit still prints, even though it
  comes from a different underlying session than the top-level run.

### Automated tests

| File | What it tests | Why it's there |
| --- | --- | --- |
| [`packages/opencode/test/cli/run/run-flags.test.ts`](packages/opencode/test/cli/run/run-flags.test.ts) | `--summary` parses to `true`/`false`/default via yargs, and `--no-summary` negates it. | Confirms the flag is actually wired into the CLI's option parser before anything else is tested. |
| [`packages/opencode/test/cli/run/run-summary.test.ts`](packages/opencode/test/cli/run/run-summary.test.ts) | Subprocess integration tests that spawn the real CLI against a fake local model server: (1) the summary block renders before the edit's own diff output, and the summarized content matches the file as it was *before* the edit, not after; (2) a simulated provider failure (exhausting the AI SDK's retry budget) still lets the edit complete, with a warning logged; (3) an edit performed inside a subagent (`task` tool) still shows its summary, even though it runs in a different session than the top-level run. | These are the three concrete, user-visible behaviors the feature promises: correct ordering, correct content, and never blocking on failure — plus the subagent case found in review. Running the real CLI binary (not just internal functions) means the test exercises the exact thing a user would see in their terminal. |
| [`packages/opencode/test/tool/edit-summary.test.ts`](packages/opencode/test/tool/edit-summary.test.ts) | The summarizer uses the session's active model (not the global default) when one is available, and falls back to the default otherwise; a request that times out actually aborts the underlying provider call (its `AbortSignal` fires) instead of continuing in the background. | These are both real bugs found during manual/live testing that wouldn't be caught by the CLI-level tests above, since they depend on provider/model selection details and timeout internals. Each test fails if the corresponding fix is reverted, which was verified directly. |
| [`packages/opencode/test/tool/edit.test.ts`](packages/opencode/test/tool/edit.test.ts) (updated, not new) | The `edit` tool's existing test suite still passes with the new `Provider.Service` dependency wired in via a fake provider. | Guards against the `--summary` work breaking the `edit` tool's pre-existing, unrelated behavior. |
| [`packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`](packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap) (updated, not new) | The pinned `--help` output for `opencode run` includes the new flag's description. | Keeps the documented acceptance criterion ("help text updated") enforced by CI, not just eyeballed once. |

**Why this is sufficient coverage:** the tests exercise the feature at two
levels that matter — the real CLI process end-to-end (ordering, content
correctness, non-blocking failure, subagent visibility) and the unit level for
provider/timeout logic that's awkward to reach from outside. Two of these
tests were written specifically because live, manual testing against a real
model surfaced bugs the fake-model tests hadn't caught (wrong provider
selection, and a timeout that didn't actually cancel the request) — both are
now locked in as regressions. The two deliberate gaps are: no TUI coverage
(the flag isn't implemented there) and no automated check of a large
(1000+ line) file's summary length, which per the PR description was verified
manually instead.
