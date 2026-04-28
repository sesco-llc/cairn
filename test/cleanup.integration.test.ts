import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTargets,
  listCleanupTargets,
} from "../src/worktree.js";
import type { CleanupTarget } from "../src/worktree.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

interface BareCleanupTree {
  temp: string;
  worktreesRoot: string;
  env: Record<string, string>;
}

interface GitWorktreeFixture extends BareCleanupTree {
  home: string;
  parent: string;
  worktreePath: string;
}

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CLI_PATH = path.join(REPO_ROOT, "dist", "index.js");
const OWNER = "sesco-llc";
const REPO = "cairn";
const SLUG = `${OWNER}-${REPO}`;
const TEST_TMP_ROOT = process.env.CAIRN_TEST_TMPDIR ?? "/tmp";

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: ReadonlyArray<string>, options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
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

function runCli(args: ReadonlyArray<string>, env: Readonly<Record<string, string>>): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.stdin.end();
  });
}

async function withEnv<T>(env: Readonly<Record<string, string>>, action: () => Promise<T>): Promise<T> {
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

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(TEST_TMP_ROOT, "cairn-cleanup-"));
}

async function createBareCleanupTree(numbers: ReadonlyArray<number> = [1]): Promise<BareCleanupTree> {
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

async function createGitWorktreeFixture(): Promise<GitWorktreeFixture> {
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

function firstResult<T>(items: ReadonlyArray<T>): T {
  const first = items[0];
  if (first === undefined) throw new Error("Expected at least one result");
  return first;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

beforeAll(async () => {
  if (!(await pathExists(CLI_PATH))) {
    await run("pnpm", ["build"], { cwd: REPO_ROOT });
  }
}, 15_000);

describe("cleanup CLI", () => {
  it("rejects --list and --dry-run together", async () => {
    const fixture = await createBareCleanupTree();
    const result = await runCli(["cleanup", "--list", "--dry-run"], fixture.env);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--list and --dry-run cannot be combined\./);
  });

  it("requires an explicit scope for bare --dry-run", async () => {
    const fixture = await createBareCleanupTree();
    const result = await runCli(["cleanup", "--dry-run"], fixture.env);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/requires an explicit scope/);
  });

  it("rejects conflicting cleanup scopes", async () => {
    const fixture = await createBareCleanupTree();
    const result = await runCli(["cleanup", "--all", "--repo", `${OWNER}/${REPO}`], fixture.env);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Use only one cleanup target/);
  });

  it("accepts owner/repo as a positional repo scope", async () => {
    const fixture = await createBareCleanupTree([1, 2]);
    const result = await runCli(["cleanup", `${OWNER}/${REPO}`, "--dry-run"], fixture.env);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`would remove .*${SLUG}.1`));
    expect(result.stdout).toMatch(new RegExp(`would remove .*${SLUG}.2`));
  });

  it("refuses --all non-TTY removal without --yes", async () => {
    const fixture = await createBareCleanupTree([1]);
    const result = await runCli(["cleanup", "--all"], fixture.env);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--yes/);
    expect(await pathExists(path.join(fixture.worktreesRoot, SLUG, "1"))).toBe(true);
  });

  it("refuses multi-worktree repo removal without --yes", async () => {
    const fixture = await createBareCleanupTree([1, 2]);
    const result = await runCli(["cleanup", `${OWNER}/${REPO}`], fixture.env);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--yes/);
    expect(await pathExists(path.join(fixture.worktreesRoot, SLUG, "1"))).toBe(true);
    expect(await pathExists(path.join(fixture.worktreesRoot, SLUG, "2"))).toBe(true);
  });

  it("allows broad non-TTY removal with --yes", async () => {
    const fixture = await createBareCleanupTree([1, 2]);
    const result = await runCli(["cleanup", "--all", "--yes"], fixture.env);

    expect(result.code).toBe(0);
    expect(await pathExists(path.join(fixture.worktreesRoot, SLUG, "1"))).toBe(false);
    expect(await pathExists(path.join(fixture.worktreesRoot, SLUG, "2"))).toBe(false);
  });
});

describe("cleanupTargets", () => {
  it.skipIf(process.platform === "win32")("listCleanupTargets finds a real git worktree under the injected root", async () => {
    const fixture = await createGitWorktreeFixture();

    await withEnv(fixture.env, async () => {
      const targets = await listCleanupTargets({ kind: "all" });
      const target = firstResult(targets);

      expect(targets).toHaveLength(1);
      expect(target.worktreePath).toBe(fixture.worktreePath);
      expect(target.localClonePath).toBe(fixture.parent);
    });
  });

  it.skipIf(process.platform === "win32")("cleanupTargets dry-run leaves a real git worktree intact", async () => {
    const fixture = await createGitWorktreeFixture();

    await withEnv(fixture.env, async () => {
      const targets = await listCleanupTargets({ kind: "all" });
      const results = await cleanupTargets(targets, { dryRun: true });
      const result = firstResult(results);
      const { stdout } = await run("git", ["worktree", "list"], { cwd: fixture.parent });

      expect(result.method).toBe("dry-run");
      expect(await pathExists(fixture.worktreePath)).toBe(true);
      expect(stdout).toMatch(new RegExp(escapeRegExp(fixture.worktreePath)));
    });
  });

  it.skipIf(process.platform === "win32")("cleanupTargets removes a real git worktree and clears git admin state", async () => {
    const fixture = await createGitWorktreeFixture();

    await withEnv(fixture.env, async () => {
      const targets = await listCleanupTargets({ kind: "all" });
      const results = await cleanupTargets(targets, { dryRun: false });
      const result = firstResult(results);
      const { stdout } = await run("git", ["worktree", "list"], { cwd: fixture.parent });

      expect(result.method).toBe("git-worktree-remove");
      expect(await pathExists(fixture.worktreePath)).toBe(false);
      expect(stdout).not.toMatch(new RegExp(escapeRegExp(fixture.worktreePath)));
    });
  });

  it.skipIf(process.platform === "win32")("cleanupTargets falls back to rm-rf when the parent clone is missing", async () => {
    const fixture = await createBareCleanupTree([123]);
    const target: CleanupTarget = {
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
      const result = firstResult(results);

      expect(result.method).toBe("rm-rf");
      expect(result.warning).toMatch(/parent clone not found/);
      expect(await pathExists(target.worktreePath)).toBe(false);
    });
  });

  it.skipIf(process.platform === "win32")("cleanupTargets refuses to rm-rf outside the worktrees root", async () => {
    const fixture = await createBareCleanupTree([123]);
    const outside = path.join(fixture.temp, "outside");
    await fs.mkdir(outside);

    const target: CleanupTarget = {
      slug: SLUG,
      number: 123,
      worktreePath: outside,
      sizeBytes: 0,
      owner: OWNER,
      repo: REPO,
      localClonePath: null,
    };

    await withEnv(fixture.env, async () => {
      await expect(cleanupTargets([target], { dryRun: false })).rejects.toThrow(
        /Refusing to remove cleanup target outside/,
      );
      expect(await pathExists(outside)).toBe(true);
    });
  });
});
