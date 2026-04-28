import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseGitHubRemote,
  parseRepoSpecifier,
  repoSlug,
  worktreePathForPR,
} from "../dist/worktree.js";

test("repoSlug uses the same dash-joined owner and repo layout as review worktrees", () => {
  assert.equal(repoSlug("sesco", "cairn"), "sesco-cairn");
});

test("worktreePathForPR points at the per-PR worktree directory", () => {
  assert.equal(
    worktreePathForPR("sesco", "cairn", 42),
    path.join(os.homedir(), ".cairn", "worktrees", "sesco-cairn", "42"),
  );
});

test("parseRepoSpecifier accepts owner/repo cleanup arguments", () => {
  assert.deepEqual(parseRepoSpecifier("sesco/cairn"), {
    owner: "sesco",
    repo: "cairn",
  });
});

test("parseGitHubRemote understands GitHub HTTPS and SSH remotes", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/sesco/cairn.git"), {
    owner: "sesco",
    repo: "cairn",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:sesco/cairn.git"), {
    owner: "sesco",
    repo: "cairn",
  });
});
