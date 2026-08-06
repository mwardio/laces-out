import { Database, Eye, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../../components/laces-out-mark";
import { LoginForm } from "../../components/login-form";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to your Laces Out locker room.",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-story" aria-labelledby="login-story-title">
        <Link className="brand login-brand" href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span className="brand-copy">
            <strong>Laces Out</strong>
          </span>
        </Link>

        <div className="login-story__copy">
          <h2 id="login-story-title">
            Every league.
            <br />
            <em>One clear view.</em>
          </h2>
          <p>A private fantasy locker room for draft night and every decision after it.</p>
        </div>

        <div className="login-principles">
          <div>
            <ShieldCheck size={17} />
            <span>
              <strong>Separate identities</strong>
              <small>No open registration or shared provider accounts.</small>
            </span>
          </div>
          <div>
            <Eye size={17} />
            <span>
              <strong>Read-only recommendations</strong>
              <small>You approve every move at the provider.</small>
            </span>
          </div>
          <div>
            <Database size={17} />
            <span>
              <strong>Source-aware analysis</strong>
              <small>Data age and sources stay visible.</small>
            </span>
          </div>
        </div>
      </section>

      <section className="login-form-side" aria-label="Account sign in">
        <LoginForm />
      </section>
    </main>
  );
}
