import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the working tree checked out at the PR's head SHA. */
  worktreePath: string;
  /** The user's own clone of the repo (where we fetch the PR ref). */
  localClonePath: string;
  headSha: string;
  ephemeral: boolean;
}

interface RunOptions {
  cwd?: string;
}

function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => reject(new Error(`spawn ${cmd}: ${e.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(" ")} (cwd=${opts.cwd ?? "."}) exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function worktreesRoot(): string {
  return path.join(os.homedir(), ".cairn", "worktrees");
}

/**
 * Try to find a local clone for `<owner>/<repo>` from the registry.
 *
 * Registry format: a JSON file at ~/.cairn/repos.json with
 *   { "owner/repo": "/absolute/path", ... }
 *
 * Plus a list of common roots (~/code, ~/dev, ~/src, $GOPATH/src/github.com)
 * that we walk one level deep to auto-detect repos by directory name.
 */
export async function findLocalClone(owner: string, repo: string): Promise<string | null> {
  const registryPath = path.join(os.homedir(), ".cairn", "repos.json");
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const reg = JSON.parse(raw) as Record<string, string>;
    const explicit = reg[`${owner}/${repo}`];
    if (explicit && (await isGitRepo(explicit))) return explicit;
  } catch {
    // no registry or unreadable
  }

  const candidateRoots = [
    path.join(os.homedir(), "code"),
    path.join(os.homedir(), "dev"),
    path.join(os.homedir(), "src"),
    path.join(os.homedir(), "Projects"),
    path.join(os.homedir(), "projects"),
  ];
  for (const root of candidateRoots) {
    if (!(await pathExists(root))) continue;
    const entries = await fs.readdir(root).catch(() => [] as string[]);
    if (entries.includes(repo)) {
      const candidate = path.join(root, repo);
      if (await isMatchingRepo(candidate, owner, repo)) return candidate;
    }
    const ownerDir = path.join(root, owner);
    if (entries.includes(owner)) {
      const inner = await fs.readdir(ownerDir).catch(() => [] as string[]);
      if (inner.includes(repo)) {
        const candidate = path.join(ownerDir, repo);
        if (await isMatchingRepo(candidate, owner, repo)) return candidate;
      }
    }
  }
  return null;
}

async function isGitRepo(p: string): Promise<boolean> {
  return pathExists(path.join(p, ".git"));
}

async function isMatchingRepo(p: string, owner: string, repo: string): Promise<boolean> {
  if (!(await isGitRepo(p))) return false;
  try {
    const out = await run("git", ["remote", "get-url", "origin"], { cwd: p });
    const url = out.trim();
    // Match either git@github.com:owner/repo.git or https://github.com/owner/repo(.git)?
    return url.includes(`${owner}/${repo}.git`) || url.endsWith(`${owner}/${repo}`);
  } catch {
    return false;
  }
}

/**
 * Add a worktree against an existing local clone, checked out at the PR's
 * head SHA. We never modify the user's checked-out branch.
 */
export async function addWorktreeFromLocal(
  localClonePath: string,
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  log: (msg: string) => void = () => {},
): Promise<WorktreeInfo> {
  const slug = `${owner}-${repo}`;
  const worktreePath = path.join(worktreesRoot(), slug, String(number));
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  log(`fetching PR #${number} into ${path.basename(localClonePath)}…`);
  // Fetch the PR ref. Either pull/<n>/head or the SHA itself.
  try {
    await run("git", ["fetch", "origin", `pull/${number}/head`, "--quiet"], { cwd: localClonePath });
  } catch {
    await run("git", ["fetch", "origin", headSha, "--quiet"], { cwd: localClonePath });
  }

  if (await pathExists(worktreePath)) {
    const currentSha = (await run("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).trim();
    if (currentSha !== headSha) {
      log(`updating worktree to ${headSha.slice(0, 7)}…`);
      await run("git", ["reset", "--hard", headSha], { cwd: worktreePath });
    } else {
      log(`worktree already at ${headSha.slice(0, 7)}`);
    }
  } else {
    log(`creating worktree at ${worktreePath}…`);
    await run("git", ["worktree", "add", "--detach", worktreePath, headSha], { cwd: localClonePath });
  }

  return { worktreePath, localClonePath, headSha, ephemeral: false };
}
