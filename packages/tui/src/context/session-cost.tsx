import type { Event } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { createSessionCostLedger, type CostHistory, type CostProvider } from "../util/session-cost"
import { useEvent } from "./event"
import { createSimpleContext } from "./helper"
import { useRoute } from "./route"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

export function createSessionCost(
  sessionID: Accessor<string | undefined>,
  source: {
    load: (sessionID: string, signal: AbortSignal) => Promise<CostHistory>
    subscribe: (handler: (event: Event) => void) => () => void
    providers: Accessor<readonly CostProvider[]>
  },
) {
  const [activeSessionID, setActiveSessionID] = createSignal<string>()
  const [ledger, setLedger] = createSignal<ReturnType<typeof createSessionCostLedger>>()
  const [revision, setRevision] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [ready, setReady] = createSignal(false)

  createEffect(
    on(sessionID, (id) => {
      setActiveSessionID(id)
      setReady(false)
      setError(false)
      setLoading(!!id)
      setLedger(undefined)
      if (!id) return
      const abort = new AbortController()
      const current = createSessionCostLedger(id)
      const state = { active: true, hydrated: false, pending: [] as Event[] }
      setLedger(current)
      const unsubscribe = source.subscribe((event) => {
        if (!current.apply(event)) return
        if (!state.hydrated) state.pending.push(event)
        setRevision((value) => value + 1)
      })
      onCleanup(() => {
        state.active = false
        state.pending.length = 0
        abort.abort()
        unsubscribe()
      })

      // Subscribe before loading, then replay live replacements/removals over the
      // snapshot so a slow response cannot overwrite newer usage or double count it.
      void Promise.resolve()
        .then(() => source.load(id, abort.signal))
        .then(
          (history) => {
            if (!state.active) return
            current.hydrate(history)
            for (const event of state.pending) current.apply(event)
            state.pending.length = 0
            state.hydrated = true
            setLoading(false)
            setReady(true)
            setRevision((value) => value + 1)
          },
          () => {
            if (!state.active) return
            state.pending.length = 0
            state.hydrated = true
            setLoading(false)
            setError(true)
          },
        )
    }),
  )

  const summary = createMemo(() => {
    revision()
    if (!ready()) return undefined
    return ledger()?.summarize(source.providers())
  })

  return { sessionID: activeSessionID, summary, loading, error }
}

const SessionCostContext = createSimpleContext({
  name: "SessionCost",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const events = useEvent()
    const route = useRoute()
    return createSessionCost(() => (route.data.type === "session" ? route.data.sessionID : undefined), {
      async load(id, signal) {
        const response = await sdk.client.session.messages({ sessionID: id }, { throwOnError: true, signal })
        if (!response.data) throw new Error("Session usage unavailable")
        return response.data
      },
      subscribe: events.subscribe,
      providers: () => sync.data.provider,
    })
  },
})

export const SessionCostProvider = SessionCostContext.provider

export function useSessionCost(sessionID: Accessor<string | undefined>) {
  const cost = SessionCostContext.use()
  // A route change can render a new consumer before the resource effect resets.
  // Never expose the previous session's total during that transition.
  return {
    summary: () => (sessionID() === cost.sessionID() ? cost.summary() : undefined),
    loading: () => !!sessionID() && (sessionID() !== cost.sessionID() || cost.loading()),
    error: () => sessionID() === cost.sessionID() && cost.error(),
  }
}
