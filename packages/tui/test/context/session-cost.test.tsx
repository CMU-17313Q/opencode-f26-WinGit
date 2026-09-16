/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { AssistantMessage, Event, StepFinishPart } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { createSessionCost } from "../../src/context/session-cost"
import type { CostHistory } from "../../src/util/session-cost"

function history(sessionID = "session", cost = 1): CostHistory {
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
  return [
    {
      info,
      parts: [{ id: "part", messageID: "message", sessionID, type: "step-finish", reason: "stop", cost, tokens }],
    },
  ]
}

async function wait(condition: () => boolean) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 2000) throw new Error("session cost did not settle")
    await Bun.sleep(5)
  }
}

async function mount(load: (id: string) => Promise<CostHistory>) {
  const handlers = new Set<(event: Event) => void>()
  let state!: ReturnType<typeof createSessionCost>
  let select!: (id: string) => void
  const requests: string[] = []
  function Probe() {
    const [session, setSession] = createSignal("session")
    select = setSession
    state = createSessionCost(session, {
      load(id) {
        requests.push(id)
        return load(id)
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
    handlers,
    emit: (event: Event) => handlers.forEach((handler) => handler(event)),
  }
}

test("replays live updates over a stale hydration response without double counting", async () => {
  let resolve!: (value: CostHistory) => void
  const pending = new Promise<CostHistory>((done) => {
    resolve = done
  })
  const view = await mount(() => pending)
  try {
    expect(view.state.loading()).toBeTrue()
    const part = history("session", 3)[0].parts[0] as StepFinishPart
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
  let resolve!: (value: CostHistory) => void
  const view = await mount(
    () =>
      new Promise<CostHistory>((done) => {
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
  let resolve!: (value: CostHistory) => void
  const pending = new Promise<CostHistory>((done) => {
    resolve = done
  })
  const view = await mount((id) => (id === "session" ? pending : Promise.resolve(history(id, 2))))
  try {
    view.select("second")
    await wait(() => view.state.summary()?.total === 2)
    resolve(history("session", 9))
    await Bun.sleep(5)
    expect(view.state.summary()?.total).toBe(2)
    expect(view.handlers.size).toBe(1)
    expect(view.requests).toEqual(["session", "second"])
  } finally {
    view.app.renderer.destroy()
  }
  expect(view.handlers.size).toBe(0)
})
