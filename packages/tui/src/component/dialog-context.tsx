import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { contextFiles } from "../util/context-files"

export type DialogContextFilesProps = {
  sessionID: string
}

export function DialogContextFiles(props: DialogContextFilesProps) {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const files = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    return contextFiles(messages.flatMap((message) => sync.data.part[message.id] ?? []))
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
      <Show when={files().length > 0} fallback={<text fg={theme.textMuted}>No files in context</text>}>
        <box>
          <For each={files()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme.text} wrapMode="none">
                  {item.path}
                </text>
                <text fg={theme.textMuted} flexShrink={0}>
                  ~{item.tokens.toLocaleString()} tokens
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
