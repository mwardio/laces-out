import { ArrowLeft, Goal } from "lucide-react";
import Link from "next/link";

import { LacesOutMark } from "../components/laces-out-mark";

export default function NotFound() {
  return (
    <main className="not-found-page">
      <section className="not-found-card" data-easter-egg="the-laces-were-in">
        <LacesOutMark />
        <p className="eyebrow">404 · No good</p>
        <h1>The kick went wide.</h1>
        <p>This route is off the board. The laces may have been in.</p>
        <Link className="button button--dark" href="/">
          <ArrowLeft size={16} />
          Back to the overview
        </Link>
        <details className="not-found-easter-egg">
          <summary>Open the case file</summary>
          <blockquote>“Dan Marino should die of gonorrhea and rot in hell.”</blockquote>
          <cite>Mrs. Finkle, Ace Ventura: Pet Detective</cite>
        </details>
        <Goal className="not-found-goal" size={44} strokeWidth={1.25} aria-hidden="true" />
      </section>
    </main>
  );
}
