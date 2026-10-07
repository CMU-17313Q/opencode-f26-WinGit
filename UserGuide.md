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

---

## `/context`: list the files in the agent's context

**Added by:** Wassim Rakab (PR #10, closes #4)

### What it does

Inside a TUI session, `/context` opens a window that lists every file the agent
has read, edited or written in that session. Each row shows the file's path and
a rough size in tokens (for example `~1,234 tokens`). This lets you see which
files the agent is working with, and which ones take up the most room, before
you ask it for more.

- Files are listed in the order they first entered the context, newest at the
  bottom.
- A file that was read more than once is listed once, with the size from its
  latest read.
- After `/compact`, files from the part of the chat that was summarized are
  dropped, so the list only shows files that are still in context.
- In a session with no files yet, it shows `No files in context`.

### How to use it

1. Start the development version from the repository root:

   ```sh
   bun install --frozen-lockfile
   bun dev .
   ```

2. Connect a provider with `/connect` and pick a model with `/models`.
3. Open a session and ask the agent to read or edit a few files.
4. Type `/context` and press Enter. A window titled **Context** opens with one
   row per file.
5. Press Esc to close it.

`/context` only works inside a session. It is also listed in `/help`, and in
the command palette as **List files in context**.

### How to test it manually

- **Five files, one read twice.** Ask the agent to read five files from at
  least two packages (for example one in `packages/tui` and one in
  `packages/opencode`), and to read one of them a second time. Run `/context`.
  You should see five rows in the order they were read, and the repeated file
  only once.
- **New file goes to the bottom.** Close the window, ask the agent to read one
  more file, and run `/context` again. The new file is the last row.
- **Compaction.** Run `/compact`, wait for the summary to finish, then run
  `/context`. Files from the summarized part of the chat are gone.
- **Empty session.** Start a new session and run `/context` before doing
  anything else. It shows `No files in context` and nothing crashes.
- **Help text.** Run `/help`. It includes the line
  `/context - List the files in the agent's context (in a session).`
- **Long paths.** Ask the agent to read a deeply nested file. The whole path
  fits in the window and is not cut off.

### Automated tests

| File | What it tests | Why it's there |
| --- | --- | --- |
| [`packages/tui/test/util/context-files.test.ts`](packages/tui/test/util/context-files.test.ts) | 17 tests for the helper that builds the list: an empty session; tools that are not file tools are ignored; files from `read`, `edit` and `write` are all tracked; the order is kept with the newest file last; a file read twice is listed once, with the size from its latest read; sizes for read, written and edit-only files; tool calls that have not finished are skipped; calls with no path are skipped; paths from different packages stay separate; and four compaction cases (summarized files are dropped, files in the kept part stay, a compaction whose summary has not finished is ignored, and only the latest compaction counts). | All the rules for what goes in the list live in this one helper, so each rule from issue #4 has its own test. The compaction tests follow the same rule the backend uses to decide what the model still sees (`filterCompacted` in `packages/opencode/src/session/message-v2.ts`). |
| [`packages/tui/test/component/dialog-context.test.ts`](packages/tui/test/component/dialog-context.test.ts) | 2 tests for what the window shows: one row per tracked file, in the same order, with the `~N tokens` label; and no rows for an empty session. | Issue #4 asks for a test that the `/context` output matches the tracked file list. This is that test. |

Run them from `packages/tui`:

```sh
bun test test/util/context-files.test.ts test/component/dialog-context.test.ts
```

All 19 pass, and CI runs them on every push to the PR.

**Why this is sufficient coverage:** every acceptance criterion in issue #4 is
covered by a test, a manual check, or both.

- Criterion 1 (every file the agent read or edited, with its path and size):
  the read, edit and write tracking tests, the four sizing tests, and the
  window test that checks one row per file.
- Criterion 2 (a new file shows up at the bottom): the ordering test, plus the
  "new file goes to the bottom" manual check.
- Criterion 3 (a fresh session shows the empty message and does not crash):
  the empty session tests in both files, plus the manual check.
- Criterion 4 (tests pass in CI): all checks on PR #10 pass.
- Criterion 5 (manual check on a session with at least 5 files, one read
  twice): done with the steps above, including `/compact`.
- Criterion 6 (`/help` lists the command): checked by hand.

The issue's testing notes are covered too: re-reading a file, files from
different packages, and compaction each have their own tests.

Known gaps: the token count is an estimate (characters divided by 4), not the
model's real tokenizer, so the window labels it with `~`. The `/help` line is
checked by hand, not by a test. And the list is built from the messages the
TUI has loaded for the session, so in a very long session, files from older
messages the TUI has not loaded are not counted.
