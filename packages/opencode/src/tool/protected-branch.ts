import { Effect } from "effect"
import type { Tool } from "./tool"
import { Config } from "@/config/config"
import { Vcs } from "@/project/vcs"

const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "develop"]

export const assertProtectedBranchEffect = Effect.fn("Tool.assertProtectedBranch")(function* (
  ctx: Tool.Context,
  vcs: Vcs.Interface,
  config: Config.Interface,
) {
  const branch = yield* vcs.branch()
  if (!branch) return false

  const cfg = yield* config.get()
  const protectedBranches = cfg.protected_branches ?? DEFAULT_PROTECTED_BRANCHES

  if (!protectedBranches.includes(branch)) return false

  yield* ctx.ask({
    permission: "protected_branch",
    patterns: [branch],
    always: [],
    metadata: {
      branch,
      protectedBranches,
    },
  })

  return true
})
