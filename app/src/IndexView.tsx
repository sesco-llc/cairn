import { useEffect, useState } from "react";
import type { ReviewIndexEntry } from "./types";

interface Props {
  onSelect: (slug: string) => void;
}

export default function IndexView({ onSelect }: Props) {
  const [entries, setEntries] = useState<ReviewIndexEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/_data/index.json")
      .then((r) => {
        if (!r.ok) throw new Error(`No reviews yet (${r.status}).`);
        return r.json();
      })
      .then((data) => setEntries(data.reviews ?? []))
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="empty">
        <h2>No reviews yet</h2>
        <p>
          Run <code>cairn-app review &lt;pr-url&gt;</code> in the project root.
          The CLI writes files to <code>../.cairn/</code> and they show up
          here.
        </p>
      </div>
    );
  }

  if (!entries) return <div className="empty">Loading…</div>;

  if (entries.length === 0) {
    return (
      <div className="empty">
        <h2>No reviews yet</h2>
        <p>Run the CLI to generate one.</p>
      </div>
    );
  }

  return (
    <div className="index">
      <h1>Reviews</h1>
      <ul className="reviews">
        {entries.map((e) => (
          <li key={e.slug}>
            <button onClick={() => onSelect(e.slug)} className="review-row">
              <div className="review-title">{e.title}</div>
              <div className="review-meta">
                {e.owner}/{e.repo}#{e.number} · {new Date(e.generated_at).toLocaleString()}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
