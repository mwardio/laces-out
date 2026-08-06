import type { Metadata } from "next";
import Link from "next/link";

import { InvitationAcceptance } from "../../components/invitation-acceptance";
import { LacesOutMark } from "../../components/laces-out-mark";

export const metadata: Metadata = {
  title: "Accept Invitation",
  description: "Join a private Laces Out fantasy locker room.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function InvitationPage() {
  return (
    <main className="login-page">
      <section className="login-story" aria-labelledby="invite-story-title">
        <Link className="brand login-brand" href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span className="brand-copy">
            <strong>Laces Out</strong>
          </span>
        </Link>

        <div className="login-story__copy">
          <p className="eyebrow">Invite-only league room</p>
          <h2 id="invite-story-title">
            Your league.
            <br />
            Your research.
            <br />
            <em>Your account.</em>
          </h2>
        </div>
      </section>

      <section className="login-form-side" aria-label="Accept invitation">
        <InvitationAcceptance />
      </section>
    </main>
  );
}
