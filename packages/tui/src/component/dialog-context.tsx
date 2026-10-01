import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { contextFiles, type ContextFile } from "../util/context-files"

export type DialogContextFilesProps = {
  sessionID: string
}

export function contextFileRows(files: readonly ContextFile[]) {
  return files.map((file) => ({ path: file.path, size: `~${file.tokens.toLocaleString("en-US")} tokens` }))
}

export function DialogContextFiles(props: DialogContextFilesProps) {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  dialog.setSize("large")

  const rows = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    return contextFileRows(contextFiles(messages.map((info) => ({ info, parts: sync.data.part[info.id] ?? [] }))))
  })

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
      <Show when={rows().length > 0} fallback={<text fg={theme.textMuted}>No files in context</text>}>
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
    </box>
  )
}
