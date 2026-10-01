/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { createSignal, onCleanup, onMount } from "solid-js"
import { DialogContextFiles } from "../../../src/component/dialog-context"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { directory, eventSource, json } from "../../fixture/tui-sdk"

async function mountContext() {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [session, setSession] = createSignal("first")
  const ready = Promise.withResolvers<ReturnType<typeof useDialog>>()
  const requests: {
    path: string
    signal: AbortSignal
    response: ReturnType<typeof Promise.withResolvers<Response>>
  }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const response = Promise.withResolvers<Response>()
    requests.push({ path: new URL(request.url).pathname, signal: request.signal, response })
    return response.promise
  }) as typeof globalThis.fetch

  function Open() {
    const dialog = useDialog()
    onMount(() => {
      dialog.replace(() => <DialogContextFiles sessionID={session()} />)
      ready.resolve(dialog)
    })
    return <text>Underlying session</text>
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
            <SDKProvider url="http://test" directory={directory} fetch={fetch} events={eventSource()}>
              <ProjectProvider>
                <KVProvider>
                  <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                    <ToastProvider>
                      <DialogProvider>
                        <Open />
                      </DialogProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </KVProvider>
              </ProjectProvider>
            </SDKProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 32, kittyKeyboard: true })
  const dialog = await ready.promise
  return {
    app,
    requests,
    session: setSession,
    reopen() {
      dialog.replace(() => <DialogContextFiles sessionID={session()} />)
    },
    async frameContaining(text: string) {
      const start = Date.now()
      let frame = ""
      while (Date.now() - start < 2000) {
        await app.renderOnce()
        frame = app.captureCharFrame()
        if (frame.includes(text)) return frame
        await Bun.sleep(1)
      }
      throw new Error(`Expected ${text}:\n${frame}`)
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("loads retained files through the SDK and distinguishes an empty response from loading", async () => {
  await using view = await mountContext()
  const pending = await view.frameContaining("Loading retained files")
  expect(pending).not.toContain("No files")
  expect(pending).toContain("Files from retained tool messages; approximate text tokens.")
  expect(view.requests.map((item) => item.path)).toEqual(["/session/first/context_files"])
  view.requests[0]!.response.resolve(json([]))
  const empty = await view.frameContaining("No files in retained tool messages.")
  expect(empty).not.toContain("Loading retained files")
})

test("shows request failure and fetches new data when reopened", async () => {
  await using view = await mountContext()
  await view.frameContaining("Loading retained files")
  view.requests[0]!.response.resolve(json({ message: "unavailable" }, { status: 500 }))
  const failed = await view.frameContaining("Could not load retained files.")
  expect(failed).not.toContain("No files")
  view.app.mockInput.pressEscape()
  await view.frameContaining("Underlying session")
  view.reopen()
  await view.frameContaining("Loading retained files")
  expect(view.requests).toHaveLength(2)
  view.requests[1]!.response.resolve(json([{ path: "src/from-backend.ts", tokens: 2345 }]))
  const ready = await view.frameContaining("src/from-backend.ts")
  expect(ready).toContain("~2,345 tokens")
  expect(ready).not.toContain("Could not load")
})

test("switching sessions aborts and ignores an older response, and leaving sessions makes no request", async () => {
  await using view = await mountContext()
  await view.frameContaining("Loading retained files")
  view.session("second")
  await view.frameContaining("Loading retained files")
  expect(view.requests.map((item) => item.path)).toEqual([
    "/session/first/context_files",
    "/session/second/context_files",
  ])
  expect(view.requests[0]!.signal.aborted).toBe(true)
  view.requests[1]!.response.resolve(json([{ path: "second.ts", tokens: 22 }]))
  await view.frameContaining("second.ts")
  view.requests[0]!.response.resolve(json([{ path: "stale.ts", tokens: 99 }]))
  const current = await view.frameContaining("second.ts")
  expect(current).not.toContain("stale.ts")
  view.session("")
  const empty = await view.frameContaining("No files in retained tool messages.")
  expect(empty).not.toContain("second.ts")
  expect(view.requests).toHaveLength(2)
})

test("closing aborts the pending load and reopening cannot receive its late response", async () => {
  await using view = await mountContext()
  await view.frameContaining("Loading retained files")
  view.app.mockInput.pressEscape()
  const closed = await view.frameContaining("Underlying session")
  expect(closed).not.toContain("Loading retained files")
  expect(view.requests[0]!.signal.aborted).toBe(true)
  view.reopen()
  await view.frameContaining("Loading retained files")
  expect(view.requests).toHaveLength(2)
  view.requests[1]!.response.resolve(json([{ path: "fresh.ts", tokens: 2 }]))
  await view.frameContaining("fresh.ts")
  view.requests[0]!.response.resolve(json([{ path: "closed.ts", tokens: 9 }]))
  expect(await view.frameContaining("fresh.ts")).not.toContain("closed.ts")
})
