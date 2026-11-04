import path from "path"
import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Git } from "@/git"

// Clones a public HTTPS git repository into ~/projects/<name> so the web UI can open it as a project.
// Raw route (outside the typed HttpApi) so it needs no SDK regeneration or exerciser scenario.
export const route = "/experimental/clone"

const Payload = Schema.Struct({ url: Schema.String })

export function handler(input: { git: Git.Interface; fs: FSUtil.Interface }) {
  return Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(Payload).pipe(Effect.option)
    if (Option.isNone(body)) return error(400, 'Expected a JSON body like { "url": "https://..." }')
    const url = body.value.url.trim()
    const name = repoName(url)
    if (!name) return error(400, "Only public https:// git URLs are supported")

    const parent = path.join(Global.Path.home, "projects")
    const directory = path.join(parent, name)
    if (yield* input.fs.existsSafe(directory)) return HttpServerResponse.jsonUnsafe({ directory, existing: true })

    yield* input.fs.ensureDir(parent)
    // Disable credential prompts and helpers so private or missing repos fail fast instead of hanging.
    const result = yield* input.git.run(["-c", "credential.helper=", "clone", "--", url, directory], {
      cwd: parent,
      env: { GIT_TERMINAL_PROMPT: "0" },
    })
    const stderr = result.stderr.toString("utf8").trim()
    // With prompts disabled, git reports missing and private repos as an auth failure.
    if (stderr.includes("could not read Username")) return error(422, "Repository not found or not public")
    if (result.exitCode !== 0) return error(422, stderr || "git clone failed")
    return HttpServerResponse.jsonUnsafe({ directory, existing: false })
  }).pipe(Effect.catch((cause) => Effect.succeed(error(500, String(cause)))))
}

export function repoName(url: string) {
  const parsed = URL.parse(url)
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) return
  const name = parsed.pathname
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/, "")
  if (!name || name.startsWith(".") || !/^[\w.-]+$/.test(name)) return
  return name
}

function error(status: number, message: string) {
  return HttpServerResponse.jsonUnsafe({ error: message }, { status })
}

export * as ProjectClone from "./clone"
