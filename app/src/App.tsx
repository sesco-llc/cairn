import { useEffect, useState } from "react";
import ReviewView from "./ReviewView";
import IndexView from "./IndexView";

function getSlugFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("slug");
}

export default function App() {
  const [slug, setSlug] = useState<string | null>(getSlugFromUrl());

  useEffect(() => {
    const onPop = () => setSlug(getSlugFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = (next: string | null) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("slug", next);
    else url.searchParams.delete("slug");
    window.history.pushState({}, "", url.toString());
    setSlug(next);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => select(null)}>
          Cairn
        </button>
        {slug && (
          <button className="link" onClick={() => select(null)}>
            ← all reviews
          </button>
        )}
      </header>
      {slug ? <ReviewView slug={slug} /> : <IndexView onSelect={select} />}
    </div>
  );
}
