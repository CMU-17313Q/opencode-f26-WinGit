import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

export type ContextFile = {
  path: string
  tokens: number
}

export function createContextFiles(
  sessionID: Accessor<string>,
  load: (sessionID: string, signal: AbortSignal) => Promise<readonly ContextFile[]>,
) {
  const [state, setState] = createStore<{
    files: readonly ContextFile[]
    loading: boolean
    error: boolean
  }>({ files: [], loading: true, error: false })

  createEffect(() => {
    const id = sessionID()
    setState({ files: [], loading: !!id, error: false })
    if (!id) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void load(id, controller.signal).then(
      (files) => {
        if (controller.signal.aborted) return
        setState({ files, loading: false, error: false })
      },
      () => {
        if (controller.signal.aborted) return
        setState({ files: [], loading: false, error: true })
      },
    )
  })

  return state
}
