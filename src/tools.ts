import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

const MAX_FILE_BYTES = 200_000;
const MAX_LINES_PER_READ = 800;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 200;
const MAX_OUTPUT_CHARS = 16_000;

export interface ToolContext {
  worktreePath: string;
  log: (msg: string) => void;
}

export interface ToolHandler {
  schema: Anthropic.Tool;
  handle: (input: any, ctx: ToolContext) => Promise<string>;
}

function safeResolve(root: string, rel: string): string {
  if (typeof rel !== "string") throw new Error("path must be a string");
  if (rel.startsWith("/")) throw new Error(`path must be relative to repo root: ${rel}`);
  const absolute = path.resolve(root, rel);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes repo root: ${rel}`);
  }
  return absolute;
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated; ${text.length - max} more chars]`;
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => resolve({ stdout: "", stderr: e.message, code: -1 }));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

const readFileTool: ToolHandler = {
  schema: {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the repo at the PR's head SHA. Use this to read full source files, not just diffed regions, when you need surrounding context, callers, types, etc. Pass `start_line` and `end_line` (1-indexed, inclusive) to read a slice; otherwise the whole file is returned (up to a size cap).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path relative to repo root, e.g. 'src/foo/bar.ts'." },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
  },
  async handle(input, ctx) {
    const abs = safeResolve(ctx.worktreePath, input.path);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return `error: ${input.path} is not a file`;
    if (stat.size > MAX_FILE_BYTES * 4) {
      return `error: file ${input.path} is ${stat.size} bytes; too large to read in one call.`;
    }
    const buf = await fs.readFile(abs, "utf8");
    const lines = buf.split("\n");
    const start = input.start_line ? Math.max(1, Number(input.start_line)) : 1;
    const end = input.end_line ? Math.min(lines.length, Number(input.end_line)) : lines.length;
    const sliceLen = end - start + 1;
    if (sliceLen > MAX_LINES_PER_READ) {
      return `error: requested ${sliceLen} lines but max per read is ${MAX_LINES_PER_READ}. Narrow the range.`;
    }
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((l, i) => `${String(start + i).padStart(5, " ")}  ${l}`).join("\n");
    const header = `# ${input.path} (lines ${start}-${end} of ${lines.length})\n`;
    return clamp(header + numbered, MAX_OUTPUT_CHARS);
  },
};

const listDirTool: ToolHandler = {
  schema: {
    name: "list_dir",
    description: "List entries in a directory, relative to repo root. Use this to discover the project layout. Hidden files (starting with .) are included; build/dependency dirs (.git, node_modules, dist, target, build) are skipped.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory path relative to repo root, or empty/'.' for root." },
      },
      required: [],
    },
  },
  async handle(input, ctx) {
    const rel = input.path && input.path !== "." ? input.path : ".";
    const abs = safeResolve(ctx.worktreePath, rel);
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return `error: ${rel} is not a directory`;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const skip = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".turbo", ".venv", "venv", "__pycache__", ".pytest_cache"]);
    const lines = entries
      .filter((e) => !skip.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return clamp(`# ${rel}\n${lines.join("\n")}`, MAX_OUTPUT_CHARS);
  },
};

const globTool: ToolHandler = {
  schema: {
    name: "glob",
    description: "Find files matching a glob pattern (uses `git ls-files`, so respects .gitignore and only matches tracked files at the PR's head SHA). Examples: `**/*.ts`, `src/auth/**`, `**/test_*.py`.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Glob pattern. Standard shell globs work." },
      },
      required: ["pattern"],
    },
  },
  async handle(input, ctx) {
    const { stdout, code, stderr } = await runCmd("git", ["ls-files", "--", input.pattern], ctx.worktreePath);
    if (code !== 0) return `error: git ls-files failed: ${stderr.trim()}`;
    const files = stdout.split("\n").filter(Boolean);
    if (files.length === 0) return `(no files match ${input.pattern})`;
    const truncated = files.length > MAX_GLOB_RESULTS;
    const shown = files.slice(0, MAX_GLOB_RESULTS);
    return clamp(
      `# ${files.length} match${files.length === 1 ? "" : "es"} for ${input.pattern}${truncated ? ` (showing first ${MAX_GLOB_RESULTS})` : ""}\n${shown.join("\n")}`,
      MAX_OUTPUT_CHARS,
    );
  },
};

const grepTool: ToolHandler = {
  schema: {
    name: "grep",
    description: "Search file contents for a regex (uses `git grep`, so respects .gitignore). Use for finding callers of a function, references to a type, etc. Returns lines like `path:lineno:content`. Optionally narrow by `path` (file or directory glob).",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern (Perl-compatible)." },
        path: { type: "string", description: "Optional path/glob to narrow the search, e.g. 'src/' or 'src/**/*.ts'." },
        case_sensitive: { type: "boolean", description: "Default true." },
      },
      required: ["pattern"],
    },
  },
  async handle(input, ctx) {
    const args = ["grep", "--no-color", "-n", "-P"];
    if (input.case_sensitive === false) args.push("-i");
    args.push("--", input.pattern);
    if (input.path) args.push(input.path);
    const { stdout, code, stderr } = await runCmd("git", args, ctx.worktreePath);
    if (code === 1) return `(no matches for /${input.pattern}/${input.path ? ` in ${input.path}` : ""})`;
    if (code !== 0) {
      // git-grep falls back to BRE if -P unsupported; retry with basic regex.
      if (stderr.includes("PCRE")) {
        const fallback = await runCmd("git", ["grep", "--no-color", "-n", "--", input.pattern, ...(input.path ? [input.path] : [])], ctx.worktreePath);
        if (fallback.code === 1) return `(no matches)`;
        if (fallback.code === 0) return clamp(fallback.stdout.split("\n").slice(0, MAX_GREP_RESULTS).join("\n"), MAX_OUTPUT_CHARS);
      }
      return `error: git grep failed: ${stderr.trim()}`;
    }
    const lines = stdout.split("\n").filter(Boolean);
    const truncated = lines.length > MAX_GREP_RESULTS;
    const shown = lines.slice(0, MAX_GREP_RESULTS);
    return clamp(
      `# ${lines.length} match${lines.length === 1 ? "" : "es"}${truncated ? ` (showing first ${MAX_GREP_RESULTS})` : ""}\n${shown.join("\n")}`,
      MAX_OUTPUT_CHARS,
    );
  },
};

const submitReviewPathTool: ToolHandler = {
  schema: {
    name: "submit_review_path",
    description:
      "Submit the final Review Path for the PR. Call this exactly once when you have explored enough context to give a grounded review. After this is called, no further tool calls are permitted.",
    input_schema: {
      type: "object" as const,
      properties: {
        overall: {
          type: "object",
          properties: {
            risk: { type: "string", enum: ["low", "medium", "high"] },
            summary: { type: "string" },
            headline_concerns: { type: "array", items: { type: "string" } },
          },
          required: ["risk", "summary", "headline_concerns"],
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              rationale: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              commits: { type: "array", items: { type: "string" } },
              depends_on: { type: "array", items: { type: "string" } },
              risk: { type: "string", enum: ["low", "medium", "high"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              smells: { type: "array", items: { type: "string" } },
              annotations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    line_start: { type: "integer", minimum: 1 },
                    line_end: { type: "integer", minimum: 1 },
                    side: { type: "string", enum: ["head", "base"] },
                    severity: { type: "string", enum: ["info", "warning", "risk"] },
                    note: { type: "string" },
                  },
                  required: ["file", "line_start", "line_end", "side", "severity", "note"],
                },
              },
            },
            required: ["id", "title", "rationale", "files", "commits", "depends_on", "risk", "confidence", "smells", "annotations"],
          },
        },
      },
      required: ["overall", "steps"],
    },
  },
  async handle() {
    return "ok"; // result captured in the loop, not via this string
  },
};

export const TOOLS: Record<string, ToolHandler> = {
  read_file: readFileTool,
  list_dir: listDirTool,
  glob: globTool,
  grep: grepTool,
  submit_review_path: submitReviewPathTool,
};

export function exploreToolNames(): string[] {
  return ["read_file", "list_dir", "glob", "grep"];
}
