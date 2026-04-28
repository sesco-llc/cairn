import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

export interface RepoSpecifier {
  owner: string;
  repo: string;
}

export type CleanupScope =
  | { kind: "all" }
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "pr"; owner: string; repo: string; number: number }
  | { kind: "slug"; slug: string; number?: number };

export interface CleanupTarget {
  slug: string;
  number: number;
  worktreePath: string;
  sizeBytes: number;
  owner: string | null;
  repo: string | null;
  localClonePath: string | null;
}

export interface CleanupResult extends CleanupTarget {
  method: "dry-run" | "git-worktree-remove" | "rm-rf";
  removed: boolean;
  warning: string | null;
}

interface CleanupOptions {
  dryRun: boolean;
}

interface IndexedCleanupTarget {
  target: CleanupTarget;
  index: number;
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

export function worktreesRoot(): string {
  const override = process.env.CAIRN_WORKTREES_ROOT;
  return override ? path.resolve(override) : path.join(os.homedir(), ".cairn", "worktrees");
}

export function repoSlug(owner: string, repo: string): string {
  return `${owner}-${repo}`;
}

export function worktreePathForPR(owner: string, repo: string, number: number): string {
  return path.join(worktreesRoot(), repoSlug(owner, repo), String(number));
}

export function parseRepoSpecifier(value: string): RepoSpecifier {
  const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) throw new Error(`Expected repo as owner/repo: ${value}`);
  return { owner, repo };
}

export function parseGitHubRemote(remote: string): RepoSpecifier | null {
  const normalized = remote.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = normalized.match(/github\.com[:/]([^/\s:]+)\/([^/\s]+)$/);
  const owner = match?.[1];
  const repo = match?.[2];
  return owner && repo ? { owner, repo } : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
  return withCloneLock(localClonePath, async () => {
    const worktreePath = worktreePathForPR(owner, repo, number);
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
  });
}

export async function listCleanupTargets(scope: CleanupScope): Promise<CleanupTarget[]> {
  const root = worktreesRoot();
  if (!(await pathExists(root))) return [];

  const slugEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const slugNames = slugEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => matchesSlug(scope, slug))
    .sort((a, b) => a.localeCompare(b));

  const nestedTargets = await Promise.all(
    slugNames.map((slug) => listCleanupTargetsForSlug(scope, root, slug)),
  );

  return nestedTargets.flat();
}

async function listCleanupTargetsForSlug(scope: CleanupScope, root: string, slug: string): Promise<CleanupTarget[]> {
  const slugDir = path.join(root, slug);
  const numberEntries = await fs.readdir(slugDir, { withFileTypes: true }).catch(() => []);
  const numberNames = numberEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((numberName) => /^\d+$/.test(numberName))
    .filter((numberName) => matchesNumber(scope, Number(numberName)))
    .sort((a, b) => Number(a) - Number(b));

  const targets = await Promise.all(
    numberNames.map((numberName) => buildCleanupTarget(scope, slug, Number(numberName), path.join(slugDir, numberName))),
  );
  return targets.filter((target): target is CleanupTarget => target !== null);
}

export async function cleanupTargets(targets: CleanupTarget[], options: CleanupOptions): Promise<CleanupResult[]> {
  if (!options.dryRun) targets.forEach(assertSafeCleanupPath);

  const indexedTargets = targets.map((target, index) => ({ target, index }));
  const groups = groupTargetsByParentClone(indexedTargets);
  const results: Array<CleanupResult | undefined> = new Array(targets.length);

  await Promise.all(
    groups.map((group) =>
      group.reduce<Promise<void>>(async (previous, item) => {
        await previous;
        results[item.index] = await cleanupTarget(item.target, options);
      }, Promise.resolve()),
    ),
  );

  return results.map((result) => {
    if (result === undefined) throw new Error("cleanup result missing");
    return result;
  });
}

function groupTargetsByParentClone(items: ReadonlyArray<IndexedCleanupTarget>): IndexedCleanupTarget[][] {
  const initialGroups: Record<string, IndexedCleanupTarget[]> = {};
  return Object.values(
    items.reduce((grouped, item) => {
      const groupKey = item.target.localClonePath ?? "__cairn_missing_parent_clone__";
      return {
        ...grouped,
        [groupKey]: [...(grouped[groupKey] ?? []), item],
      };
    }, initialGroups),
  );
}

async function cleanupTarget(target: CleanupTarget, options: CleanupOptions): Promise<CleanupResult> {
  if (options.dryRun) {
    return { ...target, method: "dry-run", removed: false, warning: null };
  }

  const worktreePath = assertSafeCleanupPath(target);

  if (target.localClonePath) {
    const localClonePath = target.localClonePath;
    return withCloneLock(localClonePath, async () => {
      try {
        await run("git", ["worktree", "remove", "--force", worktreePath], { cwd: localClonePath });
        await removeEmptyParents(worktreePath);
        return { ...target, method: "git-worktree-remove", removed: true, warning: null };
      } catch (err) {
        throw new Error(`git worktree remove failed for ${target.worktreePath}; no files were removed. ${errorMessage(err)}`);
      }
    });
  }

  await fs.rm(worktreePath, { recursive: true, force: true });
  await removeEmptyParents(worktreePath);
  return {
    ...target,
    method: "rm-rf",
    removed: true,
    warning: `parent clone not found for ${target.worktreePath}; removed directory with rm -rf. Run git worktree prune in the parent clone if stale entries remain.`,
  };
}

function assertSafeCleanupPath(target: CleanupTarget): string {
  const root = assertSafeWorktreesRoot();
  const worktreePath = path.resolve(target.worktreePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (!worktreePath.startsWith(rootPrefix)) {
    throw new Error(`Refusing to remove cleanup target outside ${root}: ${target.worktreePath}`);
  }

  return worktreePath;
}

function assertSafeWorktreesRoot(): string {
  const root = path.resolve(worktreesRoot());
  const systemRoot = path.parse(root).root;
  const unsafeRoots = new Set([systemRoot, path.resolve(os.homedir()), path.resolve(os.tmpdir())]);

  if (unsafeRoots.has(root)) {
    throw new Error(`Refusing to use unsafe worktrees root for destructive cleanup: ${root}`);
  }

  return root;
}

function matchesSlug(scope: CleanupScope, slug: string): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "repo" || scope.kind === "pr") return slug === repoSlug(scope.owner, scope.repo);
  return slug === scope.slug;
}

function matchesNumber(scope: CleanupScope, number: number): boolean {
  if (scope.kind === "pr") return number === scope.number;
  if (scope.kind === "slug" && scope.number !== undefined) return number === scope.number;
  return true;
}

async function buildCleanupTarget(
  scope: CleanupScope,
  slug: string,
  number: number,
  worktreePath: string,
): Promise<CleanupTarget | null> {
  const repoFromScope = repoSpecifierFromScope(scope);
  const repoFromRemote = await readRepoFromWorktree(worktreePath);
  if (repoFromScope && repoFromRemote && !sameRepo(repoFromScope, repoFromRemote)) return null;

  const repo = repoFromScope ?? repoFromRemote;
  const localClonePath = repo ? await findLocalClone(repo.owner, repo.repo) : null;

  return {
    slug,
    number,
    worktreePath,
    sizeBytes: await diskUsageBytes(worktreePath),
    owner: repo?.owner ?? null,
    repo: repo?.repo ?? null,
    localClonePath,
  };
}

function sameRepo(a: RepoSpecifier, b: RepoSpecifier): boolean {
  return a.owner === b.owner && a.repo === b.repo;
}

async function withCloneLock<T>(localClonePath: string, action: () => Promise<T>): Promise<T> {
  const lockName = createHash("sha256").update(path.resolve(localClonePath)).digest("hex");
  const lockDir = path.join(worktreesRoot(), ".locks", lockName);
  await acquireLock(lockDir);
  try {
    return await action();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function acquireLock(lockDir: string, attempt = 0): Promise<void> {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await fs.mkdir(lockDir);
  } catch (err) {
    if (!isFileExistsError(err) || attempt >= 200) throw err;
    await delay(50);
    await acquireLock(lockDir, attempt + 1);
  }
}

function isFileExistsError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EEXIST";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoSpecifierFromScope(scope: CleanupScope): RepoSpecifier | null {
  if (scope.kind === "repo" || scope.kind === "pr") return { owner: scope.owner, repo: scope.repo };
  return null;
}

async function readRepoFromWorktree(worktreePath: string): Promise<RepoSpecifier | null> {
  try {
    const remote = await run("git", ["remote", "get-url", "origin"], { cwd: worktreePath });
    return parseGitHubRemote(remote);
  } catch {
    return null;
  }
}

async function diskUsageBytes(p: string): Promise<number> {
  try {
    const out = await run("du", ["-sk", p]);
    const kilobytes = Number(out.trim().split(/\s+/)[0]);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
  } catch {
    return 0;
  }
}

async function removeEmptyParents(worktreePath: string): Promise<void> {
  await fs.rmdir(path.dirname(worktreePath)).catch(() => {});
  await fs.rmdir(worktreesRoot()).catch(() => {});
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
