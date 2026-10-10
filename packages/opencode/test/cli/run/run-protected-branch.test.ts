import { $ } from "bun"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"

const summaryMarker = "plain-language summary"

describe("opencode run protected-branch subagents", () => {
  for (const auto of [false, true]) {
    for (const summary of [false, true]) {
      cliIt.live(
        `${auto ? "auto approves" : "rejects"} a child edit on main ${summary ? "with" : "without"} summaries`,
        ({ llm, opencode, home }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => $`git init -b main`.cwd(home).quiet())
            const filepath = path.join(home, "child.txt")
            yield* Effect.promise(() => Bun.write(filepath, "original protected content"))
            yield* Effect.promise(() => $`git add child.txt`.cwd(home).quiet())
            yield* Effect.promise(() =>
              $`git -c user.name=CLI-Test -c user.email=cli-test@example.invalid commit -m fixture`.cwd(home).quiet(),
            )

            const childRequest = (hit: { body: Record<string, unknown> }) =>
              (hit.body.messages as { role?: string; content?: unknown }[] | undefined)?.some(
                (message) => message.role === "user" && JSON.stringify(message.content).includes("CHILD_TASK_PROMPT"),
              ) ?? false
            yield* llm.push(
              reply().tool("task", {
                description: "Edit the protected child note",
                prompt: "CHILD_TASK_PROMPT: edit child.txt",
                subagent_type: "general",
              }),
            )
            yield* llm.pushMatch(
              childRequest,
              reply().tool("edit", {
                filePath: "child.txt",
                oldString: "original protected content",
                newString: "updated protected content",
              }),
            )
            yield* llm.textMatch(
              (hit) => JSON.stringify(hit.body).includes(summaryMarker),
              "PROTECTED_CHILD_SUMMARY explains the original note.",
            )
            yield* llm.textMatch(childRequest, "PRIVATE_CHILD_FINAL")
            yield* llm.textMatch(
              (hit) => !childRequest(hit) && !JSON.stringify(hit.body).includes(summaryMarker),
              "root finished",
            )

            const result = yield* opencode.run("delegate the file change", {
              timeoutMs: 90_000,
              extraArgs: [
                ...(auto ? ["--auto"] : []),
                ...(summary ? ["--summary"] : []),
                "--title",
                "Protected child test",
                "--dir",
                home,
              ],
            })
            opencode.expectExit(result, 0)
            expect(result.stdout).toBe("root finished\n")
            expect(result.stdout + result.stderr).not.toContain("PRIVATE_CHILD_FINAL")
            expect(result.stderr).not.toContain("Edit child.txt")
            expect(yield* Effect.promise(() => Bun.file(filepath).text())).toBe(
              auto ? "updated protected content" : "original protected content",
            )
            if (auto) expect(result.stderr).not.toContain("auto-rejecting")
            else expect(result.stderr).toContain("permission requested: protected_branch (main); auto-rejecting")

            const hits = yield* llm.hits
            const summaries = hits.filter((hit) => JSON.stringify(hit.body).includes(summaryMarker))
            expect(summaries).toHaveLength(auto && summary ? 1 : 0)
            if (auto && summary) expect(result.stderr.split("PROTECTED_CHILD_SUMMARY")).toHaveLength(2)
            else expect(result.stderr).not.toContain("PROTECTED_CHILD_SUMMARY")
          }),
        90_000,
      )
    }
  }
})
