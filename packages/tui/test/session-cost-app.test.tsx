import { expect, mock, test } from "bun:test"
import type { AssistantMessage, AuxiliaryUsage, Provider, StepFinishPart } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import SidebarContext from "../src/feature-plugins/sidebar/context"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("cost views share usage and context percentages follow model selection across session changes", async () => {
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
  const second = { ...session, id: "second-cost-session", title: "Second cost session" }
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
  provider.models.small = {
    ...provider.models.model!,
    id: "small",
    name: "Small window",
    api: { ...provider.models.model!.api, id: "small" },
    limit: { context: 200, output: 100 },
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
  const historyLoads: string[] = []
  const auxiliaryLoads: string[] = []
  const title: AuxiliaryUsage = {
    id: "aux_fixture:0",
    requestID: "aux_fixture",
    step: 0,
    sessionID: session.id,
    purpose: "title",
    providerID: provider.id,
    modelID: "title-model",
    status: "complete",
    cost: 0.0002,
    tokens: { ...tokens, input: 10, output: 5 },
    time: { created: 1, updated: 2 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session, second])
    const current = [session, second].find((item) => url.pathname.startsWith(`/session/${item.id}`))
    if (current) {
      if (url.pathname === `/session/${current.id}`) return json(current)
      if (url.pathname === `/session/${current.id}/auxiliary_usage`) {
        auxiliaryLoads.push(current.id)
        return json(current.id === session.id ? [title] : [])
      }
      if (url.pathname === `/session/${current.id}/message`) {
        if (!url.searchParams.has("limit")) historyLoads.push(current.id)
        const cost = current.id === session.id ? 0.0123 : 0.09
        return json([
          {
            info: { ...info, sessionID: current.id, cost },
            parts: [{ ...part, sessionID: current.id, cost }],
          },
        ])
      }
      if ([`/session/${current.id}/todo`, `/session/${current.id}/diff`].includes(url.pathname)) return json([])
    }
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

  async function selectModel(name: string) {
    api!.keymap.dispatchCommand("model.list")
    await frameContaining("Select model")
    const started = Date.now()
    while (!(setup.renderer.currentFocusedEditor instanceof core.InputRenderable)) {
      if (Date.now() - started > 2000) throw new Error("model search did not receive focus")
      await Bun.sleep(1)
    }
    await setup.mockInput.typeText(name)
    await frameContaining(name)
    setup.mockInput.pressEnter()
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
    const initial = await frameContaining("$0.0125 estimated")
    expect(initial).toContain("$0.0125 est.")
    expect(initial).toContain("120 / 10.0K (1%) · $0.0125 est.")
    expect(initial).toContain("Context")
    expect(initial).toContain("120 tokens")
    expect(historyLoads).toEqual([session.id])
    expect(auxiliaryLoads).toEqual([session.id])
    expect(initial).toContain("1% used")

    await selectModel("Small window")
    const smaller = await frameContaining("120 / 200 (60%) · $0.0125 est.")
    expect(smaller).toContain("60% used")
    expect(smaller).toContain("120 tokens")
    expect(smaller).toContain("$0.0125 estimated")
    expect(historyLoads).toEqual([session.id])
    expect(auxiliaryLoads).toEqual([session.id])

    await selectModel("Fixture model")
    const restored = await frameContaining("120 / 10.0K (1%) · $0.0125 est.")
    expect(restored).toContain("1% used")
    expect(restored).toContain("120 tokens")
    expect(restored).toContain("$0.0125 estimated")
    expect(historyLoads).toEqual([session.id])
    expect(auxiliaryLoads).toEqual([session.id])

    api!.keymap.dispatchCommand("session.cost")
    const dialog = await frameContaining("Total (USD): $0.0125")
    expect(dialog).toContain("Session cost")
    expect(dialog).toContain("fixture/model")
    expect(dialog).toContain("fixture/title-model")
    expect(dialog).toContain("Input: 100")
    expect(dialog).toContain("Output: 20")
    expect(historyLoads).toEqual([session.id])

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
    const updated = await frameContaining("Total (USD): $0.0458")
    expect(updated).toContain("Input: 200")
    const titleEvent = {
      directory,
      payload: {
        id: "title-fixture-update",
        type: "session.auxiliary_usage.updated" as const,
        properties: { sessionID: session.id, usage: { ...title, cost: 0.0005 } },
      },
    }
    events.emit(titleEvent)
    events.emit(titleEvent)
    await frameContaining("Total (USD): $0.0461")
    setup.mockInput.pressEscape()
    const closed = await frameContaining("$0.0461 est.")
    expect(closed).toContain("$0.0461 estimated")
    expect(closed).toContain("120 / 10.0K (1%) · $0.0461 est.")
    expect(closed).toContain("120 tokens")
    expect(closed).not.toContain("Session cost")
    api!.keymap.dispatchCommand("session.cost")
    await frameContaining("Total (USD): $0.0461")
    expect(historyLoads).toEqual([session.id])
    expect(auxiliaryLoads).toEqual([session.id])
    setup.mockInput.pressEscape()
    await frameContaining("$0.0461 est.")

    api!.route.navigate("session", { sessionID: second.id })
    const switched = await frameContaining("$0.09 estimated")
    expect(switched).toContain("$0.09 est.")
    expect(switched).toContain("120 / 10.0K (1%) · $0.09 est.")
    expect(switched).not.toContain("$0.0461")
    expect(historyLoads).toEqual([session.id, second.id])
    expect(auxiliaryLoads).toEqual([session.id, second.id])
    events.emit(titleEvent)
    events.emit({
      directory,
      payload: {
        id: "old-session-update",
        type: "message.part.updated",
        properties: { sessionID: session.id, time: 4, part: { ...part, cost: 99 } },
      },
    })
    api!.keymap.dispatchCommand("session.cost")
    const isolated = await frameContaining("Total (USD): $0.09")
    expect(isolated).not.toContain("$99")
    expect(historyLoads).toEqual([session.id, second.id])
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task
    mock.restore()
  }
}, 15000)
