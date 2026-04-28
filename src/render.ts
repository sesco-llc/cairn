import type { PRMeta, ReviewPath } from "./types.js";

const RISK_BADGE: Record<string, string> = {
  low: "🟢 low",
  medium: "🟡 med",
  high: "🔴 high",
};

export function renderMarkdown(meta: PRMeta, path: ReviewPath): string {
  const lines: string[] = [];
  lines.push(`# Review Path: ${meta.title}`);
  lines.push("");
  lines.push(`**PR:** [${meta.owner}/${meta.repo}#${meta.number}](${meta.url})  `);
  lines.push(`**Author:** ${meta.author}  `);
  lines.push(`**Branch:** \`${meta.baseRef}\` ← \`${meta.headRef}\`  `);
  lines.push(`**Files:** ${meta.files.length}, **Commits:** ${meta.commits.length}  `);
  lines.push(`**Overall risk:** ${RISK_BADGE[path.overall.risk] ?? path.overall.risk}`);
  lines.push("");
  if (path.overall.summary) {
    lines.push(path.overall.summary);
    lines.push("");
  }
  if (path.overall.headline_concerns.length) {
    lines.push("**Headline concerns:**");
    for (const c of path.overall.headline_concerns) lines.push(`- ${c}`);
    lines.push("");
  }

  if (path.steps.length === 0) {
    lines.push("_(model returned an empty Review Path — likely a tiny or trivial PR)_");
    return lines.join("\n");
  }

  path.steps.forEach((step, idx) => {
    const risk = RISK_BADGE[step.risk] ?? step.risk;
    const conf = `confidence ${(step.confidence * 100).toFixed(0)}%`;
    lines.push(`## Step ${idx + 1}: ${step.title}`);
    lines.push(`${risk} · ${conf}`);
    lines.push("");
    lines.push(step.rationale.trim());
    lines.push("");
    if (step.smells.length) {
      lines.push(`**Smells:** ${step.smells.map((s) => `\`${s}\``).join(", ")}`);
    }
    if (step.files.length) {
      lines.push(`**Files:** ${step.files.map((f) => `\`${f}\``).join(", ")}`);
    }
    if (step.commits.length) {
      lines.push(`**Commits:** ${step.commits.map((c) => `\`${c}\``).join(", ")}`);
    }
    if (step.depends_on.length) {
      lines.push(`**Depends on:** ${step.depends_on.join(", ")}`);
    }
    if (step.annotations.length) {
      lines.push("");
      lines.push("**Inline notes:**");
      for (const a of step.annotations) {
        const range = a.line_start === a.line_end
          ? `L${a.line_start}`
          : `L${a.line_start}–${a.line_end}`;
        lines.push(`- \`${a.file}\` ${range} (${a.side}, ${a.severity}): ${a.note}`);
      }
    }
    lines.push("");
  });

  return lines.join("\n");
}
