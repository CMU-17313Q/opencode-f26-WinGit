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

Costs come from the server's recorded charges for each step. The server applies model pricing, including cache and context-size tiers. Old steps are not repriced using today's catalog rates. The total covers retained session history, including turns before compaction and beyond the TUI's 100-message display window. It is a session estimate, not the account's monthly bill.

### Understand the display

| Display | Meaning |
| --- | --- |
| `$0.00` with no usage | The new session has no recorded model usage. |
| `Loading session usage…` | The dialog is loading saved usage. |
| `Could not load session usage.` | Saved usage could not be loaded; the application does not claim the session was free. Reopen the session to retry. |
| `n/a` | Pricing is missing or all rates are zero. The current provider API converts absent prices to zero, so free/local models can also show `n/a`. |
| Total `n/a` with some priced rows | At least one model has unavailable pricing. Known model rows remain visible, but a partial amount is not presented as a complete total. |
| `<$0.0001` | The known estimate is positive but smaller than four decimal places. |

### Manual feature checks

| Check | Steps | Expected result |
| --- | --- | --- |
| New session and live updates | Start a session; send two short prompts; open `/cost`. | An empty session starts at zero. New recorded usage updates the prompt, sidebar, and open dialog consistently. |
| Multiple models | Complete a reply, select a different model with `/models`, then complete another reply. | `/cost` has separate provider/model rows. The total includes both when both have pricing. |
| Unavailable pricing | Use a model with zero recorded cost and missing or all-zero catalog prices. | The relevant cost is `n/a`; the dialog remains usable and no missing price is presented as a zero bill. A positive recorded charge remains usable even if the model is missing from the catalog. |
| Compaction and history | Note the estimate, run `/compact`, and reopen `/cost` after it finishes. | Earlier retained charges remain included. Compaction may add its own model charge, so an identical total is not required. |
| Session isolation | Switch to a different session, then return. | Each session shows only its own usage. Returning loads its retained history. |
| Discoverability and layout | Read `/help`, open `/cost`, resize the terminal, and press Escape. | Help lists `/cost`; the breakdown can be read or scrolled, and Escape closes it. |

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

| Test file | Coverage |
| --- | --- |
| [Ledger tests](packages/tui/test/util/session-cost.test.ts) | Multi-step charges, cached/reasoning tokens, recorded prices, model grouping, missing prices, event replacement/removal, legacy messages, compaction history, and more than 100 messages. |
| [Reactive resource tests](packages/tui/test/context/session-cost.test.tsx) | Live events arriving during history loading, removals, load failures, and aborting requests/releasing subscriptions when switching or leaving a session. |
| [Dialog tests](packages/tui/test/cli/tui/dialog-cost.test.tsx) | Loading/error/empty states, model rows, unavailable pricing, live updates, small terminals, and Escape handling through the real keymap. |
| [Application test](packages/tui/test/session-cost-app.test.tsx) | Runs the real TUI, opens the command through its registry, and checks that all three views share one full-history load, update live, and stay isolated when switching sessions. |

The existing [server pricing tests](packages/opencode/test/session/compaction.test.ts), under `SessionNs.getUsage`, cover fixed prices, cache/reasoning usage, and pricing tiers. From `packages/opencode`, run:

```sh
bun test test/session/compaction.test.ts --test-name-pattern 'SessionNs.getUsage'
```

Together these checks cover accounting, asynchronous updates, rendering, and command integration. They do not establish agreement with an external provider's bill. The `@opencode-ai/tui#test` task in [turbo.json](turbo.json) includes the TUI suite in the GitHub Actions unit job. Check the run on the latest PR commit before marking CI verification complete.

### Compare one real session with provider billing

This is acceptance criterion 5 in Issue #6 and remains a separate manual check.

1. Use a dedicated provider key/project, or a quiet period with no other requests, so the provider's usage can be matched to this session. Record the provider, model, time window, and session ID locally.
2. Start a new session with a priced model, send a short prompt, and capture the `/cost` amount and token breakdown after the response finishes.
3. Wait for the provider's usage dashboard to update. Select the matching requests/time window and compare the USD usage charge before account-level credits, taxes, or unrelated charges. Include auxiliary requests generated by the session, such as automatic title generation, and investigate any difference rather than silently excluding charges.
4. For a positive provider charge, calculate `100 * abs(OpenCode estimate - provider charge) / provider charge`. Use enough precision to avoid rounding a tiny charge to zero. The target is roughly 10% or less.
5. Record both amounts, the percentage difference, and redacted supporting evidence in the PR. If the provider reports only a rounded zero, collect a more precise usage view; that result cannot establish a percentage match.

The Sprint 1 demo uses synthetic usage data and does not complete this billing check. Do not include API keys or unrelated account information in the evidence.

Known verification gap: the current server generates a session title without saving that request as a billable message step. Its charge can therefore be absent from `/cost`. The real-session billing criterion is still open; passing the fixture tests does not close this gap.
