import { expect, mock, test } from "bun:test"
import type { Provider } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("registered context command fetches backend rows again on reopen and follows session navigation", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const setup = await createTestRenderer({ width: 120, height: 40, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "context-fixture-session",
    title: "Context integration session",
    slug: "context-fixture",
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: 2 },
  }
  const second = { ...session, id: "second-context-session", title: "Second context session" }
  const provider: Provider = {
    id: "fixture",
    name: "Fixture provider",
    source: "config",
    env: [],
    options: {},
    models: {
      model: {
        id: "model",
        providerID: "fixture",
        name: "Fixture model",
        api: { id: "model", url: "http://test", npm: "fixture" },
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 2, output: 6, cache: { read: 0.5, write: 1 } },
        limit: { context: 10000, output: 1000 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-01-01",
      },
    },
  }
  const requests: {
    sessionID: string
    signal: AbortSignal
    response: ReturnType<typeof Promise.withResolvers<Response>>
  }[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { fixture: "model" } })
    if (url.pathname === "/provider")
      return json({ all: [provider], default: { fixture: "model" }, connected: ["fixture"] })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/project/proj_test/directories") return json([])
    if (url.pathname === "/session") return json([session, second])
    const current = [session, second].find((item) => url.pathname.startsWith(`/session/${item.id}`))
    if (!current) return
    if (url.pathname === `/session/${current.id}`) return json(current)
    if (
      ["message", "auxiliary_usage", "todo", "diff"].some((name) => url.pathname === `/session/${current.id}/${name}`)
    )
      return json([])
  }, events)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    const current = [session, second].find((item) => path === `/session/${item.id}/context_files`)
    if (!current) return calls.fetch(request)
    const response = Promise.withResolvers<Response>()
    requests.push({ sessionID: current.id, signal: request.signal, response })
    return response.promise
  }) as typeof globalThis.fetch
  const ready = Promise.withResolvers<TuiPluginApi>()
  let task: Promise<void> | undefined
  let disposeSlots: (() => void) | undefined

  async function frameContaining(text: string) {
    const start = Date.now()
    let frame = ""
    while (Date.now() - start < 5000) {
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      if (frame.includes(text)) return frame
      await Bun.sleep(5)
    }
    throw new Error(`Expected ${text}:\n${frame}`)
  }

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: { sessionID: session.id, continue: true, model: "fixture/model" },
        pluginHost: {
          async start(input) {
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            ready.resolve(input.api)
          },
          async dispose() {
            disposeSlots?.()
          },
        },
      }).pipe(
        Effect.provide(
          Global.layerWith({
            home: tmp.path,
            state: tmp.path,
            data: tmp.path,
            config: tmp.path,
            cache: tmp.path,
            tmp: tmp.path,
            bin: tmp.path,
            log: tmp.path,
            repos: tmp.path,
          }),
        ),
      ),
    )
    const api = await ready.promise
    await frameContaining("Build · Fixture model")
    expect(requests).toHaveLength(0)
    api.keymap.dispatchCommand("session.context")
    await frameContaining("Loading retained files")
    expect(requests.map((item) => item.sessionID)).toEqual([session.id])
    requests[0]!.response.resolve(json([{ path: "backend-only.ts", tokens: 1234 }]))
    const shown = await frameContaining("backend-only.ts")
    expect(shown).toContain("~1,234 tokens")
    expect(shown).toContain("Files from retained tool messages; approximate text tokens.")

    setup.mockInput.pressEscape()
    await frameContaining("Build · Fixture model")
    api.keymap.dispatchCommand("session.context")
    await frameContaining("Loading retained files")
    expect(requests.map((item) => item.sessionID)).toEqual([session.id, session.id])
    api.route.navigate("session", { sessionID: second.id })
    await frameContaining("Loading retained files")
    expect(requests.map((item) => item.sessionID)).toEqual([session.id, session.id, second.id])
    expect(requests[1]!.signal.aborted).toBe(true)
    requests[2]!.response.resolve(json([{ path: "second-backend.ts", tokens: 50 }]))
    await frameContaining("second-backend.ts")
    requests[1]!.response.resolve(json([{ path: "stale-first.ts", tokens: 999 }]))
    const switched = await frameContaining("second-backend.ts")
    expect(switched).not.toContain("stale-first.ts")
    expect(switched).not.toContain("backend-only.ts")
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task
    mock.restore()
  }
}, 15000)
