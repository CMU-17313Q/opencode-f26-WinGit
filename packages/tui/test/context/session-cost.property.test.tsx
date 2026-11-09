/** @jsxImportSource @opentui/solid */
import type { AssistantMessage, AuxiliaryUsage, Session } from "@opencode-ai/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import fc from "fast-check"
import { onCleanup } from "solid-js"
import { DialogCost } from "../../src/component/dialog-cost"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute, useRouteData } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SessionCostProvider, useSessionCost } from "../../src/context/session-cost"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import type { CostSnapshot } from "../../src/util/session-cost"
import { wait } from "../cli/cmd/tui/sync-fixture"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

const charge = fc.record({
  cents: fc.integer({ min: 1, max: 4999 }),
  input: fc.integer({ min: 0, max: 5000 }),
  output: fc.integer({ min: 0, max: 5000 }),
  cached: fc.integer({ min: 0, max: 500 }),
  reasoning: fc.integer({ min: 0, max: 500 }),
  auxiliary: fc.boolean(),
})

// Both sessions always use the same model. Optional separate models, cached and
// reasoning tokens, and auxiliary charges exercise isolation across usage sources.
const sessionUsage = fc.record({
  suffix: fc.integer({ min: 0, max: 999 }),
  shared: fc.array(charge, { minLength: 1, maxLength: 3 }),
  separate: fc.array(charge, { maxLength: 3 }),
})

type SessionUsage = ReturnType<typeof sessionUsage.generate>["value"]

function sessionFixture(id: "a" | "b", usage: SessionUsage) {
  const session = {
    id,
    title: `${id === "a" ? "Assignment" : "Sandbox"} ${usage.suffix}`,
    slug: id,
    directory,
    projectID: "proj_test",
    version: "0.0.0-test",
    time: { created: 1, updated: 2 },
  } satisfies Session
  const models = [
    { id: "shared", charges: usage.shared },
    { id: `only-${id}`, charges: usage.separate },
  ].filter((model) => model.charges.length > 0)
  const snapshot: CostSnapshot = { history: [], auxiliary: [] }
  for (const model of models) {
    for (const [index, usage] of model.charges.entries()) {
      const cost = usage.cents / 100
      const tokens = {
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cache: { read: usage.cached, write: 0 },
      }
      const id = `${session.id}-${model.id}-${index}`
      const info: AssistantMessage = {
        id,
        sessionID: session.id,
        role: "assistant",
        providerID: "fixture",
        modelID: model.id,
        agent: "build",
        mode: "build",
        parentID: "user",
        path: { cwd: directory, root: directory },
        time: { created: 1, completed: 2 },
        cost,
        tokens,
      }
      if (usage.auxiliary) {
        snapshot.auxiliary.push({
          id,
          requestID: id,
          step: 0,
          sessionID: session.id,
          purpose: "title",
          providerID: info.providerID,
          modelID: model.id,
          status: "complete",
          time: { created: 1, updated: 2 },
          cost,
          tokens,
        } satisfies AuxiliaryUsage)
        continue
      }
      snapshot.history.push({
        info,
        parts: [{ id, messageID: id, sessionID: session.id, type: "step-finish", reason: "stop", cost, tokens }],
      })
    }
  }

  return { session, snapshot, models }
}

type SessionFixture = ReturnType<typeof sessionFixture>

async function mountCost(state: string, fixtures: readonly [SessionFixture, SessionFixture], includeForeign = false) {
  const loads: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(fixtures.map(({ session }) => session))
    if (url.pathname === "/project/proj_test/directories") return json([])
    const current = fixtures.find(({ session }) => url.pathname.startsWith(`/session/${session.id}/`))
    if (!current) return
    const history = includeForeign ? fixtures.flatMap(({ snapshot }) => snapshot.history) : current.snapshot.history
    const auxiliary = includeForeign
      ? fixtures.flatMap(({ snapshot }) => snapshot.auxiliary)
      : current.snapshot.auxiliary
    if (url.pathname.endsWith("/auxiliary_usage")) return json(auxiliary)
    if (url.pathname.endsWith("/message")) {
      loads.push(current.session.id)
      return json(history)
    }
  })
  let cost!: ReturnType<typeof useSessionCost>
  let route!: ReturnType<typeof useRoute>
  let sync!: ReturnType<typeof useSync>

  function Probe() {
    const current = useRouteData("session")
    route = useRoute()
    sync = useSync()
    cost = useSessionCost(() => current.sessionID)
    return <DialogCost sessionID={current.sessionID} />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ home: state, state, worktree: state }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <ExitProvider
                  exit={(error) => {
                    throw error
                  }}
                >
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                            <ToastProvider>
                              <DialogProvider>
                                <RouteProvider initialRoute={{ type: "session", sessionID: fixtures[0].session.id }}>
                                  <SessionCostProvider>
                                    <Probe />
                                  </SessionCostProvider>
                                </RouteProvider>
                              </DialogProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </ExitProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 28 })
  return {
    loads,
    async summary() {
      await wait(() => sync?.status === "complete" && cost.summary() !== undefined)
      return cost.summary()!
    },
    select: (sessionID: string) => route.navigate({ type: "session", sessionID }),
    async lines() {
      await this.summary()
      await app.renderOnce()
      return app
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const sumCents = (fixture: SessionFixture) =>
  fixture.models.flatMap((model) => model.charges).reduce((sum, charge) => sum + charge.cents, 0)

// R1: Identify the active session and show only its usage and cost.
// Kind: invariant. Deliberately supply both sessions' records in the snapshot.
test("R1: the cost dialog identifies the active session and excludes foreign usage", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  await fc.assert(
    fc.asyncProperty(sessionUsage, sessionUsage, async (a, b) => {
      const active = sessionFixture("a", a)
      const other = sessionFixture("b", b)
      using view = await mountCost(tmp.path, [active, other], true)
      const lines = await view.lines()
      expect(lines).toContain(`Session: ${active.session.title}`)
      expect(lines).not.toContain(`Session: ${other.session.title}`)
      expect(lines).toContain(`Total (USD): ${currency.format(sumCents(active) / 100)}`)
      expect(lines.filter((line) => line.startsWith("fixture/")).sort()).toEqual(
        active.models.map((model) => `fixture/${model.id}`).sort(),
      )
      for (const model of active.models) {
        const input = model.charges.reduce((sum, charge) => sum + charge.input + charge.cached, 0)
        const output = model.charges.reduce((sum, charge) => sum + charge.output + charge.reasoning, 0)
        const index = lines.indexOf(`fixture/${model.id}`)
        expect(lines[index + 1]).toBe(
          `Input: ${input.toLocaleString("en-US")} · Output: ${output.toLocaleString("en-US")}`,
        )
        expect(lines[index + 2]).toBe(
          `Cost: ${currency.format(model.charges.reduce((sum, charge) => sum + charge.cents, 0) / 100)}`,
        )
      }
    }),
  )
}, 30000)

// R4: Preserve a session’s total, token counts, and per-model breakdown when switching sessions without new usage.
// Kind: round-trip. Each route hydrates from the same unchanged generated snapshot on every visit.
test("R4: switching A to B and back restores A's cost and token breakdown", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  await fc.assert(
    fc.asyncProperty(sessionUsage, sessionUsage, async (a, b) => {
      const first = sessionFixture("a", a)
      const second = sessionFixture("b", b)
      using view = await mountCost(tmp.path, [first, second])
      const before = await view.summary()
      view.select(second.session.id)
      expect((await view.summary()).total).toBeCloseTo(sumCents(second) / 100, 8)
      view.select(first.session.id)
      expect(await view.summary()).toEqual(before)
      expect(view.loads).toEqual([first.session.id, second.session.id, first.session.id])
    }),
  )
}, 30000)
