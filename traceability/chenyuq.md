# Traceability: Chenyu Qiu (chenyuq)

**Target feature:** The OpenCode `/cost` dialog. The [session route](../packages/tui/src/routes/session/index.tsx) opens the [cost dialog](../packages/tui/src/component/dialog-cost.tsx). The [session cost context](../packages/tui/src/context/session-cost.tsx) loads and updates the [usage ledger](../packages/tui/src/util/session-cost.ts).

## Requirements

| ID | Interview evidence | Requirement | Acceptance criteria | Changed in P4B? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | C-3, C-4, S-3, O-4 | Identify the active session and show only its usage and cost. | Session A (Assignment) has $0.03 and 300 tokens. Session B (Sandbox) has $0.07 and 700 tokens. Open /cost in A. It shows Assignment, $0.03, and 300 tokens. | No | Invariant: the cost dialog identifies the active session and displays its isolated usage and cost. | [Context property tests](../packages/tui/test/context/session-cost.property.test.tsx) |
| R2 | C-3, C-4, S-4, O-4 | Show the known subtotal and mark the total as incomplete when any usage cost is missing. | With $0.03 known and one unpriced request, show $0.03 as the known subtotal and mark the total incomplete. With only an unpriced request, show the cost as unknown. A complete recorded zero shows $0.00. | No | — | — |
| R3 | O-1, O-3, O-6, O-10 | Label the currency and explain how the session estimate relates to provider billing and plan usage. | For an estimate of USD 0.03, show the amount and currency, label it as an estimate, and point to the provider for actual charges or plan usage. | No | — | — |
| R4 | C-5, C-6, S-6, O-5 | Preserve a session’s total, token counts, and per-model breakdown when switching sessions without new usage. | Open A’s cost view, switch to B, and return to A with no record changes. A’s total, token counts, and per-model amounts match the original view. | No | Round-trip: after A → B → A, the reloaded summary for A equals its original summary. | [Context property tests](../packages/tui/test/context/session-cost.property.test.tsx) |
| R5 | C-6, S-6, O-6 | Update the summary when delayed usage arrives and explain what changed. | Start with $0.03 known and one pending request. When that request’s $0.02 record arrives, show a total of $0.05 and indicate that pending usage was added. | No | — | — |
| R6 | C-7, C-8, S-8, O-7, O-8 | Count a completed usage record once when its stable identity is replayed, and count distinct identities even when their recorded costs and token counts match. | Replay a complete $0.03 record with the same identity. The total stays $0.03. Add a complete record with a distinct identity and identical token counts and cost. The total rises to $0.06. | Yes | Metamorphic: replay preserves the total, and a distinct record with identical usage adds its recorded charge. | [Ledger property tests](../packages/tui/test/util/session-cost.property.test.ts) |
| R7 | C-7, S-7, O-7 | Produce the same final cost summary regardless of the arrival order of distinct completed records. | Deliver two completed records, $0.03 for Model A and $0.02 for Model B, in both possible orders. Each run shows $0.05 and the same per-model amounts. | No | Metamorphic: reordering distinct completed records preserves the total and per-model amounts. | [Ledger property tests](../packages/tui/test/util/session-cost.property.test.ts) |
| R8 | C-9, C-10, S-9, O-9, O-10 | Show the usage entries considered by the ledger, with model, token counts, cost status, and ID and time when recorded. Use the message-level aggregate for older messages with no recorded steps, and show how known costs sum to the subtotal. | For a $0.03 step record, a $0.02 legacy message aggregate, and one unpriced entry, show the two known amounts and their recorded details. The two amounts add up to the $0.05 known subtotal. The unpriced cost is shown as unknown. | Yes | — | — |

Properties written or suggested by opencode or another AI tool: R1, R4, R6, R7.

## Requirement changes

| ID | Original requirement (P4A) | Revised requirement | Why it changed |
|---|---|---|---|
| R6 | Count a replayed usage record once and count separate requests even when their prompts and prices match. | Count a completed usage record once when its stable identity is replayed, and count distinct identities even when their recorded costs and token counts match. | The ledger receives record IDs and usage data. Using those inputs makes the requirement checkable and preserves the interviewees’ distinction between a replay and a separate charge. |
| R8 | Show the counted requests with their model, token counts, cost, and available ID and time so users can check the total. | Show the usage entries considered by the ledger, with model, token counts, cost status, and ID and time when recorded. Use the message-level aggregate for older messages with no recorded steps, and show how known costs sum to the subtotal. | Older sessions can have message-level totals without individual step records. Using recorded entries preserves the user's ability to check the known subtotal with the detail that exists. |

## Triage

- **R1** failed because the dialog omitted the session title. With seed `1522376452`, fast-check shrank the failure to two sessions with one $0.01 record each and zero tokens. The total was correctly isolated, but the title `Assignment 0` was missing. The dialog now reads and displays the title of the session whose cost it shows.
- **R7** failed on the original ledger after 40 generated cases. The smallest case found contained three completed charges for one model ($0.000059, $0.000022, and $0.001169). The original arrival order displayed $0.0012, while the reverse order displayed $0.0013. The seed was `-1506222042` and the shrink path was `39:4:3:2:4:4:0:4:3:3:3:3:3:3:3`. The ledger now adds known charges from smallest to largest so each arrival order uses the same arithmetic.

## Requirements outside the four property tests

- **R2** can use the recorded usage and pricing metadata to show an incomplete total, a known subtotal, or a known zero.
- **R3** can label the existing USD estimate and tell users where to check provider billing or plan usage.
- **R5** can use a usage update to refresh the summary and explain that a pending record completed.
- **R8** needs a view of the entries counted by the ledger. The revised requirement can use legacy aggregates and the metadata available for each entry.
