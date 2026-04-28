import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupTargets,
  listCleanupTargets,
} from "../dist/worktree.js";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CLI_PATH = path.join(REPO_ROOT, "dist", "index.js");
const OWNER = "sesco-llc";
const REPO = "cairn";
const SLUG = `${OWNER}-${REPO}`;
const TEST_TMP_ROOT = process.env.CAIRN_TEST_TMPDIR ?? "/tmp";

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${stderr || stdout}`));
    });
    proc.stdin.end(options.stdin ?? "");
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end();
  });
}

async function withEnv(env, action) {
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);

  try {
    return await action();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

async function makeTempRoot() {
  return fs.mkdtemp(path.join(TEST_TMP_ROOT, "cairn-cleanup-"));
}

async function createBareCleanupTree(numbers = [1]) {
  const temp = await makeTempRoot();
  const worktreesRoot = path.join(temp, "worktrees");

  await Promise.all(
    numbers.map((number) =>
      fs.mkdir(path.join(worktreesRoot, SLUG, String(number)), { recursive: true }),
    ),
  );

  return {
    temp,
    worktreesRoot,
    env: { CAIRN_WORKTREES_ROOT: worktreesRoot },
  };
}

async function createGitWorktreeFixture() {
  const temp = await makeTempRoot();
  const home = path.join(temp, "home");
  const parent = path.join(temp, "parent");
  const worktreesRoot = path.join(temp, "worktrees");
  const worktreePath = path.join(worktreesRoot, SLUG, "123");

  await Promise.all([
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(parent, { recursive: true }),
    fs.mkdir(path.dirname(worktreePath), { recursive: true }),
  ]);

  await run("git", ["init"], { cwd: parent });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: parent });
  await run("git", ["config", "user.name", "Cairn Test"], { cwd: parent });
  await run("git", ["remote", "add", "origin", `https://github.com/${OWNER}/${REPO}.git`], { cwd: parent });
  await fs.writeFile(path.join(parent, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: parent });
  await run("git", ["commit", "-m", "Initial fixture"], { cwd: parent });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: parent });
  const sha = stdout.trim();

  await fs.mkdir(path.join(home, ".cairn"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".cairn", "repos.json"),
    JSON.stringify({ [`${OWNER}/${REPO}`]: parent }),
  );
  await run("git", ["worktree", "add", "--detach", worktreePath, sha], { cwd: parent });

  return {
    temp,
    home,
    parent,
    worktreesRoot,
    worktreePath,
    env: {
      CAIRN_WORKTREES_ROOT: worktreesRoot,
      HOME: home,
    },
  };
}

test("cleanup CLI rejects --list and --dry-run together", async () => {
  const fixture = await createBareCleanupTree();
  const result = await runCli(["cleanup", "--list", "--dry-run"], fixture.env);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--list and --dry-run cannot be combined\./);
});

test("cleanup CLI requires an explicit scope for bare --dry-run", async () => {
  const fixture = await createBareCleanupTree();
  const result = await runCli(["cleanup", "--dry-run"], fixture.env);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /requires an explicit scope/);
});

test("cleanup CLI rejects conflicting cleanup scopes", async () => {
  const fixture = await createBareCleanupTree();
  const result = await runCli(["cleanup", "--all", "--repo", `${OWNER}/${REPO}`], fixture.env);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Use only one cleanup target/);
});

test("cleanup CLI accepts owner/repo as a positional repo scope", async () => {
  const fixture = await createBareCleanupTree([1, 2]);
  const result = await runCli(["cleanup", `${OWNER}/${REPO}`, "--dry-run"], fixture.env);

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`would remove .*${SLUG}.1`));
  assert.match(result.stdout, new RegExp(`would remove .*${SLUG}.2`));
});

test("cleanup CLI refuses --all non-TTY removal without --yes", async () => {
  const fixture = await createBareCleanupTree([1]);
  const result = await runCli(["cleanup", "--all"], fixture.env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--yes/);
  assert.equal(await pathExists(path.join(fixture.worktreesRoot, SLUG, "1")), true);
});

test("cleanup CLI refuses multi-worktree repo removal without --yes", async () => {
  const fixture = await createBareCleanupTree([1, 2]);
  const result = await runCli(["cleanup", `${OWNER}/${REPO}`], fixture.env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--yes/);
  assert.equal(await pathExists(path.join(fixture.worktreesRoot, SLUG, "1")), true);
  assert.equal(await pathExists(path.join(fixture.worktreesRoot, SLUG, "2")), true);
});

test("cleanup CLI allows broad non-TTY removal with --yes", async () => {
  const fixture = await createBareCleanupTree([1, 2]);
  const result = await runCli(["cleanup", "--all", "--yes"], fixture.env);

  assert.equal(result.code, 0);
  assert.equal(await pathExists(path.join(fixture.worktreesRoot, SLUG, "1")), false);
  assert.equal(await pathExists(path.join(fixture.worktreesRoot, SLUG, "2")), false);
});

test("listCleanupTargets finds a real git worktree under the injected root", { skip: process.platform === "win32" }, async () => {
  const fixture = await createGitWorktreeFixture();

  await withEnv(fixture.env, async () => {
    const targets = await listCleanupTargets({ kind: "all" });

    assert.equal(targets.length, 1);
    assert.equal(targets[0].worktreePath, fixture.worktreePath);
    assert.equal(targets[0].localClonePath, fixture.parent);
  });
});

test("cleanupTargets dry-run leaves a real git worktree intact", { skip: process.platform === "win32" }, async () => {
  const fixture = await createGitWorktreeFixture();

  await withEnv(fixture.env, async () => {
    const targets = await listCleanupTargets({ kind: "all" });
    const results = await cleanupTargets(targets, { dryRun: true });
    const { stdout } = await run("git", ["worktree", "list"], { cwd: fixture.parent });

    assert.equal(results[0].method, "dry-run");
    assert.equal(await pathExists(fixture.worktreePath), true);
    assert.match(stdout, new RegExp(fixture.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("cleanupTargets removes a real git worktree and clears git admin state", { skip: process.platform === "win32" }, async () => {
  const fixture = await createGitWorktreeFixture();

  await withEnv(fixture.env, async () => {
    const targets = await listCleanupTargets({ kind: "all" });
    const results = await cleanupTargets(targets, { dryRun: false });
    const { stdout } = await run("git", ["worktree", "list"], { cwd: fixture.parent });

    assert.equal(results[0].method, "git-worktree-remove");
    assert.equal(await pathExists(fixture.worktreePath), false);
    assert.doesNotMatch(stdout, new RegExp(fixture.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("cleanupTargets falls back to rm-rf when the parent clone is missing", { skip: process.platform === "win32" }, async () => {
  const fixture = await createBareCleanupTree([123]);
  const target = {
    slug: SLUG,
    number: 123,
    worktreePath: path.join(fixture.worktreesRoot, SLUG, "123"),
    sizeBytes: 0,
    owner: OWNER,
    repo: REPO,
    localClonePath: null,
  };

  await withEnv(fixture.env, async () => {
    const results = await cleanupTargets([target], { dryRun: false });

    assert.equal(results[0].method, "rm-rf");
    assert.match(results[0].warning, /parent clone not found/);
    assert.equal(await pathExists(target.worktreePath), false);
  });
});

test("cleanupTargets refuses to rm-rf outside the worktrees root", { skip: process.platform === "win32" }, async () => {
  const fixture = await createBareCleanupTree([123]);
  const outside = path.join(fixture.temp, "outside");
  await fs.mkdir(outside);

  const target = {
    slug: SLUG,
    number: 123,
    worktreePath: outside,
    sizeBytes: 0,
    owner: OWNER,
    repo: REPO,
    localClonePath: null,
  };

  await withEnv(fixture.env, async () => {
    await assert.rejects(
      cleanupTargets([target], { dryRun: false }),
      /Refusing to remove cleanup target outside/,
    );
    assert.equal(await pathExists(outside), true);
  });
});
