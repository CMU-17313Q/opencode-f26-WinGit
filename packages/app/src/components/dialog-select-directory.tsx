import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List } from "@opencode-ai/ui/list"
import type { ListRef } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createMemo, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { usePlatform } from "@/context/platform"
import { authTokenFromCredentials } from "@/utils/server"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { cleanPickerInput, createDirectorySearch, displayPickerPath } from "./directory-picker-domain"
import type { Path } from "@opencode-ai/sdk/v2/client"

interface DialogSelectDirectoryProps {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
  server: ServerConnection.Any
}

const RECENT_PROJECT_LIMIT = 5

type Row = {
  absolute: string
  search: string
  group: "recent" | "folders"
}

function toRow(absolute: string, home: string, group: Row["group"]): Row {
  const full = displayPickerPath(absolute, "", "")
  const tilde = displayPickerPath(full, "~", home)
  const withSlash = (value: string) => {
    if (!value) return ""
    if (value.endsWith("/")) return value
    return value + "/"
  }

  const search = Array.from(
    new Set([full, withSlash(full), tilde, withSlash(tilde), getFilename(full)].filter(Boolean)),
  ).join("\n")
  return { absolute: full, search, group }
}

function uniqueRows(rows: Row[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.absolute)) return false
    seen.add(row.absolute)
    return true
  })
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const global = useGlobal()
  const { sync, sdk, ...serverCtx } = global.ensureServerCtx(props.server)
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const [filter, setFilter] = createSignal("")
  let list: ListRef | undefined

  const missingHome = createMemo(() => !sync.data.path.home)
  const [fallbackPath] = createResource(
    () => (missingHome() ? true : undefined),
    async (): Promise<Path | undefined> => {
      if ((await sdk.protocol) !== "v1") return
      return sdk.client.path
        .get()
        .then((result) => result.data)
        .catch(() => undefined)
    },
    { initialValue: undefined },
  )

  const home = createMemo(() => sync.data.path.home || fallbackPath()?.home || "")
  const start = createMemo(
    () => sync.data.path.home || sync.data.path.directory || fallbackPath()?.home || fallbackPath()?.directory,
  )

  const directories = createDirectorySearch({
    sdk,
    home,
    base: start,
  })

  const recentProjects = createMemo(() => {
    const projects = serverCtx.projects.list()
    const byProject = new Map<string, number>()

    for (const project of projects) {
      let at = 0
      const dirs = [project.worktree, ...(project.sandboxes ?? [])]
      for (const directory of dirs) {
        const sessions = sync.child(directory, { bootstrap: false })[0].session
        for (const session of sessions) {
          if (session.time.archived) continue
          const updated = session.time.updated ?? session.time.created
          if (updated > at) at = updated
        }
      }
      byProject.set(project.worktree, at)
    }

    return projects
      .map((project, index) => ({ project, at: byProject.get(project.worktree) ?? 0, index }))
      .sort((a, b) => b.at - a.at || a.index - b.index)
      .map(({ project }) => {
        const row = toRow(project.worktree, home(), "recent")
        const name = project.name || getFilename(project.worktree)
        return {
          ...row,
          search: `${row.search}\n${name}`,
        }
      })
  })

  const items = async (value: string) => {
    const results = await directories(value)
    const directoryRows = results.map((absolute) => toRow(absolute, home(), "folders"))
    // Cap the idle list only. Once a query narrows the results, every project stays searchable.
    const recent = recentProjects()
    const visible = value ? recent : recent.slice(0, RECENT_PROJECT_LIMIT)
    return uniqueRows([...visible, ...directoryRows])
  }

  function resolve(absolute: string) {
    props.onSelect(props.multiple ? [absolute] : absolute)
    dialog.close()
  }

  const [cloneUrl, setCloneUrl] = createSignal("")
  const [cloneError, setCloneError] = createSignal<string>()
  const [cloning, setCloning] = createSignal(false)

  // Clones a public https repo into ~/projects/<name> on the server, then opens it like a picked folder.
  async function clone(event: SubmitEvent) {
    event.preventDefault()
    const url = cloneUrl().trim()
    if (!url || cloning()) return
    setCloning(true)
    setCloneError(undefined)
    const http = props.server.http
    const result = await (platform.fetch ?? globalThis.fetch)(new URL("/experimental/clone", http.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(http.password
          ? { Authorization: `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}` }
          : {}),
      },
      body: JSON.stringify({ url }),
    })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .catch((error: unknown) => ({ ok: false, body: { error: String(error) } }))
    setCloning(false)
    if (result.ok && typeof result.body.directory === "string") return resolve(result.body.directory)
    setCloneError(typeof result.body.error === "string" ? result.body.error : "Clone failed")
  }

  return (
    <Dialog title={props.title ?? language.t("command.project.open")}>
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.directory.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.directory.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(x) => x.absolute}
        filterKeys={["search"]}
        groupBy={(item) => item.group}
        sortGroupsBy={(a, b) => {
          if (a.category === b.category) return 0
          return a.category === "recent" ? -1 : 1
        }}
        groupHeader={(group) =>
          group.category === "recent" ? language.t("home.recentProjects") : language.t("command.project.open")
        }
        ref={(r) => (list = r)}
        onFilter={(value) => setFilter(cleanPickerInput(value))}
        onKeyEvent={(e, item) => {
          if (e.key !== "Tab") return
          if (e.shiftKey) return
          if (!item) return

          e.preventDefault()
          e.stopPropagation()

          const value = displayPickerPath(item.absolute, filter(), home())
          list?.setFilter(value.endsWith("/") ? value : value + "/")
        }}
        onSelect={(path) => {
          if (!path) return
          resolve(path.absolute)
        }}
      >
        {(item) => {
          const path = displayPickerPath(item.absolute, filter(), home())
          if (path === "~") {
            return (
              <div data-directory-path={item.absolute} class="w-full flex items-center justify-between rounded-md">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-14-regular min-w-0">
                    <span class="text-text-strong whitespace-nowrap">~</span>
                    <span class="text-text-weak whitespace-nowrap">/</span>
                  </div>
                </div>
              </div>
            )
          }
          return (
            <div data-directory-path={item.absolute} class="w-full flex items-center justify-between rounded-md">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                    {getDirectory(path)}
                  </span>
                  <span class="text-text-strong whitespace-nowrap">{getFilename(path)}</span>
                  <span class="text-text-weak whitespace-nowrap">/</span>
                </div>
              </div>
            </div>
          )
        }}
      </List>
      <form class="flex items-start gap-2 px-3 pb-3 pt-2 border-t border-border-weak-base" onSubmit={clone}>
        <TextField
          class="grow"
          label="Clone from git URL"
          placeholder="https://github.com/owner/repo.git"
          description="Public HTTPS repos only. Cloned into ~/projects on the server."
          value={cloneUrl()}
          onChange={setCloneUrl}
          error={cloneError()}
          validationState={cloneError() ? "invalid" : undefined}
          disabled={cloning()}
          spellcheck={false}
        />
        <Button type="submit" variant="primary" size="large" class="mt-6" disabled={cloning() || !cloneUrl().trim()}>
          {cloning() ? "Cloning..." : "Clone"}
        </Button>
      </form>
    </Dialog>
  )
}
