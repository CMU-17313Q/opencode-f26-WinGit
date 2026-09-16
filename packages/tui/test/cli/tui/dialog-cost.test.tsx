/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { createSignal, onCleanup, onMount } from "solid-js"
import { CostView } from "../../../src/component/dialog-cost"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

type CostState = Omit<Parameters<typeof CostView>[0], "onClose">

async function mountCost(initial: CostState, width = 80, height = 32) {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [state, setState] = createSignal(initial)
  const ready = Promise.withResolvers<void>()
  let closed = 0

  function OpenCost() {
    const dialog = useDialog()
    onMount(() => {
      dialog.replace(
        <CostView
          summary={state().summary}
          loading={state().loading}
          error={state().error}
          onClose={() => dialog.clear()}
        />,
        () => closed++,
      )
      ready.resolve()
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))

    return (
      <TestTuiContexts paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <ToastProvider>
                  <DialogProvider>
                    <OpenCost />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  await ready.promise
  return {
    app,
    update: setState,
    closed: () => closed,
    async frame() {
      await app.renderOnce()
      await app.renderOnce()
      return app.captureCharFrame()
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("shows loading while session usage is being fetched", async () => {
  await using view = await mountCost({ loading: true, error: false })
  const frame = await view.frame()

  expect(frame).toContain("Session cost")
  expect(frame).toContain("Loading session usage")
  expect(frame).not.toContain("$0.00")
})

test("shows a fetch failure without implying the session was free", async () => {
  await using view = await mountCost({ loading: false, error: true })
  const frame = await view.frame()

  expect(frame).toContain("Could not load session usage.")
  expect(frame).not.toContain("$0.00")
})

test("shows zero cost and an empty state for a session without model usage", async () => {
  await using view = await mountCost({ loading: false, error: false, summary: { models: [], total: 0 } })
  const frame = await view.frame()

  expect(frame).toContain("No model usage yet")
  expect(frame).toContain("Total (USD): $0.00")
})

test("renders separate model usage rows and the explanation in an 80x24 terminal", async () => {
  await using view = await mountCost(
    {
      loading: false,
      error: false,
      summary: {
        models: [
          { providerID: "alpha", modelID: "model-a", input: 120, output: 45, cost: 0.0123 },
          { providerID: "beta", modelID: "model-b", input: 360, output: 78, cost: 0.0456 },
        ],
        total: 0.0579,
      },
    },
    80,
    24,
  )
  const frame = await view.frame()

  expect(frame).toContain("alpha/model-a")
  expect(frame).toContain("beta/model-b")
  expect(frame).toContain("Input: 120")
  expect(frame).toContain("Output: 45")
  expect(frame).toContain("Cost: $0.0123")
  expect(frame).toContain("Input: 360")
  expect(frame).toContain("Output: 78")
  expect(frame).toContain("Cost: $0.0456")
  expect(frame).toContain("Total (USD): $0.0579")
  expect(frame).toContain("Estimates include compacted turns.")
  expect(frame).toContain("output includes reasoning tokens.")

  const lines = frame.split("\n").map((line) => line.trim())
  expect(lines.indexOf("beta/model-b") - lines.indexOf("Cost: $0.0123")).toBeLessThanOrEqual(3)
  expect(
    lines.findIndex((line) => line.startsWith("Estimates include")) - lines.indexOf("Cost: $0.0456"),
  ).toBeLessThanOrEqual(3)
})

test("renders unavailable pricing as n/a instead of zero", async () => {
  await using view = await mountCost({
    loading: false,
    error: false,
    summary: {
      models: [{ providerID: "local", modelID: "custom", input: 12, output: 3, cost: undefined }],
      total: undefined,
    },
  })
  const frame = await view.frame()

  expect(frame).toContain("local/custom")
  expect(frame).toMatch(/Cost: n\/a/i)
  expect(frame).toMatch(/Total \(USD\): n\/a/i)
  expect(frame).not.toContain("$0.00")
})

test("updates the open dialog when session usage changes", async () => {
  await using view = await mountCost({ loading: true, error: false })
  expect(await view.frame()).toContain("Loading session usage")

  view.update({
    loading: false,
    error: false,
    summary: {
      models: [{ providerID: "alpha", modelID: "model-a", input: 10, output: 2, cost: 0.0001 }],
      total: 0.0001,
    },
  })
  const loaded = await view.frame()
  expect(loaded).toContain("Total (USD): $0.0001")
  expect(loaded).not.toContain("Loading session usage")

  view.update({
    loading: false,
    error: false,
    summary: {
      models: [{ providerID: "alpha", modelID: "model-a", input: 20, output: 5, cost: 0.0003 }],
      total: 0.0003,
    },
  })
  const updated = await view.frame()
  expect(updated).toContain("Input: 20")
  expect(updated).toContain("Output: 5")
  expect(updated).toContain("Total (USD): $0.0003")
  expect(updated).not.toContain("$0.0001")
})

test("keeps usage and the USD total visible in a narrow terminal", async () => {
  await using view = await mountCost(
    {
      loading: false,
      error: false,
      summary: {
        models: [{ providerID: "alpha", modelID: "model-a", input: 120, output: 45, cost: 0.0123 }],
        total: 0.0123,
      },
    },
    40,
  )
  const frame = await view.frame()

  expect(frame).toContain("Session cost")
  expect(frame).toContain("alpha/model-a")
  expect(frame).toContain("Input: 120")
  expect(frame).toContain("Output: 45")
  expect(frame).toContain("Cost: $0.0123")
  expect(frame).toContain("Total (USD): $0.0123")
})

test("Escape dismisses the cost dialog through the real dialog keymap", async () => {
  await using view = await mountCost({ loading: false, error: false, summary: { models: [], total: 0 } })
  expect(await view.frame()).toContain("Session cost")

  view.app.mockInput.pressEscape()

  expect(await view.frame()).not.toContain("Session cost")
  expect(view.closed()).toBe(1)
})
