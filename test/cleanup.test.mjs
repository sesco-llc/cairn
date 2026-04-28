import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseGitHubRemote,
  parseRepoSpecifier,
  repoSlug,
  worktreePathForPR,
  worktreesRoot,
} from "../dist/worktree.js";

const TEST_TMP_ROOT = process.env.CAIRN_TEST_TMPDIR ?? "/tmp";

test("repoSlug uses the same dash-joined owner and repo layout as review worktrees", () => {
  assert.equal(repoSlug("sesco", "cairn"), "sesco-cairn");
});

test("worktreePathForPR points at the per-PR worktree directory", () => {
  assert.equal(
    worktreePathForPR("sesco", "cairn", 42),
    path.join(os.homedir(), ".cairn", "worktrees", "sesco-cairn", "42"),
  );
});

test("worktreesRoot can be overridden for hermetic cleanup tests", () => {
  const previous = process.env.CAIRN_WORKTREES_ROOT;
  process.env.CAIRN_WORKTREES_ROOT = path.join(TEST_TMP_ROOT, "cairn-test-worktrees");

  try {
    assert.equal(worktreesRoot(), path.join(TEST_TMP_ROOT, "cairn-test-worktrees"));
    assert.equal(
      worktreePathForPR("sesco", "cairn", 42),
      path.join(TEST_TMP_ROOT, "cairn-test-worktrees", "sesco-cairn", "42"),
    );
  } finally {
    if (previous === undefined) delete process.env.CAIRN_WORKTREES_ROOT;
    else process.env.CAIRN_WORKTREES_ROOT = previous;
  }
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
