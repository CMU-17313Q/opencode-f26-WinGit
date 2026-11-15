
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { assertProtectedBranchEffect } from "../../src/tool/protected-branch"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import type { Vcs } from "../../src/project/vcs"
import type { Config } from "../../src/config/config"

async function checkBranch(branch: string | undefined, protectedBranches: string[]) {
  const requests: Parameters<Tool.Context["ask"]>[0][] = []

  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_property"),
    messageID: MessageID.make("msg_property"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
      }),
  }

  // Only the methods used by the safeguard need test doubles.
  const vcs = {
    branch: () => Effect.succeed(branch),
  } as unknown as Vcs.Interface

  const config = {
    get: () => Effect.succeed({ protected_branches: protectedBranches }),
  } as unknown as Config.Interface

  const result = await Effect.runPromise(
    assertProtectedBranchEffect(ctx, vcs, config),
  )

  return { result, requests }
}

describe("Feature-Branch Safeguard properties", () => {
  // R3: OpenCode must respect the explicitly configured protected-branch
  // list, including when a previously protected branch is removed.
  // Kind: metamorphic.
  // Generator: common protected branches plus random valid-looking names,
  // including configurations with unrelated protected branches.
  test("R3: adding and removing protection changes confirmation behavior", async () => {
    const branchArb = fc.oneof(
      fc.constantFrom("main", "master", "develop", "production"),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/),
    )

    await fc.assert(
      fc.asyncProperty(
        branchArb,
        fc.uniqueArray(branchArb, { maxLength: 8 }),
        async (branch, otherBranches) => {
          const without = otherBranches.filter((b) => b !== branch)

          const before = await checkBranch(branch, without)
          const added = await checkBranch(branch, [...without, branch])
          const removed = await checkBranch(branch, without)

          expect(before.result).toBe(false)
          expect(before.requests).toHaveLength(0)

          expect(added.result).toBe(true)
          expect(added.requests).toHaveLength(1)
          expect(added.requests[0]?.permission).toBe("protected_branch")
          expect(added.requests[0]?.patterns).toEqual([branch])

          expect(removed.result).toBe(false)
          expect(removed.requests).toHaveLength(0)
        },
      ),
      { numRuns: 100 },
    )

    console.log("[property] R3: custom branch configurations passed")

  })


  // R4: An explicitly empty protected-branch list must
  // disable the protected-branch safeguard.
  // Kind: invariant.
  // Generator: default, custom, and randomly generated
  // branch names to verify that none triggers confirmation.
  test("R4: empty protected branch list disables the safeguard", async () => {
    const branchArb = fc.oneof(
      fc.constantFrom("main", "master", "develop", "production"),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
    )

    await fc.assert(
      fc.asyncProperty(branchArb, async (branch) => {
        const outcome = await checkBranch(branch, [])

        expect(outcome.result).toBe(false)
        expect(outcome.requests).toHaveLength(0)
      }),
      { numRuns: 100 },
    )

    console.log("[property] R4: empty protected list passed")
  })

  // R5: OpenCode must skip protected-branch confirmation
  // when operating outside a Git repository.
  // Kind: invariant.
  // Generator: different protected-branch configurations,
  // including default and randomly generated branch names.
  test("R5: no Git branch skips protected-branch confirmation", async () => {
    const branchArb = fc.oneof(
      fc.constantFrom("main", "master", "develop", "production"),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
    )

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(branchArb, { maxLength: 10 }),
        async (protectedBranches) => {
          const outcome = await checkBranch(undefined, protectedBranches)

          expect(outcome.result).toBe(false)
          expect(outcome.requests).toHaveLength(0)
        },
      ),
      { numRuns: 100 },
    )

    console.log("[property] R5: non-Git branch detection passed")
  })
})
