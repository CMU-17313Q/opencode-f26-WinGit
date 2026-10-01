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

## Pre-edit file summaries with `--summary`

Feature implementation: Yasa Khan, [Issue #3](https://github.com/CMU-17313Q/opencode-f26-WinGit/issues/3) and [PR #11](https://github.com/CMU-17313Q/opencode-f26-WinGit/pull/11). Integration follow-up: cancellation, descendant visibility and auxiliary cost recording.

From the repository root, start a local run with the flag:

```sh
bun dev run --summary "Read notes.txt, then replace 'old note' with 'new note'."
```

Run this example on a disposable feature branch, such as `summary-demo`, using an existing disposable file with the text `old note` in it. On a protected branch, the default non-interactive run rejects the branch request before generating a summary. The summary describes the existing file before the `edit` tool applies the replacement. It prints an information block headed `Summary: <path>`. A delegated child task's summary or warning also appears in the run output. Ordinary child conversation output remains hidden.

The summary uses the run's selected model and may make an additional billable request. The file content sent for the summary is limited to the first 20,000 characters. The generated text can be inaccurate, so read the proposed edit as well. The flag summarizes existing files edited by the `edit` tool; it does not summarize new files, full-file replacements through `write`, shell commands, or remote `--attach` runs. It does not add a confirmation step.

A summary timeout (10 seconds) or provider failure prints a warning and lets the normal edit flow continue. Cancelling the run interrupts the provider request and prevents a still-pending edit from writing the file. Cancellation cannot undo an edit that has already completed. Recorded completed usage is retained; missing or incomplete usage is shown as `n/a` in `/cost`.

Manual checks:

| Check               | Steps                                                           | Expected result                                                                                                  |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Existing file       | Run the example above against a disposable file.                | The summary describes the old content before the successful edit output. The file then contains the replacement. |
| No flag             | Repeat the edit without `--summary`.                            | No pre-edit summary request or information block is added.                                                       |
| Selected model      | Choose a model with `--model provider/model` and repeat.        | The summary uses that model; reopening the run's session shows its saved usage under that model in `/cost`.      |
| User cancellation   | Cancel while summary generation is still running.               | The outstanding provider request is aborted and the file remains unchanged.                                      |
| Unavailable summary | Use the automated failure fixture below.                        | The warning appears, then the normal edit succeeds. No complete estimate is invented for missing summary usage.  |
| Delegated edit      | Use a prompt that delegates the disposable file edit to a task. | The run prints that child task's summary or warning. Its charge is recorded in the child session.                |

Run the automated checks from `packages/opencode`:

```sh
bun test test/tool/edit-summary.test.ts test/tool/edit.test.ts test/cli/run/run-summary.test.ts test/cli/run/run-flags.test.ts
bun typecheck
```

[Summary helper tests](packages/opencode/test/tool/edit-summary.test.ts) exercise model selection, real provider-stream abort signals, durable pending-before-execution records and usage after reload. [Edit tool tests](packages/opencode/test/tool/edit.test.ts) verify unchanged files on cancellation and successful editing after a summary timeout or provider failure. [CLI integration tests](packages/opencode/test/cli/run/run-summary.test.ts) run actual `task → edit` flows against a local provider fixture, verify summary-before-edit ordering and child warnings, and replay duplicate, nested and unrelated events. They also preserve JSON output behavior. These fixtures do not use a paid provider.

## Context window meter

Feature: [Issue #5](https://github.com/CMU-17313Q/opencode-f26-WinGit/issues/5), [PR #9](https://github.com/CMU-17313Q/opencode-f26-WinGit/pull/9).

Start a TUI session with `bun dev .`. The status bar under the prompt shows used tokens, the selected model's context-window limit and a rounded percentage. It turns yellow when that displayed percentage reaches 80%. The latest assistant response with output usage supplies input, output, reasoning and cached tokens. Earlier responses are not summed because each request includes the conversation again. A response without output usage keeps the previous value; an empty session starts at zero.

To check it, send a short prompt, switch to a model with a different context limit, then use `/compact`. The percentage should recalculate immediately on the model switch. Usage may fall after compaction. An unknown context limit cannot produce a meaningful percentage. This meter describes conversation context; the USD estimate separately includes recorded title and summary calls.

From `packages/tui`, run `bun test test/util/context-usage.test.ts test/session-cost-app.test.tsx` and `bun typecheck`. The helper tests cover the latest response, missing usage, compaction, cached tokens, model limits and the warning threshold. The application test checks that the meter and session cost remain visible together.

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

## Retained file content with `/context`

Feature: [Issue #4](https://github.com/CMU-17313Q/opencode-f26-WinGit/issues/4), [PR #10](https://github.com/CMU-17313Q/opencode-f26-WinGit/pull/10). Integration follow-up: use the session's retained history instead of the TUI display cache.

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
