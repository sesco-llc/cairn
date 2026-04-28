#!/usr/bin/env node
import path from "node:path";
import { fetchPRDiff, fetchPRMeta, parsePRUrl } from "./github.js";
import { buildUserPrompt, getSystemPrompt } from "./prompt.js";
import { callReviewPath, callReviewPathAgentic } from "./anthropic.js";
import { renderMarkdown } from "./render.js";
import { writeReview } from "./store.js";
import { addWorktreeFromLocal, findLocalClone } from "./worktree.js";

interface CliArgs {
  command: "review" | "help" | "version";
  url?: string;
  model: string;
  maxFiles: number;
  diffByteCap: number;
  json: boolean;
  stdoutOnly: boolean;
  outDir: string;
  debug: boolean;
  noContext: boolean;
  repoPath: string | null;
  maxIterations: number;
}

const DEFAULTS = {
  model: "claude-opus-4-7",
  maxFiles: 40,
  diffByteCap: 400_000,
  outDir: ".cairn",
  maxIterations: 40,
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "help",
    model: DEFAULTS.model,
    maxFiles: DEFAULTS.maxFiles,
    diffByteCap: DEFAULTS.diffByteCap,
    json: false,
    stdoutOnly: false,
    outDir: DEFAULTS.outDir,
    debug: false,
    noContext: false,
    repoPath: null,
    maxIterations: DEFAULTS.maxIterations,
  };

  if (argv.length === 0) return args;

  const first = argv[0]!;
  if (first === "-h" || first === "--help" || first === "help") return args;
  if (first === "-v" || first === "--version") {
    args.command = "version";
    return args;
  }
  if (first !== "review") {
    throw new Error(`Unknown command: ${first}. Try \`cairn-app help\`.`);
  }
  args.command = "review";

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model") args.model = required(argv, ++i, "--model");
    else if (a === "--max-files") args.maxFiles = Number(required(argv, ++i, "--max-files"));
    else if (a === "--diff-bytes") args.diffByteCap = Number(required(argv, ++i, "--diff-bytes"));
    else if (a === "--out") args.outDir = required(argv, ++i, "--out");
    else if (a === "--repo") args.repoPath = required(argv, ++i, "--repo");
    else if (a === "--max-iter") args.maxIterations = Number(required(argv, ++i, "--max-iter"));
    else if (a === "--no-context") args.noContext = true;
    else if (a === "--json") args.json = true;
    else if (a === "--stdout-only") args.stdoutOnly = true;
    else if (a === "--debug") args.debug = true;
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else if (!args.url) args.url = a;
    else throw new Error(`Unexpected positional argument: ${a}`);
  }

  if (!args.url) throw new Error("Missing GitHub PR URL. Usage: cairn-app review <url>");
  return args;
}

function required(argv: string[], i: number, name: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`Flag ${name} requires a value.`);
  return v;
}

function printHelp(): void {
  process.stdout.write(
    `cairn-app — split a GitHub PR into an ordered Review Path.

Usage:
  cairn-app review <github-pr-url> [flags]

Repo context (default: on if a local clone is found):
  Looks for an existing clone of <owner>/<repo> in your machine, fetches the
  PR's head SHA, and gives Claude tools (read_file, glob, grep, list_dir)
  scoped to a worktree at that SHA. Search order for the local clone:
    1. ~/.cairn/repos.json mapping ("owner/repo": "/abs/path")
    2. ~/code/<repo>, ~/dev/<repo>, ~/src/<repo>, ~/Projects/<repo>
    3. Same with <owner>/<repo> nested

Flags:
  --repo <path>       Use this local clone instead of auto-detecting
  --no-context        Skip repo context entirely (faster, diff-only review)
  --max-iter <n>      Max tool-use iterations (default ${DEFAULTS.maxIterations})
  --model <id>        Claude model id (default ${DEFAULTS.model})
  --max-files <n>     Drop full diff when files > n (default ${DEFAULTS.maxFiles})
  --diff-bytes <n>    Drop full diff when raw bytes > n (default ${DEFAULTS.diffByteCap})
  --out <dir>         Output dir for review files (default ${DEFAULTS.outDir})
  --json              Print raw Review Path JSON to stdout
  --stdout-only       Skip writing files; only print to stdout
  --debug             Print prompt/token usage to stderr
  -h, --help / -v, --version

Environment:
  ANTHROPIC_API_KEY   required
  gh CLI authenticated for fetching PR metadata
`,
  );
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (args.command === "help") return printHelp();
  if (args.command === "version") {
    process.stdout.write("cairn-app 0.3.0\n");
    return;
  }

  const log = (msg: string) => process.stderr.write(`[${new Date().toLocaleTimeString()}] ${msg}\n`);

  const { owner, repo, number } = parsePRUrl(args.url!);
  log(`fetching PR ${owner}/${repo}#${number}…`);
  const meta = await fetchPRMeta(owner, repo, number);
  const headSha = meta.commits[meta.commits.length - 1]?.oid;
  const rawDiff = await fetchPRDiff(owner, repo, number);

  let diffForPrompt: string | null = rawDiff;
  if (meta.files.length > args.maxFiles) {
    log(`${meta.files.length} files > ${args.maxFiles} max-files; dropping full diff from prompt`);
    diffForPrompt = null;
  } else if (rawDiff.length > args.diffByteCap) {
    log(`diff ${rawDiff.length}B > ${args.diffByteCap}B cap; dropping full diff from prompt`);
    diffForPrompt = null;
  }

  // Resolve local clone unless --no-context.
  let worktreePath: string | null = null;
  if (!args.noContext && headSha) {
    let localClone: string | null = args.repoPath ?? (await findLocalClone(owner, repo));
    if (localClone) {
      log(`using local clone at ${localClone}`);
      try {
        const wt = await addWorktreeFromLocal(localClone, owner, repo, number, headSha, log);
        worktreePath = wt.worktreePath;
      } catch (err) {
        log(`failed to set up worktree: ${(err as Error).message}`);
        log(`falling back to diff-only review`);
      }
    } else {
      log(`no local clone found for ${owner}/${repo}; running diff-only review (pass --repo <path> or add to ~/.cairn/repos.json)`);
    }
  }

  const hasRepoContext = !!worktreePath;
  const userPrompt = buildUserPrompt({ meta, diff: diffForPrompt, hasRepoContext });
  const systemPrompt = getSystemPrompt(hasRepoContext);

  log(hasRepoContext ? `running agentic review with repo context…` : `running diff-only review…`);
  const reviewPath = hasRepoContext
    ? await callReviewPathAgentic({
        model: args.model,
        systemPrompt,
        userPrompt,
        worktreePath: worktreePath!,
        maxIterations: args.maxIterations,
        debug: args.debug,
        log,
      })
    : await callReviewPath({
        model: args.model,
        systemPrompt,
        userPrompt,
        debug: args.debug,
      });

  if (!args.stdoutOnly) {
    const rootDir = path.resolve(args.outDir);
    const { slug, dir } = await writeReview(rootDir, meta, rawDiff, reviewPath);
    process.stderr.write(
      `\nWrote review files to ${dir}\n` +
        `Open in viewer:  cd app && pnpm dev   →   http://localhost:5173/?slug=${slug}\n\n`,
    );
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(reviewPath, null, 2) + "\n");
  } else {
    process.stdout.write(renderMarkdown(meta, reviewPath) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
