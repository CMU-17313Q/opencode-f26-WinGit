# WinGit User Guide

This guide describes the team's student-facing features and how to verify them.

## Session cost estimates and `/cost`

Contributor: Chenyu Qiu. [Issue #6](https://github.com/CMU-17313Q/opencode-f26-WinGit/issues/6) · [PR #8](https://github.com/CMU-17313Q/opencode-f26-WinGit/pull/8).

### Start the development version

Use Bun 1.3.14, as specified in `package.json`. From the repository root:

```sh
bun install --frozen-lockfile
bun dev .
```

Connect a provider using OpenCode's normal `/connect` flow, then choose a model with `/models`. Use an account you are authorized to use. A paid model is only needed for the provider-billing check below; automated tests use fixed fixtures and do not send paid requests.

### Use the feature

1. Open a session and send a short prompt, such as `Reply with one short sentence. Do not use tools.`
2. After the response, look under the prompt for the USD estimate ending in `est.`. The sidebar shows the same session estimate.
3. Enter `/cost`. The dialog shows the session total and one row for each provider/model used, with input tokens, output tokens, and estimated cost.
4. Press Escape to close the dialog. Enter `/help` to find the `/cost` description.

The estimate updates as completed model steps arrive. Input includes cache-read and cache-write tokens; output includes reasoning tokens. Multiple model calls in one reply are counted separately. A model switch adds a separate row, even if the providers use the same model name.

Automatic title generation and pre-edit summaries are also recorded, using the model that actually made each request. A title can add a row for a smaller model even when you did not switch models yourself. These records are saved separately from the conversation, so they do not increase the context meter's token count or add chat messages. If auxiliary usage arrives after the main reply, the estimate updates again. Each session shows its own calls: a child task's summary charge belongs to the child session and is not added to the parent total.

Costs come from the server's recorded charges for each step. The server applies model pricing, including cache and context-size tiers. Old steps are not repriced using today's catalog rates. The total covers retained session history, including turns before compaction and beyond the TUI's 100-message display window. It is a session estimate, not the account's monthly bill.

### Understand the display

| Display                           | Meaning                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$0.00` with no usage             | The new session has no recorded model usage.                                                                                                                                                   |
| `Loading session usage…`          | The dialog is loading saved usage.                                                                                                                                                             |
| `Could not load session usage.`   | Saved usage could not be loaded; the application does not claim the session was free. Reopen the session to retry.                                                                             |
| `n/a`                             | Pricing is missing/all-zero, or an auxiliary request is still pending or returned incomplete usage. The provider API converts absent prices to zero, so free/local models can also show `n/a`. |
| Total `n/a` with some priced rows | At least one model has unavailable pricing or usage. Known model rows remain visible, but a partial amount is not presented as a complete total.                                               |
| `<$0.0001`                        | The known estimate is positive but smaller than four decimal places.                                                                                                                           |

### Manual feature checks

| Check                        | Steps                                                                                                        | Expected result                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New session and live updates | Start a session; send two short prompts; open `/cost`.                                                       | An empty session starts at zero. New recorded usage updates the prompt, sidebar, and open dialog consistently.                                                                                   |
| Multiple models              | Complete a reply, select a different model with `/models`, then complete another reply.                      | `/cost` has separate provider/model rows. The total includes both when both have pricing.                                                                                                        |
| Background title usage       | Start a new session; wait for its title and first reply, then inspect `/cost`. Leave and reopen the session. | The saved title request is included under its actual model. Reopening does not lose or duplicate it. The context meter still counts conversation context only.                                   |
| Pre-edit summary usage       | Run a file edit with `opencode run --summary`, then reopen that session in the TUI and inspect `/cost`.      | The completed summary request appears under its actual model exactly once. A child task's summary appears in the child session's cost.                                                           |
| Unavailable pricing          | Use a model with zero recorded cost and missing or all-zero catalog prices.                                  | The relevant cost is `n/a`; the dialog remains usable and no missing price is presented as a zero bill. A positive recorded charge remains usable even if the model is missing from the catalog. |
| Compaction and history       | Note the estimate, run `/compact`, and reopen `/cost` after it finishes.                                     | Earlier retained charges remain included. Compaction may add its own model charge, so an identical total is not required.                                                                        |
| Session isolation            | Switch to a different session, then return.                                                                  | Each session shows only its own usage. Returning loads its retained history.                                                                                                                     |
| Discoverability and layout   | Read `/help`, open `/cost`, resize the terminal, and press Escape.                                           | Help lists `/cost`; the breakdown can be read or scrolled, and Escape closes it.                                                                                                                 |

### Automated verification

Run tests from their package directory, not with `bun test` at the repository root:

```sh
cd packages/tui
bun run test
bun typecheck
```

To run only the cost tests from `packages/tui`:

```sh
bun test test/util/session-cost.test.ts test/context/session-cost.test.tsx test/cli/tui/dialog-cost.test.tsx test/session-cost-app.test.tsx
```

| Test file                                                                               | Coverage                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ledger tests](packages/tui/test/util/session-cost.test.ts)                             | Main, title and pre-edit summary charges within the owning session, cached/reasoning tokens, recorded prices, model grouping, missing prices/usage, duplicate or stale events, legacy messages, compaction history, and more than 100 messages. |
| [Reactive resource tests](packages/tui/test/context/session-cost.test.tsx)              | Live message/title events arriving during history loading, removals, load failures, and aborting requests/releasing subscriptions when switching or leaving a session.                                                                          |
| [Dialog tests](packages/tui/test/cli/tui/dialog-cost.test.tsx)                          | Loading/error/empty states, model rows, unavailable pricing, live updates, small terminals, and Escape handling through the real keymap.                                                                                                        |
| [Application test](packages/tui/test/session-cost-app.test.tsx)                         | Runs the real TUI, opens the command through its registry, and checks that all three views share one load of each usage source, include title usage, update live, preserve the context count, and stay isolated when switching sessions.        |
| [Auxiliary storage tests](packages/opencode/test/session/auxiliary-usage.test.ts)       | Durable replacement and event consistency, retention after renaming/deleting a message, fork isolation, and deletion with the session.                                                                                                          |
| [Auxiliary stream tests](packages/opencode/test/session/auxiliary-usage-stream.test.ts) | Step usage, duplicate events, failure/cancellation, missing usage, and retaining billed steps after title processing fails.                                                                                                                     |
| [Title integration tests](packages/opencode/test/session/prompt.test.ts)                | Runs automatic title generation through the real prompt loop against a local test provider, with distinct title/main models and present or empty title text.                                                                                    |
| [Usage endpoint tests](packages/opencode/test/server/session-auxiliary-usage.test.ts)   | Real HTTP responses for saved/empty usage and missing sessions, without inserting conversation messages.                                                                                                                                        |
| [Pre-edit summary tests](packages/opencode/test/tool/edit-summary.test.ts)              | Actual selected model, pending record before provider execution, durable usage after reload, and provider cancellation on timeout or user abort.                                                                                                |

The existing [server pricing tests](packages/opencode/test/session/compaction.test.ts), under `SessionNs.getUsage`, cover fixed prices, cache/reasoning usage, and pricing tiers. From `packages/opencode`, run:

```sh
bun test test/session/compaction.test.ts --test-name-pattern 'SessionNs.getUsage'
```

Run the new backend usage tests from `packages/opencode`:

```sh
bun test test/session/auxiliary-usage.test.ts test/session/auxiliary-usage-stream.test.ts test/server/session-auxiliary-usage.test.ts
bun test test/session/prompt.test.ts --test-name-pattern 'records automatic title usage'
```

Together these checks cover accounting, asynchronous updates, rendering, and command integration. They do not establish agreement with an external provider's bill. The `@opencode-ai/tui#test` task in [turbo.json](turbo.json) includes the TUI suite in the GitHub Actions unit job. Check the run on the latest PR commit before marking CI verification complete.

### Compare one real session with provider billing

This is acceptance criterion 5 in Issue #6 and remains a separate manual check.

1. Use a dedicated provider key/project, or a quiet period with no other requests, so the provider's usage can be matched to this session. Record the provider, model, time window, and session ID locally.
2. Start a new session with a priced model, send a short prompt, and capture the `/cost` amount and token breakdown after the response finishes.
3. Wait for the provider's usage dashboard to update. Select the matching requests/time window and compare the USD usage charge before account-level credits, taxes, or unrelated charges. Include auxiliary requests generated by the session, such as automatic title generation or pre-edit summaries, and investigate any difference rather than silently excluding charges. If the run delegates to child sessions, compare each session separately or explicitly sum all matching session totals; the parent's `/cost` does not include child-session calls.
4. For a positive provider charge, calculate `100 * abs(OpenCode estimate - provider charge) / provider charge`. Use enough precision to avoid rounding a tiny charge to zero. The target is roughly 10% or less.
5. Record both amounts, the percentage difference, and redacted supporting evidence in the PR. If the provider reports only a rounded zero, collect a more precise usage view; that result cannot establish a percentage match.

The Sprint 1 demo uses synthetic usage data and does not complete this billing check. Do not include API keys or unrelated account information in the evidence.

### Scope and compatibility

Title and pre-edit summary calls made by this version have separate durable usage records. Auxiliary charges from older sessions cannot be reconstructed from chat messages. A fork retains its copied conversation history, but does not copy the original session's auxiliary charges. Deleting a conversation message does not erase a separately recorded auxiliary charge; deleting its session removes both.

The new `GET /session/{sessionID}/auxiliary_usage` endpoint and `session.auxiliary_usage.updated` event expose these records. Existing `SessionInfo.cost` and token fields keep their conversation-step semantics; the three TUI cost views combine both sources. The auxiliary records cover automatic title generation and pre-edit summaries, with purpose values `title` and `edit-summary`. They do not cover arbitrary third-party plugins or another session's calls.

The real-session billing criterion remains open until the documented provider comparison is performed. Passing fixture tests does not establish agreement with an external bill.

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
- **Summary-only failure doesn't block the edit.** Use the automated
  summary-failure fixture in `test/cli/run/run-summary.test.ts`, which fails
  the summary request while keeping the main agent's requests available.
  It checks the `could not generate a summary for ...` warning and a
  successful edit. Invalid credentials or a network outage affecting the
  whole provider can stop the main agent before it requests an edit, so
  they do not isolate this behavior.
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

| File                                                                                                                                                                        | What it tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why it's there                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/opencode/test/cli/run/run-flags.test.ts`](packages/opencode/test/cli/run/run-flags.test.ts)                                                                      | `--summary` parses to `true`/`false`/default via yargs, and `--no-summary` negates it.                                                                                                                                                                                                                                                                                                                                                                                                                                      | Confirms the flag is actually wired into the CLI's option parser before anything else is tested.                                                                                                                                                                                                                             |
| [`packages/opencode/test/cli/run/run-summary.test.ts`](packages/opencode/test/cli/run/run-summary.test.ts)                                                                  | Subprocess integration tests that spawn the real CLI against a fake local model server: (1) the summary block renders before the edit's own diff output, and the summarized content matches the file as it was _before_ the edit, not after; (2) a simulated provider failure (exhausting the AI SDK's retry budget) still lets the edit complete, with a warning logged; (3) an edit performed inside a subagent (`task` tool) still shows its summary, even though it runs in a different session than the top-level run. | These are the three concrete, user-visible behaviors the feature promises: correct ordering, correct content, and never blocking on failure — plus the subagent case found in review. Running the real CLI binary (not just internal functions) means the test exercises the exact thing a user would see in their terminal. |
| [`packages/opencode/test/tool/edit-summary.test.ts`](packages/opencode/test/tool/edit-summary.test.ts)                                                                      | The summarizer uses the session's active model (not the global default) when one is available, and falls back to the default otherwise; a request that times out actually aborts the underlying provider call (its `AbortSignal` fires) instead of continuing in the background.                                                                                                                                                                                                                                            | These are both real bugs found during manual/live testing that wouldn't be caught by the CLI-level tests above, since they depend on provider/model selection details and timeout internals. Each test fails if the corresponding fix is reverted, which was verified directly.                                              |
| [`packages/opencode/test/tool/edit.test.ts`](packages/opencode/test/tool/edit.test.ts) (updated, not new)                                                                   | The `edit` tool's existing test suite still passes with the new `Provider.Service` dependency wired in via a fake provider.                                                                                                                                                                                                                                                                                                                                                                                                 | Guards against the `--summary` work breaking the `edit` tool's pre-existing, unrelated behavior.                                                                                                                                                                                                                             |
| [`packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`](packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap) (updated, not new) | The pinned `--help` output for `opencode run` includes the new flag's description.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Keeps the documented acceptance criterion ("help text updated") enforced by CI, not just eyeballed once.                                                                                                                                                                                                                     |

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

### Integration behavior and additional checks

The combined branch also saves pre-edit summary usage for `/cost`, using the model that actually made the request. The charge belongs to the session that performed the edit; child-session charges are not added to the parent's total. Completed charges survive reload and cancellation; missing or incomplete usage is shown as `n/a`.

Use a disposable feature branch for the example above. The protected-branch guard runs before summary generation, so a default non-interactive run on `main` rejects the branch request before generating a summary or changing the file. Cancelling a pending summary aborts the provider request and prevents its edit from writing; it cannot undo an edit that already completed.

Descendant summaries and warnings are followed recursively, once each, for tasks belonging to this run. Ordinary child conversation output and unrelated-session summaries remain hidden. The file content used for the summary is limited to the first 20,000 characters.

Run the combined regression tests from `packages/opencode`:

```sh
bun test test/tool/edit-summary.test.ts test/tool/edit.test.ts test/cli/run/run-summary.test.ts test/cli/run/run-flags.test.ts
bun typecheck
```

These retain the feature author's original child-session and pending-provider timeout regressions and add durable usage, user cancellation, recursive descendants, duplicate-event filtering, and protected-branch ordering checks. Automated provider fixtures do not establish agreement with a real provider bill.

## Context window meter

**Added by:** malaliQA (PR #9, closes #5)

### What it does

While a session is open, the status bar under the prompt box (bottom right, next
to `ctrl+p commands`) shows how much of the selected model's context window the
conversation is using, as `used / total (xx%)`, for example `47.7K / 1.0M (5%)`.
When the usage reaches 80% or more, the text turns yellow as a warning. The
session's cost estimate is shown after it, separated by `·`. The sidebar's Context
panel uses the same calculation, so its percentage matches the status bar.

How the number is worked out:

- **Used** is the token count of the latest assistant reply (input, output,
  reasoning and cached tokens added together). Earlier replies are not added up,
  because every request sends the whole conversation again, so the latest reply
  already includes everything before it.
- **Total** is the context window of the model that is currently selected, so the
  percentage changes as soon as you switch models.
- A reply that comes back without usage data (for example a failed request) is
  skipped, so the meter keeps showing the last known value instead of dropping to
  zero.
- After `/compact` the conversation gets shorter, so the number goes down on the
  next reply instead of continuing to climb.
- A new session shows `0 / <window> (0%)`. If a model's window size is unknown,
  only the token count is shown, with no percentage.

This meter describes conversation context only. The USD estimate separately
includes recorded title and summary calls.

### How to use it

1. Make sure a provider is connected (`/connect` in the TUI). Some of the free
   models listed under OpenCode Zen work without an API key.
2. From the repository root, start the TUI:

   ```bash
   bun dev
   ```

3. Send a prompt. Look at the bottom right of the status bar. It should read
   `0 / <window> (0%)` before the reply and update by itself when the reply
   finishes, with no manual refresh.

### How to test it manually

- **Updates after every reply.** Send a few prompts. The used count should grow
  after each reply and match the number in the sidebar's Context panel.
- **Model switch.** Open `/models` and pick a model with a different window size.
  The total and the percentage change immediately in both the status bar and the
  sidebar, before you send anything. The token count stays the same.
- **Compaction.** After a few replies, run `/compact`, then send another prompt.
  The number should drop below the value you saw before compacting.
- **Missing usage data.** Switch to a model that fails (for example one with a bad
  key) and send a prompt. The error appears, but the meter keeps the previous
  value and nothing crashes.
- **Yellow warning without waiting for 80%.** Give a model a small window in your
  global opencode config so that one reply already passes 80%. First list the
  model IDs of a provider:

  ```bash
  bun dev models opencode
  ```

  Then add an override to your global config (`~/.config/opencode/opencode.jsonc`,
  on Windows `C:\Users\<you>\.config\opencode\opencode.jsonc`). Replace
  `opencode` with your provider id and `<model-id>` with an ID from the list above:

  ```jsonc
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "opencode": {
        "models": {
          "<model-id>": { "limit": { "context": 15000, "output": 4000 } }
        }
      }
    }
  }
  ```

  Restart `bun dev`, select that model and send one prompt. A first reply used
  about 12K tokens in our testing, so the meter should show about 80% and turn
  yellow. Remove the override when you are done. The same trick with a window of
  around 100000 lets a free model reach 50% in a few prompts.

### Automated tests

The calculation lives in one function, `contextUsage(messages, limit)` in
[`packages/tui/src/util/context-usage.ts`](packages/tui/src/util/context-usage.ts),
so it can be tested without rendering the TUI. Run the tests and the type check
from `packages/tui`:

```bash
cd packages/tui
bun test test/util/context-usage.test.ts test/session-cost-app.test.tsx
bun run typecheck
```

The 10 unit tests are in
[`packages/tui/test/util/context-usage.test.ts`](packages/tui/test/util/context-usage.test.ts):

| Test | What it checks | Why it is there |
| --- | --- | --- |
| uses the last assistant message against the limit | 40K input plus 10K output on a 200K window gives 50K used and 25% | The basic calculation is right |
| returns undefined for a session with no messages | An empty message list gives no usage | A brand new session does not crash |
| returns undefined when only user messages exist | No assistant reply yet gives no usage | The meter waits for the first reply instead of guessing |
| counts only the last assistant message, not a sum | Replies of 11K and 32K give 32K, not 43K | Guards against double counting the re-sent conversation |
| falls back to the last known value when the latest response has no usage | A reply with zero tokens keeps the earlier value | Failed or incomplete replies do not reset the meter |
| drops after compaction instead of continuing to climb | 155K followed by 21K gives 21K (11%) | The meter follows the real context size down |
| includes cached tokens in the total | Cached tokens are added to the used count | Cached text still takes up space in the window |
| recomputes the percentage for a model with a different window | The same 100K is 50% of 200K and 10% of 1M | Switching models gives a correct percentage |
| warns at 80% and above | 79% does not warn; 80% and 96% do | The warning starts exactly at the threshold |
| reports usage without a percentage when the model limit is unknown | No limit gives the count only, with no percentage and no warning | A model missing from the config does not crash |

The integration test
[`packages/tui/test/session-cost-app.test.tsx`](packages/tui/test/session-cost-app.test.tsx)
renders the real application and switches models through the model picker between
a 10,000-token and a 200-token window. It checks that the status bar and the
sidebar both show the matching percentage (1% and then 60%) and that they return
to the original value when the first model is selected again.

**Why this is sufficient coverage:** every branch of the calculation is covered by
the unit tests, including the edge cases from the issue's testing notes
(compaction, missing usage, two models with different windows). The integration
test covers the part that depends on the running TUI: the percentage in the
status bar and the sidebar follows the selected model. What the automated tests do
not cover is the yellow colour and the live update after every real reply. We
checked those by hand in a running TUI using the steps above, and the screenshots
are attached to PR #9.

## Protected branch warning

Feature: [Issue #7](https://github.com/CMU-17313Q/opencode-f26-WinGit/issues/7), [PR #12](https://github.com/CMU-17313Q/opencode-f26-WinGit/pull/12).

The built-in `edit`, `write` and `apply_patch` tools ask permission before changing files on `main`, `master` or `develop`. In the TUI, the warning names the branch. Choose **Allow once** to continue the current operation or **Reject** to stop it. No always-allow option is offered for this per-operation check.

To customize the list, add this field to `opencode.json`; it replaces the defaults:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "protected_branches": ["main", "production"]
}
```

An empty list disables the check. Existing permission configuration can also allow or deny `protected_branch`. The feature uses the local Git branch and configured names, rather than GitHub's protection settings. It does not cover shell commands or other tools.

In non-interactive `opencode run`, an ask request is rejected by default. `--auto`, `--yolo` and `--dangerously-skip-permissions` automatically approve it once, including a known child task's protected-branch request. The TUI's automatic approval mode also approves branch requests without showing a confirmation. Use manual approval mode to see the warning. For a manual check, use a disposable repository on `main`: reject an edit and confirm the file remains unchanged; then allow one edit and confirm it completes. Repeat on a feature branch and check that no branch warning appears. If using `--summary`, rejection should happen before a summary request is made.

From `packages/opencode`, run:

```sh
bun test test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts test/agent/agent.test.ts test/cli/run/run-protected-branch.test.ts
bun typecheck
```

The tool tests cover protected/feature branch checks and rejection before file changes. The patch regression rejects one add/update/delete patch and verifies that all files remain unchanged. The actual CLI tests use a Git repository on `main` with delegated editing, checking auto approval and default rejection, both with and without summaries. The rejection tests also check that no summary provider request is made. These tests use disposable files and local provider fixtures.

## `/context`: list the files in the agent's context

**Added by:** Wassim Rakab (PR #10, closes #4)

> **Original PR #10 documentation (`2406670`).** Wassim's text below describes that feature version. For the current combined branch, use the [integration follow-up](#integration-follow-up-retained-file-content), which updates the data source, token sizing, dialog/help wording and test coverage.

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

### Integration follow-up: retained file content

Contributor: Chenyu Qiu. [PR #13](https://github.com/CMU-17313Q/opencode-f26-WinGit/pull/13).

The section above preserves Wassim's original [PR #10 documentation at `2406670`](https://github.com/CMU-17313Q/opencode-f26-WinGit/blob/240667099dd1677f39bfe9726cd38386845b240c/UserGuide.md). Its 19-test count and CI/manual-check statements describe that feature version. For this combined branch, the details below supersede its TUI-cache data source, latest-read token sizing, dialog/help wording and test descriptions; the basic `/context` workflow remains the same.

The dialog describes its rows as `Files from retained tool messages; approximate text tokens.` An empty result shows `No files in retained tool messages.` The `/help` entry is `/context — List retained file-tool content and approximate tokens (in a session).`

In a TUI session, enter `/context`. The dialog lists one row for each file path found in retained `read`, `edit` or `write` tool messages, with an approximate text-token contribution. Rows follow the files' first appearance. Repeated reads keep one row, while their retained text contributions are added together. Press Escape to close the dialog. Close and reopen it after another tool call or compaction to get a fresh snapshot.

The list follows the server's conversation-compaction selection and active undo boundary, so files from messages older than the TUI's 100-message display window are still included when that text is retained. Undone turns or parts do not contribute; inspecting the list preserves the history needed by `/redo`. A cleared read result does not contribute its old content. Edit/write input text can remain in model history after its output was cleared or the operation failed; a listed path therefore does not prove a successful file change.

Counts use roughly four text characters per token. They cover retained file-tool text, rather than the entire model input. System instructions, image/media tokens and runtime plugin transformations are outside this list. The context meter separately reports model usage; these row estimates are not expected to add up to that meter. Child sessions have their own context lists.

A loading message appears while saved data is fetched. A failed request shows an error with a retry instruction; it does not claim the session is empty. A successful empty result shows a clear no-files message. Opening the dialog again fetches new data. Switching sessions replaces its data and cancels the old request.

Manual checks:

| Check                          | Steps                                                                                            | Expected result                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Five files and a repeated read | Ask the agent to read five disposable files, including one of them twice, then enter `/context`. | Five rows appear, in first-appearance order. The repeated path appears once.                                                          |
| New file                       | Close the dialog, read another file, then run `/context` again.                                  | The new file appears at the bottom.                                                                                                   |
| Empty session                  | Start a fresh session and open `/context`.                                                       | A no-files message appears without an error.                                                                                          |
| Long history                   | Retain a read result, continue beyond 100 messages without compaction, and reopen the dialog.    | That early file still appears.                                                                                                        |
| Compaction and pruning         | Note the list, compact the session or clear an old tool output, then reopen.                     | Only file-related text still retained by the server contributes to the list. A later reread restores the file's content contribution. |
| Failure and navigation         | Open the dialog while its request fails or switch sessions during loading.                       | Failure is shown explicitly; the old session's response cannot replace the new session's list.                                        |

Run the backend checks from `packages/opencode`:

```sh
bun test test/session/context-files.test.ts test/server/session-context-files.test.ts test/session/message-v2.test.ts
bun typecheck
```

Run the UI checks from `packages/tui`:

```sh
bun test test/util/context-files.test.ts test/component/dialog-context.test.ts test/cli/tui/dialog-context.test.tsx test/session-context-app.test.tsx
bun typecheck
```

The backend tests exercise actual compaction selection and model-history rules, including early files beyond 100 messages, cleared reads, repeated paths, edit/write inputs, interrupted results and assistant errors. The HTTP tests query saved session data through `GET /session/{sessionID}/context_files`, verify an unknown session returns 404, and check that inspection does not mutate history. UI tests cover row formatting, actual SDK requests, loading/error/empty states, cancellation, reopening, session changes and the registered `/context` command.
