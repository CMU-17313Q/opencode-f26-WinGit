/** @jsxImportSource @opentui/solid */
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { createSignal, onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../../fixture/tui-sdk"

const protectedBranch: PermissionRequest = {
  id: "per_branch",
  sessionID: "ses_permission",
  permission: "protected_branch",
  patterns: ["main"],
  always: [],
  metadata: { branch: "main" },
}
const patterned: PermissionRequest = {
  ...protectedBranch,
  id: "per_patterned",
  permission: "bash",
  patterns: ["git status"],
  always: ["git *"],
  metadata: {},
}

async function mountPermission(initial: PermissionRequest) {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [request, setRequest] = createSignal(initial)
  const ready = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{ pathname: string; body: unknown }>()
  const replies: unknown[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/project/proj_test/directories") return json([])
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.startsWith("/permission/") && url.pathname.endsWith("/reply")) {
      const body: unknown = await request.json()
      replies.push(body)
      reply.resolve({ pathname: url.pathname, body })
      return json(true)
    }
    return calls.fetch(request)
  }) as typeof globalThis.fetch

  function Content() {
    onMount(() => ready.resolve())
    return <PermissionPrompt request={request()} directory={directory} />
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
            <ArgsProvider>
              <KVProvider>
                <ExitProvider exit={(reason) => ready.reject(reason)}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={eventSource()}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                            <LocationProvider>
                              <Content />
                            </LocationProvider>
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

  const app = await testRender(() => <Harness />, { width: 100, height: 24, kittyKeyboard: true })
  await ready.promise
  return {
    app,
    replies,
    reply: reply.promise,
    update: setRequest,
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

test("protected branch prompt names the branch and allows one change with Enter", async () => {
  await using view = await mountPermission(protectedBranch)
  const frame = await view.frame()
  expect(frame).toContain("Protected branch: main")
  expect(frame).toContain("Allow once")
  expect(frame).toContain("Reject")
  expect(frame).not.toContain("Allow always")
  await view.app.mockInput.pressEnter()
  expect(await view.reply).toEqual({ pathname: "/permission/per_branch/reply", body: { reply: "once" } })
})

for (const key of ["right", "l", "left", "h", "escape"] as const) {
  test(`empty always patterns reject with ${key}${key === "escape" ? "" : " then Enter"}`, async () => {
    await using view = await mountPermission(protectedBranch)
    await view.frame()
    if (key === "escape") view.app.mockInput.pressEscape()
    else if (key === "left" || key === "right") view.app.mockInput.pressArrow(key)
    else view.app.mockInput.pressKey(key)
    if (key !== "escape") await view.app.mockInput.pressEnter()
    expect(await view.reply).toEqual({ pathname: "/permission/per_branch/reply", body: { reply: "reject" } })
  })
}

test("patterned requests retain the always confirmation and reply", async () => {
  await using view = await mountPermission(patterned)
  expect(await view.frame()).toContain("Allow always")
  view.app.mockInput.pressArrow("right")
  await view.app.mockInput.pressEnter()
  const confirm = await view.frame()
  expect(confirm).toContain("Always allow")
  expect(confirm).toContain("git *")
  expect(view.replies).toEqual([])
  await view.app.mockInput.pressEnter()
  expect(await view.reply).toEqual({ pathname: "/permission/per_patterned/reply", body: { reply: "always" } })
})

for (const confirm of [false, true]) {
  test(`reused prompt drops stale always ${confirm ? "confirmation" : "selection"}`, async () => {
    await using view = await mountPermission(patterned)
    await view.frame()
    view.app.mockInput.pressArrow("right")
    if (confirm) await view.app.mockInput.pressEnter()
    view.update(protectedBranch)
    const frame = await view.frame()
    expect(frame).toContain("Protected branch: main")
    expect(frame).not.toContain("Allow always")
    expect(frame).not.toContain("Always allow")
    await view.app.mockInput.pressEnter()
    expect(await view.reply).toEqual({ pathname: "/permission/per_branch/reply", body: { reply: "once" } })
  })
}
