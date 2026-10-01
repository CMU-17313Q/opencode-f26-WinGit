import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createContextFiles, type ContextFile } from "../../src/util/context-files"

test("session changes abort the old load and ignore its late success or failure", async () => {
  const requests: {
    id: string
    signal: AbortSignal
    response: ReturnType<typeof Promise.withResolvers<ContextFile[]>>
  }[] = []
  const [session, setSession] = createSignal("first")
  const view = createRoot((dispose) => ({
    dispose,
    state: createContextFiles(session, (id, signal) => {
      const response = Promise.withResolvers<ContextFile[]>()
      requests.push({ id, signal, response })
      return response.promise
    }),
  }))
  try {
    expect(view.state.loading).toBe(true)
    setSession("second")
    expect(requests.map((item) => item.id)).toEqual(["first", "second"])
    expect(requests[0]!.signal.aborted).toBe(true)
    requests[1]!.response.resolve([{ path: "second.ts", tokens: 20 }])
    await requests[1]!.response.promise
    expect(view.state.files).toEqual([{ path: "second.ts", tokens: 20 }])
    requests[0]!.response.resolve([{ path: "stale.ts", tokens: 1 }])
    await requests[0]!.response.promise
    expect(view.state.files).toEqual([{ path: "second.ts", tokens: 20 }])
    setSession("third")
    expect(view.state.files).toEqual([])
    expect(view.state.loading).toBe(true)
    setSession("fourth")
    requests[2]!.response.reject(new Error("late failure"))
    await requests[2]!.response.promise.catch(() => {})
    expect(view.state.error).toBe(false)
    expect(view.state.loading).toBe(true)
    requests[3]!.response.resolve([])
    await requests[3]!.response.promise
    expect(view.state).toEqual({ files: [], loading: false, error: false })
  } finally {
    view.dispose()
  }
})

test("disposing aborts the request and prevents a late state update", async () => {
  const response = Promise.withResolvers<ContextFile[]>()
  let signal: AbortSignal | undefined
  const view = createRoot((dispose) => ({
    dispose,
    state: createContextFiles(
      () => "session",
      (_id, input) => {
        signal = input
        return response.promise
      },
    ),
  }))
  view.dispose()
  expect(signal?.aborted).toBe(true)
  response.resolve([{ path: "closed.ts", tokens: 10 }])
  await response.promise
  expect(view.state.files).toEqual([])
})
