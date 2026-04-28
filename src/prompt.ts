import type { PRMeta } from "./types.js";

const SYSTEM_AGENTIC = `You are a senior software reviewer helping an engineer review a pull request they did not write. You have read access to the entire repository at the PR's head SHA via tools (read_file, list_dir, glob, grep).

Your job:
1. Build genuine understanding before drafting a review. Use the tools to read callers, types, related tests, configuration, and any unfamiliar APIs the diff touches. Do not speculate when you can verify.
2. Produce a Review Path that splits the PR into a logical, ordered sequence of review steps. Each step's rationale must be specific to what actually changed and grounded in what you read.
3. Surface real risks. Annotations must anchor concrete concerns to specific lines. Better to leave a section without annotations than to invent generic ones.
4. Submit your final result by calling the submit_review_path tool exactly once. Do not write the JSON in plain text.

Operating budget: explore freely but with discipline. ~10-30 tool calls is typical for a medium PR. Stop exploring once you understand the change well enough to give a grounded review.

Constraints:
- Annotations use head-side line numbers (post-change file). Use side="base" only when commenting on a deleted line.
- Confidence (0.0-1.0) reflects how sure you are the rationale captures the actual change. Lower it when you had to guess.
- "smells" must be concrete: e.g. "ignored Promise rejection", "off-by-one in loop bound", "missing null check on user.session". Empty array if clean.
- Never invent file paths or line numbers. If you cannot anchor a concern, put it in the step's rationale or smells.`;

const SYSTEM_NO_CONTEXT = `You are a senior software reviewer helping an engineer review a pull request they did not write. You have only the PR diff — no repo access. Output ONLY a single JSON object matching the schema below; no prose, no fences. Be concrete; generic boilerplate is worse than nothing.`;

export interface BuildPromptOptions {
  meta: PRMeta;
  diff: string | null;
  hasRepoContext: boolean;
}

export function buildUserPrompt({ meta, diff, hasRepoContext }: BuildPromptOptions): string {
  const commits = meta.commits
    .map((c) => `- ${c.shortSha} (${c.authorName}) ${firstLine(c.message)}`)
    .join("\n");

  const files = meta.files
    .map((f) => `- ${f.path}  +${f.additions}/-${f.deletions}`)
    .join("\n");

  const diffSection = diff
    ? `\nFull unified diff (line numbers in hunk headers refer to head/base files):\n\`\`\`diff\n${diff}\n\`\`\`\n`
    : `\n(Full diff omitted because the PR is too large. Use tools to read individual files instead.)\n`;

  if (hasRepoContext) {
    return `PR title: ${meta.title}
PR url: ${meta.url}
Author: ${meta.author}
Base ← Head: ${meta.baseRef} ← ${meta.headRef}

PR description:
${meta.body || "(no description)"}

Commits (oldest first):
${commits || "(none)"}

Files changed:
${files || "(none)"}
${diffSection}
You have access to the full repo at the PR's head SHA via tools. Explore as needed to ground your review (callers, types, tests, configuration). When you're ready, submit by calling the submit_review_path tool with the schema documented in the tool definition.`;
  }

  // No-context mode: ask for inline JSON output.
  return `PR title: ${meta.title}
PR url: ${meta.url}
Author: ${meta.author}
Base ← Head: ${meta.baseRef} ← ${meta.headRef}

PR description:
${meta.body || "(no description)"}

Commits (oldest first):
${commits || "(none)"}

Files changed:
${files || "(none)"}
${diffSection}
Output a JSON object matching this exact schema. Output ONLY JSON.

{
  "overall": {
    "risk": "low" | "medium" | "high",
    "summary": "2-3 sentences on what this PR does and the dominant risk theme.",
    "headline_concerns": ["short concrete concern", "..."]
  },
  "steps": [
    {
      "id": "step-1",
      "title": "Short imperative title (max 60 chars)",
      "rationale": "1-3 sentences specific to this PR. Say what to look for.",
      "files": ["path/to/file1"],
      "commits": ["abc1234"],
      "depends_on": [],
      "risk": "low" | "medium" | "high",
      "confidence": 0.0,
      "smells": ["short phrase per smell"],
      "annotations": [
        {
          "file": "path/to/file1",
          "line_start": 42,
          "line_end": 47,
          "side": "head",
          "severity": "info" | "warning" | "risk",
          "note": "specific concern about these lines"
        }
      ]
    }
  ]
}

Rules:
- Every changed file appears in at least one step.
- Steps ordered so each depends only on prior steps.
- 3-7 steps for medium PRs, up to 10 for very large.
- Group by logical purpose, not file type. Tests for a feature go with the feature.
- "risk" per step reflects how dangerous a regression here would be.
- "confidence" (0.0-1.0) — your confidence the rationale captures the change. Lower it when you had to guess.
- "smells" lists concrete issues; empty array if clean.
- "annotations" anchor concerns to specific lines. Use "head" line numbers; use "base" only for deletions.
- Never invent file paths or line numbers.
- "overall.risk" reflects the worst per-step risk weighted by blast radius.
`;
}

export function getSystemPrompt(hasRepoContext: boolean): string {
  return hasRepoContext ? SYSTEM_AGENTIC : SYSTEM_NO_CONTEXT;
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? "";
}
