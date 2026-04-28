# Cairn

> Most AI review tools see the diff. Cairn sees the diff **and** your actual codebase.

<!-- Drop the hero screenshot URL here. Paste an image into a draft GitHub issue
     to get a permanent user-images.githubusercontent.com URL, then replace src. -->
<p align="center">
    <img width="2168" height="1247" alt="image" src="https://github.com/user-attachments/assets/5d19a1cc-5255-4377-9a3e-a39b05b5507b" />
</p>




Cairn turns a pull request into an **ordered Review Path** — a stepwise reading plan with risk-scored chunks, smell flags, and inline annotations anchored to specific lines. The CLI clones a detached worktree at the PR's head SHA and gives Claude tools (`read_file`, `glob`, `grep`, `list_dir`) while it builds the review, so the output is grounded in your actual code, not just the diff.

100% local. Your code is never uploaded anywhere — only the AI request goes to Anthropic's API, and only with context you control. MIT licensed, BYOK.

## Why

Most PR review tools were built for the old world: small, human-authored diffs reviewed by people who already knew the codebase. Today, AI writes most of the code on most teams, and the bottleneck has shifted from *writing* to *reviewing and understanding*.

Cairn treats review as a **learning and reasoning task**, not a comment-dropping task. Its job is to make you faster and more confident — not to leave the comments for you.

## Status

**Phase 1A prototype.** The Review Path concept is being validated on real PRs. The CLI is feature-complete; the local React viewer renders diffs with inline annotations. A Tauri desktop app comes next once the prototype clears its validation gate.

If you want to help kick the tires, the most useful thing right now is running it on real PRs and telling us whether the annotations point at things you'd actually want flagged.

## Quickstart

**Prereqs:** Node ≥ 18, [pnpm](https://pnpm.io/), [`gh`](https://cli.github.com/) authenticated, an [Anthropic API key](https://console.anthropic.com/).

```sh
git clone https://github.com/<your-fork>/cairn.git
cd cairn

# CLI
pnpm install
pnpm build

# Viewer
cd app && pnpm install && cd ..

# Run a review
export ANTHROPIC_API_KEY=sk-ant-...
node dist/index.js review https://github.com/owner/repo/pull/123

# Open the viewer
cd app && pnpm dev
# → http://localhost:5173
```

## How it works

```
  ┌──────────────────────┐
  │  cairn-app review    │
  │     <pr-url>         │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐    ┌─────────────────────────┐
  │  gh pr view + diff   │    │  Find local clone of    │
  │  (PR meta + commits) │───▶│  owner/repo on disk     │
  └──────────────────────┘    └─────────┬───────────────┘
                                        │
                              fetch pull/<n>/head SHA
                              git worktree add --detach
                                        │
                                        ▼
  ┌────────────────────────────────────────────────────┐
  │ Anthropic agentic loop                             │
  │   tools: read_file / glob / grep / list_dir        │
  │          submit_review_path                        │
  │   sandboxed to ~/.cairn/worktrees/<owner>-<repo>/<n>/ │
  └────────────────────────┬───────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────┐
  │ ./.cairn/reviews/<slug>/                           │
  │   meta.json, diff.patch, review.json               │
  └────────────────────────┬───────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────┐
  │ React viewer — diff + inline AI annotations,       │
  │ step focus mode, syntax highlighting, risk pills   │
  └────────────────────────────────────────────────────┘
```

### Repo context (the part that matters)

When you review a PR for `owner/repo`, Cairn looks for an existing local clone in this order:

1. `~/.cairn/repos.json` mapping (`{"owner/repo": "/abs/path"}`)
2. `~/code/<repo>`, `~/dev/<repo>`, `~/src/<repo>`, `~/Projects/<repo>`
3. The same with `<owner>/<repo>` nested

Found a clone? Cairn fetches the PR ref into it and creates a **detached** worktree at `~/.cairn/worktrees/<owner>-<repo>/<n>/` checked out at the PR's head SHA. **Your own working branch is never touched.** Claude then explores that worktree via sandboxed tools while building the Review Path.

No clone? Pass `--repo <path>` to override, or `--no-context` to review the diff alone.

To reclaim disk from old detached review worktrees, run `cairn-app cleanup --list` to inspect them, then remove a single PR, a repo, or everything with the cleanup commands below.

### Output

Per step the AI returns: `title`, `rationale`, `files`, `commits`, `risk` (low/med/high), `confidence` (0–1), `smells[]`, and `annotations[]` anchoring concerns to specific files + line ranges. Plus an `overall` block (summary, headline concerns, overall risk).

The viewer renders this as: a left-rail step list with risk pills, an active-step banner, a clickable file pill bar, syntax-highlighted unified diffs, and AI annotations as colored cards inserted between the changed lines.

## CLI reference

```
cairn-app review <github-pr-url> [flags]
cairn-app cleanup [github-pr-url | owner/repo | owner-repo[/number]] [flags]
```

### Review

| Flag | Default | Notes |
| --- | --- | --- |
| `--repo <path>` | (auto-detect) | Local clone to use |
| `--no-context` | off | Skip repo context, diff-only review |
| `--max-iter <n>` | 40 | Max agentic tool-use iterations |
| `--model <id>` | `claude-opus-4-7` | Claude model |
| `--max-files <n>` | 40 | Drop full diff above n changed files |
| `--diff-bytes <n>` | 400000 | Drop full diff above n bytes |
| `--out <dir>` | `.cairn` | Output directory |
| `--json` | off | Print raw Review Path JSON |
| `--stdout-only` | off | Skip writing files |
| `--debug` | off | Print prompt + token usage to stderr |

### Cleanup

| Command / flag | Notes |
| --- | --- |
| `cairn-app cleanup` | List worktrees with disk usage, no removal |
| `cairn-app cleanup <pr-url>` | Remove that PR's worktree |
| `cairn-app cleanup <owner>/<repo>` | Remove all worktrees for a repo |
| `cairn-app cleanup <owner-repo>[/number]` | Legacy slug form, still accepted |
| `cairn-app cleanup --all` | Remove every worktree under `~/.cairn/worktrees/` |
| `cairn-app cleanup --repo <owner>/<repo>` | Remove all worktrees for a repo |
| `cairn-app cleanup --list` | List worktrees with disk usage, no removal |
| `cairn-app cleanup --dry-run` | Print what would be removed; requires `--all`, `--repo`, or a positional target |
| `cairn-app cleanup -y, --yes` | Skip confirmation for broad destructive cleanup |

### Environment variables

| Variable | Notes |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required for reviews |
| `CAIRN_WORKTREES_ROOT` | Override the cleanup/worktree root; useful for tests |

## Privacy & data flow

- **No telemetry, no analytics, no servers.** Cairn runs entirely on your machine.
- **The only network calls** are to GitHub (via `gh` for PR metadata + diff) and Anthropic (the API call you authorized with your key).
- **What gets sent to Anthropic:** the PR title/body, commit messages, file paths, and either the unified diff or the contents of files Claude chose to read via tools. Nothing else. No env vars, no neighboring repos, no shell history.
- **What stays local:** the generated review files (`./.cairn/`) and the per-PR worktrees (`~/.cairn/worktrees/`). Both are gitignored.
- See [`src/tools.ts`](src/tools.ts) for the exact sandboxing rules — paths are resolved against the worktree root and rejected if they escape.

## Project layout

```
.
├── src/                   # CLI (TypeScript) — Anthropic loop, gh wrapper, worktree mgmt
├── app/                   # Vite + React + react-diff-view viewer
├── LICENSE                # MIT
└── .cairn/                # generated review files (gitignored)
    ├── index.json
    └── reviews/<slug>/
        ├── meta.json
        ├── diff.patch
        └── review.json
```

## Roadmap

- [x] **Phase 1A:** CLI + local React viewer with agentic repo context
- [ ] Tauri v2 desktop app (single-window, native, signed binary)
- [ ] PR sidebar with attention sorting + GraphQL polling
- [ ] In-app cmd-click navigation via tree-sitter symbol index
- [ ] Worktree-scoped test sandbox
- [ ] Multi-step prompting for very large PRs (>100KB diff)

## Contributing

This is an early prototype — the most valuable contribution right now is **using it on real PRs and reporting back** what worked and what didn't. Specifically:

- Did the step ordering match how you'd actually want to read the PR?
- Were the per-step `risk` and `confidence` scores well-calibrated?
- Did the inline annotations point at real concerns, or generic-sounding filler?
- What did the AI miss that an experienced reviewer would have caught?

File issues with the PR URL (if it's public), the generated `review.json`, and your honest assessment.

PRs welcome for: bug fixes, additional language support in the syntax highlighter ([`app/src/highlight.ts`](app/src/highlight.ts)), better tool ergonomics, prompt improvements that demonstrably score better on the validation rubric.

## License

[MIT](LICENSE)
