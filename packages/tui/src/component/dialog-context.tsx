import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { createContextFiles, type ContextFile } from "../util/context-files"

export type DialogContextFilesProps = {
  sessionID: string
}

export function contextFileRows(files: readonly ContextFile[]) {
  return files.map((file) => ({ path: file.path, size: `~${file.tokens.toLocaleString("en-US")} tokens` }))
}

export function DialogContextFiles(props: DialogContextFilesProps) {
  const sdk = useSDK()
  const project = useProject()
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  dialog.setSize("large")

  const files = createContextFiles(
    () => props.sessionID,
    async (sessionID, signal) => {
      const response = await sdk.client.session.contextFiles(
        { sessionID, workspace: project.workspace.current() },
        { signal, throwOnError: true },
      )
      return response.data
    },
  )
  const rows = createMemo(() => contextFileRows(files.files))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Context
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>Files from retained tool messages; approximate text tokens.</text>
      <scrollbox maxHeight={Math.max(3, Math.floor(dimensions().height * 0.75) - 6)}>
        <Switch>
          <Match when={files.loading}>
            <text fg={theme.textMuted}>Loading retained files…</text>
          </Match>
          <Match when={files.error}>
            <text fg={theme.warning}>Could not load retained files. Close and reopen to retry.</text>
          </Match>
          <Match when={!files.loading && !files.error}>
            <Show
              when={rows().length > 0}
              fallback={<text fg={theme.textMuted}>No files in retained tool messages.</text>}
            >
              <box>
                <For each={rows()}>
                  {(row) => (
                    <box flexDirection="row" gap={1} justifyContent="space-between">
                      <text fg={theme.text} wrapMode="none">
                        {row.path}
                      </text>
                      <text fg={theme.textMuted} flexShrink={0}>
                        {row.size}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </Match>
        </Switch>
      </scrollbox>
    </box>
  )
}
