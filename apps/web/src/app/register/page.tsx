import { Database, KeyRound, ShieldCheck, UserRoundCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../../components/laces-out-mark";
import { RegistrationForm } from "../../components/registration-form";

export const metadata: Metadata = {
  title: "Create Account",
  description: "Create an invite-only Laces Out account.",
  robots: { index: false, follow: false },
};

export default function RegisterPage() {
  return (
    <main className="login-page register-page">
      <section className="login-story" aria-labelledby="registration-story-title">
        <Link className="brand login-brand" href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span className="brand-copy">
            <strong>Laces Out</strong>
          </span>
        </Link>

        <div className="login-story__copy">
          <p className="eyebrow">Built for league mates</p>
          <h2 id="registration-story-title">
            Join the room.
            <br />
            <em>Keep your account.</em>
          </h2>
          <p>Bring your own teams and rankings into the same league-aware decision room.</p>
        </div>

        <div className="login-principles">
          <div>
            <KeyRound size={17} />
            <span>
              <strong>Shared-code entry</strong>
              <small>Your host controls who can register.</small>
            </span>
          </div>
          <div>
            <UserRoundCheck size={17} />
            <span>
              <strong>Separate identities</strong>
              <small>Every league mate gets an individual account.</small>
            </span>
          </div>
          <div>
            <Database size={17} />
            <span>
              <strong>Private connections</strong>
              <small>Yahoo and ESPN access stays tied to its owner.</small>
            </span>
          </div>
        </div>

        <p className="login-story__footnote">
          <ShieldCheck size={13} /> Passwords are protected with Argon2id. The shared code is never
          saved to the database.
        </p>
      </section>

      <section className="login-form-side register-form-side" aria-label="Create account">
        <RegistrationForm />
        <p className="login-help">
          Registration works only when your host has enabled a deployment-wide invite code. Existing
          one-time invitation links continue to work separately.
        </p>
      </section>
    </main>
  );
}
