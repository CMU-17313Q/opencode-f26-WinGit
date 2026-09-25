// Process-global switch for `opencode run --summary`. Non-interactive `run`
// always drives at most one session per process, so a module-level flag is
// enough to reach the edit tool without threading a new field through the
// session prompt protocol. Sessions started via `--attach` run in a separate
// process and never see this flag, which is why the CLI only ever sets it in
// the local (non-attach) path.
let enabled = false

export function set(value: boolean) {
  enabled = value
}

export function isEnabled() {
  return enabled
}

export * as EditSummaryFlag from "./edit-summary-flag"
