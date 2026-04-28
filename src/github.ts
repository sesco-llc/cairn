import { spawn } from "node:child_process";
import type { PRMeta } from "./types.js";

export function parsePRUrl(url: string): { owner: string; repo: string; number: number } {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Not a recognizable GitHub PR URL: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]!) };
}

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(new Error(`Failed to spawn gh: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

interface GhPRView {
  title: string;
  body: string;
  url: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  author: { login: string };
  commits: Array<{
    oid: string;
    authoredDate: string;
    messageHeadline: string;
    messageBody: string;
    authors: Array<{ name: string; login?: string }>;
  }>;
  files: Array<{ path: string; additions: number; deletions: number }>;
}

export async function fetchPRMeta(owner: string, repo: string, number: number): Promise<PRMeta> {
  const repoFlag = `${owner}/${repo}`;
  const fields = [
    "title",
    "body",
    "url",
    "state",
    "baseRefName",
    "headRefName",
    "author",
    "commits",
    "files",
  ].join(",");

  const raw = await runGh([
    "pr",
    "view",
    String(number),
    "--repo",
    repoFlag,
    "--json",
    fields,
  ]);

  const data = JSON.parse(raw) as GhPRView;

  return {
    owner,
    repo,
    number,
    title: data.title,
    body: data.body ?? "",
    url: data.url,
    state: data.state,
    baseRef: data.baseRefName,
    headRef: data.headRefName,
    author: data.author?.login ?? "unknown",
    commits: data.commits.map((c) => ({
      oid: c.oid,
      shortSha: c.oid.slice(0, 7),
      authoredDate: c.authoredDate,
      authorName: c.authors[0]?.name ?? "unknown",
      message: [c.messageHeadline, c.messageBody].filter(Boolean).join("\n").trim(),
    })),
    files: data.files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      status: "",
    })),
  };
}

export async function fetchPRDiff(owner: string, repo: string, number: number): Promise<string> {
  return runGh(["pr", "diff", String(number), "--repo", `${owner}/${repo}`]);
}
