import { promises as fs } from "node:fs";
import path from "node:path";
import type { PRMeta, ReviewIndex, ReviewIndexEntry, ReviewPath } from "./types.js";

export interface StoreOptions {
  rootDir: string;
}

export function makeSlug(meta: PRMeta): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${safe(meta.owner)}-${safe(meta.repo)}-${meta.number}`;
}

export async function ensureReviewDir(rootDir: string, slug: string): Promise<string> {
  const dir = path.join(rootDir, "reviews", slug);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeReview(
  rootDir: string,
  meta: PRMeta,
  diff: string,
  reviewPath: ReviewPath,
): Promise<{ slug: string; dir: string }> {
  const slug = makeSlug(meta);
  const dir = await ensureReviewDir(rootDir, slug);

  await Promise.all([
    fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2)),
    fs.writeFile(path.join(dir, "diff.patch"), diff),
    fs.writeFile(path.join(dir, "review.json"), JSON.stringify(reviewPath, null, 2)),
  ]);

  await updateIndex(rootDir, {
    slug,
    owner: meta.owner,
    repo: meta.repo,
    number: meta.number,
    title: meta.title,
    url: meta.url,
    generated_at: new Date().toISOString(),
  });

  return { slug, dir };
}

async function readIndex(rootDir: string): Promise<ReviewIndex> {
  const file = path.join(rootDir, "index.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ReviewIndex;
    if (!parsed.reviews) return { reviews: [] };
    return parsed;
  } catch {
    return { reviews: [] };
  }
}

async function updateIndex(rootDir: string, entry: ReviewIndexEntry): Promise<void> {
  const idx = await readIndex(rootDir);
  const without = idx.reviews.filter((r) => r.slug !== entry.slug);
  without.unshift(entry);
  const next: ReviewIndex = { reviews: without };
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, "index.json"), JSON.stringify(next, null, 2));
}
