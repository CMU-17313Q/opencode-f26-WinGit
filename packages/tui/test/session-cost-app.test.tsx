import { expect, mock, test } from "bun:test"
import type { AssistantMessage, Provider, StepFinishPart } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import SidebarContext from "../src/feature-plugins/sidebar/context"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("session.cost opens the real dialog and live usage updates all session cost views", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const setup = await createTestRenderer({ width: 150, height: 40, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "cost-fixture-session",
    title: "Cost integration fixture",
    slug: "cost-fixture",
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: 2 },
  }
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
  const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
  const info: AssistantMessage = {
    id: "cost-fixture-message",
    sessionID: session.id,
    role: "assistant",
    providerID: provider.id,
    modelID: "model",
    agent: "build",
    mode: "build",
    parentID: "cost-fixture-user",
    path: { cwd: directory, root: directory },
    time: { created: 1, completed: 2 },
    cost: 0.0123,
    tokens,
  }
  const part: StepFinishPart = {
    id: "cost-fixture-step",
    messageID: info.id,
    sessionID: session.id,
    type: "step-finish",
    reason: "stop",
    cost: 0.0123,
    tokens,
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${session.id}`) return json(session)
    if (url.pathname === `/session/${session.id}/message`) return json([{ info, parts: [part] }])
    if ([`/session/${session.id}/todo`, `/session/${session.id}/diff`].includes(url.pathname)) return json([])
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { fixture: "model" } })
    if (url.pathname === "/provider")
      return json({ all: [provider], default: { fixture: "model" }, connected: ["fixture"] })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
  }, events)
  let api: TuiPluginApi | undefined
  let disposeSlots: (() => void) | undefined
  let task: Promise<void> | undefined

  async function frameContaining(text: string) {
    const started = Date.now()
    let frame = ""
    while (Date.now() - started < 5000) {
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      if (frame.includes(text)) return frame
      await Bun.sleep(10)
    }
    throw new Error(`Expected app frame to contain ${text}:\n${frame}`)
  }

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { sessionID: session.id, model: "fixture/model" },
        pluginHost: {
          async start(input) {
            api = input.api
            const slots = input.runtime.setupSlots(input.api)
            disposeSlots = slots.dispose
            await SidebarContext.tui(
              {
                ...input.api,
                slots: {
                  register<Slots extends Record<string, object>>(plugin: TuiSlotPlugin<Slots>) {
                    slots.register({ ...plugin, id: SidebarContext.id })
                    return SidebarContext.id
                  },
                },
              },
              undefined,
              {
                id: SidebarContext.id,
                source: "internal",
                spec: SidebarContext.id,
                target: SidebarContext.id,
                first_time: 0,
                last_time: 0,
                time_changed: 0,
                load_count: 1,
                fingerprint: "fixture",
                state: "first",
              },
            )
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
    const initial = await frameContaining("$0.0123 estimated")
    expect(initial).toContain("$0.0123 est.")
    expect(initial).toContain("Context")

    api!.keymap.dispatchCommand("session.cost")
    const dialog = await frameContaining("Total (USD): $0.0123")
    expect(dialog).toContain("Session cost")
    expect(dialog).toContain("fixture/model")
    expect(dialog).toContain("Input: 100")
    expect(dialog).toContain("Output: 20")

    events.emit({
      directory,
      payload: {
        id: "cost-fixture-update",
        type: "message.part.updated",
        properties: {
          sessionID: session.id,
          time: 3,
          part: { ...part, cost: 0.0456, tokens: { ...tokens, input: 200 } },
        },
      },
    })
    const updated = await frameContaining("Total (USD): $0.0456")
    expect(updated).toContain("Input: 200")
    setup.mockInput.pressEscape()
    const closed = await frameContaining("$0.0456 est.")
    expect(closed).toContain("$0.0456 estimated")
    expect(closed).not.toContain("Session cost")
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task
    mock.restore()
  }
}, 15000)
