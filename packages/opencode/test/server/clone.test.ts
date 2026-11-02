import { describe, expect, test } from "bun:test"
import { ProjectClone } from "../../src/server/routes/instance/httpapi/clone"

describe("ProjectClone.repoName", () => {
  test("derives the folder name from public https URLs", () => {
    expect(ProjectClone.repoName("https://github.com/octocat/Hello-World.git")).toBe("Hello-World")
    expect(ProjectClone.repoName("https://github.com/octocat/Hello-World")).toBe("Hello-World")
    expect(ProjectClone.repoName("https://gitlab.com/group/sub/my_repo.git/")).toBe("my_repo")
  })

  test("rejects non-https, credentialed, and unsafe URLs", () => {
    expect(ProjectClone.repoName("git@github.com:octocat/Hello-World.git")).toBeUndefined()
    expect(ProjectClone.repoName("http://github.com/octocat/Hello-World")).toBeUndefined()
    expect(ProjectClone.repoName("file:///etc/passwd")).toBeUndefined()
    expect(ProjectClone.repoName("https://user:token@github.com/octocat/Hello-World")).toBeUndefined()
    expect(ProjectClone.repoName("https://github.com/octocat/..")).toBeUndefined()
    expect(ProjectClone.repoName("https://github.com/")).toBeUndefined()
    expect(ProjectClone.repoName("not a url")).toBeUndefined()
  })
})
