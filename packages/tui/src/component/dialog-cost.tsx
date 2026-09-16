import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Switch, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSessionCost } from "../context/session-cost"
import { formatCost, type SessionCostSummary } from "../util/session-cost"
import { useDialog } from "../ui/dialog"

export function DialogCost(props: { sessionID: string }) {
  const dialog = useDialog()
  const cost = useSessionCost(() => props.sessionID)

  return (
    <CostView summary={cost.summary()} loading={cost.loading()} error={cost.error()} onClose={() => dialog.clear()} />
  )
}

export function CostView(props: {
  summary?: SessionCostSummary
  loading: boolean
  error: boolean
  onClose: () => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Session cost
        </text>
        <text fg={theme.textMuted} onMouseUp={props.onClose}>
          esc
        </text>
      </box>
      <scrollbox maxHeight={Math.max(3, Math.floor(dimensions().height * 0.75) - 4)}>
        <box gap={1}>
          <Switch>
            <Match when={props.loading}>
              <text fg={theme.textMuted}>Loading session usage…</text>
            </Match>
            <Match when={props.error}>
              <text fg={theme.warning}>Could not load session usage.</text>
            </Match>
            <Match when={props.summary}>
              {(summary) => (
                <>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    Total (USD): {formatCost(summary().total)}
                  </text>
                  <Show
                    when={summary().models.length > 0}
                    fallback={<text fg={theme.textMuted}>No model usage yet.</text>}
                  >
                    <box gap={1}>
                      <For each={summary().models}>
                        {(model) => (
                          <box>
                            <text fg={theme.text} wrapMode="word">
                              {model.providerID}/{model.modelID}
                            </text>
                            <text fg={theme.textMuted} wrapMode="word">
                              Input: {model.input.toLocaleString("en-US")} · Output:{" "}
                              {model.output.toLocaleString("en-US")}
                            </text>
                            <text fg={model.cost === undefined ? theme.warning : theme.textMuted}>
                              Cost: {formatCost(model.cost)}
                            </text>
                          </box>
                        )}
                      </For>
                    </box>
                  </Show>
                  <text fg={theme.textMuted} wrapMode="word">
                    Estimates include compacted turns. Input includes cached tokens; output includes reasoning tokens.
                  </text>
                  <Show when={summary().models.some((model) => model.cost === undefined)}>
                    <text fg={theme.warning} wrapMode="word">
                      n/a means pricing is unavailable or zero-rated. Total is n/a when any model is unpriced.
                    </text>
                  </Show>
                </>
              )}
            </Match>
          </Switch>
        </box>
      </scrollbox>
    </box>
  )
}
