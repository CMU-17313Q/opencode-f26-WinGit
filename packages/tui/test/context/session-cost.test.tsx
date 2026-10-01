/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { AssistantMessage, AuxiliaryUsage, Event, StepFinishPart } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { createSessionCost } from "../../src/context/session-cost"
import type { CostSnapshot } from "../../src/util/session-cost"

function history(sessionID = "session", cost = 1): CostSnapshot {
  const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
  const info: AssistantMessage = {
    id: "message",
    sessionID,
    role: "assistant",
    providerID: "paid",
    modelID: "model",
    agent: "build",
    mode: "build",
    parentID: "user",
    path: { cwd: "/tmp", root: "/tmp" },
    time: { created: 1, completed: 2 },
    cost,
    tokens,
  }
  return {
    auxiliary: [],
    history: [
      {
        info,
        parts: [{ id: "part", messageID: "message", sessionID, type: "step-finish", reason: "stop", cost, tokens }],
      },
    ],
  }
}

async function wait(condition: () => boolean) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 2000) throw new Error("session cost did not settle")
    await Bun.sleep(5)
  }
}

async function mount(load: (id: string, signal: AbortSignal) => Promise<CostSnapshot>) {
  const handlers = new Set<(event: Event) => void>()
  let state!: ReturnType<typeof createSessionCost>
  let select!: (id: string | undefined) => void
  const requests: string[] = []
  const signals: AbortSignal[] = []
  function Probe() {
    const [session, setSession] = createSignal<string | undefined>("session")
    select = setSession
    state = createSessionCost(session, {
      load(id, signal) {
        requests.push(id)
        signals.push(signal)
        return load(id, signal)
      },
      subscribe(handler) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      providers: () => [],
    })
    return <box />
  }
  const app = await testRender(() => <Probe />)
  await wait(() => requests.length === 1)
  return {
    app,
    state,
    select,
    requests,
    signals,
    handlers,
    emit: (event: Event) => handlers.forEach((handler) => handler(event)),
  }
}

test("replays live updates over a stale hydration response without double counting", async () => {
  let resolve!: (value: CostSnapshot) => void
  const pending = new Promise<CostSnapshot>((done) => {
    resolve = done
  })
  const view = await mount(() => pending)
  try {
    expect(view.state.loading()).toBeTrue()
    const part = history("session", 3).history[0].parts[0] as StepFinishPart
    const event: Event = {
      id: "live",
      type: "message.part.updated",
      properties: { sessionID: "session", time: 2, part },
    }
    view.emit(event)
    resolve(history("session", 1))
    await wait(() => !view.state.loading())
    expect(view.state.summary()?.total).toBe(3)
    view.emit(event)
    expect(view.state.summary()?.total).toBe(3)
    expect(view.requests).toEqual(["session"])
  } finally {
    view.app.renderer.destroy()
  }
})

test("a removal during hydration is not resurrected by the snapshot", async () => {
  let resolve!: (value: CostSnapshot) => void
  const view = await mount(
    () =>
      new Promise<CostSnapshot>((done) => {
        resolve = done
      }),
  )
  try {
    view.emit({ id: "remove", type: "message.removed", properties: { sessionID: "session", messageID: "message" } })
    resolve(history())
    await wait(() => !view.state.loading())
    expect(view.state.summary()?.total).toBe(0)
    expect(view.state.summary()?.models).toEqual([])
  } finally {
    view.app.renderer.destroy()
  }
})

test("replays title completion over pending saved usage and updates late title charges once", async () => {
  const pending: AuxiliaryUsage = {
    id: "aux_title:0",
    requestID: "aux_title",
    step: 0,
    sessionID: "session",
    purpose: "title",
    providerID: "paid",
    modelID: "title-model",
    status: "pending",
    time: { created: 1, updated: 1 },
  }
  const complete: AuxiliaryUsage = {
    ...pending,
    status: "complete",
    cost: 0.5,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  let resolve!: (value: CostSnapshot) => void
  const view = await mount(
    () =>
      new Promise<CostSnapshot>((done) => {
        resolve = done
      }),
  )
  try {
    const event: Event = {
      id: "title-finished",
      type: "session.auxiliary_usage.updated",
      properties: { sessionID: "session", usage: complete },
    }
    view.emit(event)
    resolve({ ...history(), auxiliary: [pending] })
    await wait(() => !view.state.loading())
    expect(view.state.summary()?.total).toBe(1.5)
    view.emit(event)
    expect(view.state.summary()?.total).toBe(1.5)
    view.emit({ ...event, properties: { sessionID: "session", usage: { ...complete, cost: 0.75 } } })
    expect(view.state.summary()?.total).toBe(1.75)
    expect(view.state.summary()?.models).toHaveLength(2)
    expect(view.requests).toEqual(["session"])
  } finally {
    view.app.renderer.destroy()
  }
})

test("fetch failure stays unavailable and is handled without an unhandled rejection", async () => {
  const view = await mount(() => Promise.reject(new Error("offline")))
  try {
    await wait(() => !view.state.loading())
    expect(view.state.error()).toBeTrue()
    expect(view.state.summary()).toBeUndefined()
  } finally {
    view.app.renderer.destroy()
  }
})

test("switching sessions cancels old ownership and ignores a late history response", async () => {
  let resolve!: (value: CostSnapshot) => void
  const pending = new Promise<CostSnapshot>((done) => {
    resolve = done
  })
  const view = await mount((id) => (id === "session" ? pending : Promise.resolve(history(id, 2))))
  try {
    view.select("second")
    await wait(() => view.state.summary()?.total === 2)
    expect(view.signals[0].aborted).toBeTrue()
    expect(view.signals[1].aborted).toBeFalse()
    resolve(history("session", 9))
    await Bun.sleep(5)
    expect(view.state.summary()?.total).toBe(2)
    expect(view.handlers.size).toBe(1)
    expect(view.requests).toEqual(["session", "second"])
  } finally {
    view.app.renderer.destroy()
  }
  expect(view.handlers.size).toBe(0)
  expect(view.signals[1].aborted).toBeTrue()
})

test("leaving a session releases its history request and subscription without keeping its total", async () => {
  let resolve!: (value: CostSnapshot) => void
  const view = await mount(
    () =>
      new Promise<CostSnapshot>((done) => {
        resolve = done
      }),
  )
  try {
    view.select(undefined)
    await wait(() => view.handlers.size === 0)
    expect(view.signals[0].aborted).toBeTrue()
    expect(view.state.loading()).toBeFalse()
    expect(view.state.error()).toBeFalse()
    expect(view.state.sessionID()).toBeUndefined()
    resolve(history("session", 9))
    await Bun.sleep(5)
    expect(view.state.summary()).toBeUndefined()
    expect(view.requests).toEqual(["session"])
  } finally {
    view.app.renderer.destroy()
  }
})
