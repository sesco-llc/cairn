export type Risk = "low" | "medium" | "high";
export type Severity = "info" | "warning" | "risk";

export interface Annotation {
  file: string;
  line_start: number;
  line_end: number;
  side: "head" | "base";
  severity: Severity;
  note: string;
}

export interface ReviewStep {
  id: string;
  title: string;
  rationale: string;
  files: string[];
  commits: string[];
  depends_on: string[];
  risk: Risk;
  confidence: number;
  smells: string[];
  annotations: Annotation[];
}

export interface ReviewPath {
  steps: ReviewStep[];
  overall: {
    risk: Risk;
    summary: string;
    headline_concerns: string[];
  };
}

export interface CommitInfo {
  oid: string;
  shortSha: string;
  authorName: string;
  message: string;
}

export interface FileInfo {
  path: string;
  additions: number;
  deletions: number;
}

export interface PRMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  baseRef: string;
  headRef: string;
  author: string;
  commits: CommitInfo[];
  files: FileInfo[];
}

export interface ReviewIndexEntry {
  slug: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  generated_at: string;
}
