import { LockKeyhole, ShieldCheck, UserPlus } from "lucide-react";
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
            <span>Fantasy intelligence</span>
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
          <p>Join your friends without sharing fantasy-provider credentials or private research.</p>
        </div>

        <div className="login-principles">
          <div>
            <UserPlus size={17} />
            <span>
              <strong>Your own account</strong>
              <small>Personal rankings and recommendations stay yours.</small>
            </span>
          </div>
          <div>
            <ShieldCheck size={17} />
            <span>
              <strong>Scoped league access</strong>
              <small>The invitation grants only its stated role and league.</small>
            </span>
          </div>
        </div>

        <p className="login-story__footnote">
          <LockKeyhole size={13} /> The invitation key stays in this page’s URL fragment and is
          never sent in a web-server request.
        </p>
      </section>

      <section className="login-form-side" aria-label="Accept invitation">
        <InvitationAcceptance />
      </section>
    </main>
  );
}
