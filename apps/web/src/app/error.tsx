"use client";

import { RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { LacesOutMark } from "../components/laces-out-mark";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="not-found-page">
      <section className="not-found-card" role="alert">
        <LacesOutMark />
        <p className="eyebrow">Something broke</p>
        <h1>That play didn’t load.</h1>
        <p>
          This view could not finish. If you just submitted a change, verify its result before
          trying again.
        </p>
        <button className="button button--dark" type="button" onClick={reset}>
          <RefreshCw size={16} />
          Try again
        </button>
      </section>
    </main>
  );
}
