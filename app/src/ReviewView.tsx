import { useEffect, useMemo, useRef, useState } from "react";
import { Diff, Hunk, parseDiff, tokenize } from "react-diff-view";
import type { FileData, HunkData, ChangeData } from "react-diff-view";
import { languageForPath, refractorAdapter } from "./highlight";
import type { Annotation, PRMeta, ReviewPath, ReviewStep, Severity } from "./types";

interface Props {
  slug: string;
}

interface LoadedReview {
  meta: PRMeta;
  diff: string;
  review: ReviewPath;
}

const RISK_LABEL: Record<string, string> = {
  low: "🟢 low risk",
  medium: "🟡 medium risk",
  high: "🔴 high risk",
};

const SEVERITY_CLASS: Record<Severity, string> = {
  info: "ann-info",
  warning: "ann-warn",
  risk: "ann-risk",
};

function fileSlug(path: string): string {
  return "f-" + path.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

export default function ReviewView({ slug }: Props) {
  const [data, setData] = useState<LoadedReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const diffPaneRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    Promise.all([
      fetch(`/_data/reviews/${slug}/meta.json`).then(must),
      fetch(`/_data/reviews/${slug}/diff.patch`).then((r) => {
        if (!r.ok) throw new Error(`diff.patch: ${r.status}`);
        return r.text();
      }),
      fetch(`/_data/reviews/${slug}/review.json`).then(must),
    ])
      .then(([meta, diff, review]) => setData({ meta, diff, review }))
      .catch((e) => setError(e.message));
  }, [slug]);

  const files = useMemo(() => (data ? parseDiff(data.diff) : []), [data]);

  const annotationsByFile = useMemo(() => {
    const map = new Map<string, Array<Annotation & { stepId: string; stepTitle: string }>>();
    if (!data) return map;
    for (const step of data.review.steps) {
      for (const a of step.annotations) {
        const list = map.get(a.file) ?? [];
        list.push({ ...a, stepId: step.id, stepTitle: step.title });
        map.set(a.file, list);
      }
    }
    return map;
  }, [data]);

  const stepsByFile = useMemo(() => {
    const map = new Map<string, ReviewStep[]>();
    if (!data) return map;
    for (const step of data.review.steps) {
      for (const f of step.files) {
        const list = map.get(f) ?? [];
        list.push(step);
        map.set(f, list);
      }
    }
    return map;
  }, [data]);

  // Reset scroll position when the active step changes.
  useEffect(() => {
    if (diffPaneRef.current) diffPaneRef.current.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeStep]);

  if (error) return <div className="empty">Error loading review: {error}</div>;
  if (!data) return <div className="empty">Loading review…</div>;

  const { meta, review } = data;
  const activeStepObj = activeStep ? review.steps.find((s) => s.id === activeStep) ?? null : null;
  const filesInActiveStep = activeStepObj ? new Set(activeStepObj.files) : null;

  const visibleFiles = files.filter((f) => {
    const path = f.newPath || f.oldPath || "";
    return !filesInActiveStep || filesInActiveStep.has(path);
  });

  const scrollToFile = (path: string) => {
    const el = document.getElementById(fileSlug(path));
    if (el && diffPaneRef.current) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div className="review-layout">
      <aside className="steps">
        <div className="overall">
          <div className="overall-risk">{RISK_LABEL[review.overall.risk] ?? review.overall.risk}</div>
          <h2>{meta.title}</h2>
          <a href={meta.url} target="_blank" rel="noreferrer" className="pr-link">
            {meta.owner}/{meta.repo}#{meta.number} ↗
          </a>
          {review.overall.summary && <p className="summary">{review.overall.summary}</p>}
          {review.overall.headline_concerns.length > 0 && (
            <ul className="concerns">
              {review.overall.headline_concerns.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </div>

        <button
          className={"step-row" + (activeStep === null ? " active" : "")}
          onClick={() => setActiveStep(null)}
        >
          <div className="step-row-title">All files</div>
          <div className="step-row-meta">{meta.files.length} files</div>
        </button>

        {review.steps.map((step, idx) => (
          <button
            key={step.id}
            className={"step-row" + (activeStep === step.id ? " active" : "")}
            onClick={() => setActiveStep(step.id)}
          >
            <div className="step-row-head">
              <span className="step-num">{idx + 1}</span>
              <span className={`risk-pill risk-${step.risk}`}>{step.risk}</span>
              <span className="conf-pill">{Math.round(step.confidence * 100)}%</span>
            </div>
            <div className="step-row-title">{step.title}</div>
            <div className="step-row-rationale">{step.rationale}</div>
            {step.smells.length > 0 && (
              <div className="step-row-smells">
                {step.smells.map((s, i) => (
                  <span className="smell-pill" key={i}>
                    {s}
                  </span>
                ))}
              </div>
            )}
            <div className="step-row-meta">
              {step.files.length} file{step.files.length === 1 ? "" : "s"}
              {step.annotations.length > 0 && ` · ${step.annotations.length} note${step.annotations.length === 1 ? "" : "s"}`}
            </div>
          </button>
        ))}
      </aside>

      <main className="diff-pane" ref={diffPaneRef}>
        <div className="diff-pane-head">
          {activeStepObj ? (
            <div className="active-step-banner">
              <div className="active-step-title">
                Step {review.steps.findIndex((s) => s.id === activeStepObj.id) + 1}: {activeStepObj.title}
                <span className={`risk-pill risk-${activeStepObj.risk}`}>{activeStepObj.risk}</span>
                <span className="conf-pill">
                  {Math.round(activeStepObj.confidence * 100)}% confidence
                </span>
              </div>
              <div className="active-step-rationale">{activeStepObj.rationale}</div>
            </div>
          ) : (
            <div className="active-step-banner">
              <div className="active-step-title">All files</div>
              <div className="active-step-rationale">
                Reviewing the full PR. Pick a step in the sidebar to focus on a slice.
              </div>
            </div>
          )}
          <div className="file-bar">
            {visibleFiles.map((f) => {
              const path = f.newPath || f.oldPath || "(unknown)";
              const fileSteps = stepsByFile.get(path) ?? [];
              const worstRisk = highestRisk(fileSteps);
              return (
                <button
                  key={path}
                  className="file-pill"
                  onClick={() => scrollToFile(path)}
                  title={path}
                >
                  {worstRisk && (
                    <span className={`risk-dot risk-${worstRisk}`} aria-hidden />
                  )}
                  <span className="file-pill-name">{shortPath(path)}</span>
                  <span className="file-pill-stats">
                    +{countAdds(f.hunks)} −{countDels(f.hunks)}
                  </span>
                </button>
              );
            })}
            {visibleFiles.length === 0 && (
              <div className="file-bar-empty">No files in this step.</div>
            )}
          </div>
        </div>

        {visibleFiles.map((file) => {
          const filePath = file.newPath || file.oldPath || "(unknown)";
          const annotations = annotationsByFile.get(filePath) ?? [];
          const steps = stepsByFile.get(filePath) ?? [];
          return (
            <FileDiff
              key={filePath}
              file={file}
              filePath={filePath}
              annotations={annotations}
              steps={steps}
            />
          );
        })}
      </main>
    </div>
  );
}

function shortPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

function highestRisk(steps: ReviewStep[]): string | null {
  if (steps.length === 0) return null;
  const order = { high: 3, medium: 2, low: 1 } as const;
  let best: keyof typeof order = "low";
  for (const s of steps) {
    if ((order[s.risk] ?? 0) > order[best]) best = s.risk;
  }
  return best;
}

interface FileDiffProps {
  file: FileData;
  filePath: string;
  annotations: Array<Annotation & { stepId: string; stepTitle: string }>;
  steps: ReviewStep[];
}

function FileDiff({ file, filePath, annotations, steps }: FileDiffProps) {
  const widgets = useMemo(() => buildWidgets(file.hunks, annotations), [file, annotations]);
  const tokens = useMemo(() => {
    const language = languageForPath(filePath);
    if (!language) return undefined;
    try {
      return tokenize(file.hunks, {
        highlight: true,
        refractor: refractorAdapter,
        language,
        enhancers: [],
      } as any);
    } catch (err) {
      console.warn(`syntax highlighting failed for ${filePath}:`, err);
      return undefined;
    }
  }, [file, filePath]);

  return (
    <section className="file" id={fileSlug(filePath)}>
      <header className="file-head">
        <span className="file-path">{filePath}</span>
        <span className="file-stats">
          <span className="adds">+{countAdds(file.hunks)}</span>{" "}
          <span className="dels">-{countDels(file.hunks)}</span>
        </span>
        <span className="file-steps">
          {steps.map((s) => (
            <span key={s.id} className={`risk-pill risk-${s.risk}`} title={s.title}>
              {s.title}
            </span>
          ))}
        </span>
      </header>
      {file.hunks.length === 0 ? (
        <div className="empty-hunks">(no textual changes — likely binary or rename)</div>
      ) : (
        <Diff
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
          widgets={widgets}
          tokens={tokens}
        >
          {(hunks: HunkData[]) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </section>
  );
}

function buildWidgets(
  hunks: HunkData[],
  annotations: Array<Annotation & { stepId: string; stepTitle: string }>,
): Record<string, JSX.Element> {
  const widgets: Record<string, JSX.Element> = {};
  if (annotations.length === 0) return widgets;

  const headChanges = new Map<number, ChangeData>();
  const baseChanges = new Map<number, ChangeData>();
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if ("lineNumber" in change && typeof change.lineNumber === "number") {
        headChanges.set(change.lineNumber, change);
        baseChanges.set(change.lineNumber, change);
      }
      if ("newLineNumber" in change && typeof change.newLineNumber === "number") {
        headChanges.set(change.newLineNumber, change);
      }
      if ("oldLineNumber" in change && typeof change.oldLineNumber === "number") {
        baseChanges.set(change.oldLineNumber, change);
      }
    }
  }

  const grouped = new Map<string, Array<Annotation & { stepId: string; stepTitle: string }>>();
  for (const a of annotations) {
    const lookup = a.side === "base" ? baseChanges : headChanges;
    let anchor: ChangeData | undefined;
    for (let line = a.line_end; line >= a.line_start; line--) {
      const c = lookup.get(line);
      if (c) {
        anchor = c;
        break;
      }
    }
    if (!anchor) continue;
    const key = getChangeKey(anchor);
    const list = grouped.get(key) ?? [];
    list.push(a);
    grouped.set(key, list);
  }

  for (const [key, items] of grouped) {
    widgets[key] = (
      <div className="annotation-stack">
        {items.map((a, i) => (
          <div key={i} className={`annotation ${SEVERITY_CLASS[a.severity]}`}>
            <div className="annotation-head">
              <span className="annotation-sev">{a.severity}</span>
              <span className="annotation-step">{a.stepTitle}</span>
              <span className="annotation-loc">
                {a.file}:{a.line_start}
                {a.line_end !== a.line_start ? `–${a.line_end}` : ""}
              </span>
            </div>
            <div className="annotation-note">{a.note}</div>
          </div>
        ))}
      </div>
    );
  }

  return widgets;
}

function getChangeKey(change: ChangeData): string {
  if (change.type === "insert") return `I${(change as any).lineNumber}`;
  if (change.type === "delete") return `D${(change as any).lineNumber}`;
  return `N${(change as any).oldLineNumber}-${(change as any).newLineNumber}`;
}

function countAdds(hunks: HunkData[]): number {
  let n = 0;
  for (const h of hunks) for (const c of h.changes) if (c.type === "insert") n++;
  return n;
}
function countDels(hunks: HunkData[]): number {
  let n = 0;
  for (const h of hunks) for (const c of h.changes) if (c.type === "delete") n++;
  return n;
}

async function must(r: Response) {
  if (!r.ok) throw new Error(`${r.url}: ${r.status}`);
  return r.json();
}
