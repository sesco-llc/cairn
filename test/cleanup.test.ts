import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseGitHubRemote,
  parseRepoSpecifier,
  repoSlug,
  worktreePathForPR,
  worktreesRoot,
} from "../src/worktree.js";

const TEST_TMP_ROOT = process.env.CAIRN_TEST_TMPDIR ?? "/tmp";

describe("cleanup worktree helpers", () => {
  it("repoSlug uses the same dash-joined owner and repo layout as review worktrees", () => {
    expect(repoSlug("sesco", "cairn")).toBe("sesco-cairn");
  });

  it("worktreePathForPR points at the per-PR worktree directory", () => {
    expect(worktreePathForPR("sesco", "cairn", 42)).toBe(
      path.join(os.homedir(), ".cairn", "worktrees", "sesco-cairn", "42"),
    );
  });

  it("worktreesRoot can be overridden for hermetic cleanup tests", () => {
    const previous = process.env.CAIRN_WORKTREES_ROOT;
    process.env.CAIRN_WORKTREES_ROOT = path.join(TEST_TMP_ROOT, "cairn-test-worktrees");

    try {
      expect(worktreesRoot()).toBe(path.join(TEST_TMP_ROOT, "cairn-test-worktrees"));
      expect(worktreePathForPR("sesco", "cairn", 42)).toBe(
        path.join(TEST_TMP_ROOT, "cairn-test-worktrees", "sesco-cairn", "42"),
      );
    } finally {
      if (previous === undefined) delete process.env.CAIRN_WORKTREES_ROOT;
      else process.env.CAIRN_WORKTREES_ROOT = previous;
    }
  });

  it("parseRepoSpecifier accepts owner/repo cleanup arguments", () => {
    expect(parseRepoSpecifier("sesco/cairn")).toEqual({
      owner: "sesco",
      repo: "cairn",
    });
  });

  it("parseGitHubRemote understands GitHub HTTPS and SSH remotes", () => {
    expect(parseGitHubRemote("https://github.com/sesco/cairn.git")).toEqual({
      owner: "sesco",
      repo: "cairn",
    });
    expect(parseGitHubRemote("git@github.com:sesco/cairn.git")).toEqual({
      owner: "sesco",
      repo: "cairn",
    });
  });
});
