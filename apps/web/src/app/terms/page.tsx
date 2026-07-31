import { ArrowLeft, FileCheck2, Scale } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../../components/laces-out-mark";
import { publicContactEmail } from "../../lib/public-site";

import styles from "../privacy/privacy.module.css";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms for using this private, non-commercial Laces Out deployment.",
  alternates: { canonical: "/terms" },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span>
            <strong>Laces Out</strong>
            <small>Terms of use</small>
          </span>
        </Link>
        <Link className={styles.back} href="/">
          <ArrowLeft size={15} /> Back to Laces Out
        </Link>
      </header>

      <article className={styles.document}>
        <div className={styles.heading}>
          <p>Private, non-commercial service</p>
          <h1>Terms of use</h1>
          <span>Effective July 31, 2026</span>
        </div>

        <aside className={styles.summary}>
          <Scale size={20} aria-hidden="true" />
          <p>
            Laces Out is an invite-only fantasy football research tool shared among friends. It is
            independent from fantasy providers, free to use, and offered without a promise that a
            recommendation or provider sync will always be available or correct.
          </p>
        </aside>

        <section>
          <h2>Access and acceptance</h2>
          <p>
            By creating an account, accepting an invitation, or using this deployment, you agree to
            these terms and the privacy policy. Access is personal, revocable, and limited to the
            leagues and roles assigned to your account. You must be legally able to use the fantasy
            services you connect and comply with their terms.
          </p>
        </section>

        <section>
          <h2>What Laces Out provides</h2>
          <p>
            The service organizes fantasy league data, custom rankings, projections, draft events,
            and deterministic analysis for research and entertainment. It may offer lineup, waiver,
            and trade recommendations, but you decide whether to act on them. Unless a future
            capability says otherwise with a separate confirmation, provider-side transactions are
            not executed by Laces Out.
          </p>
        </section>

        <section>
          <h2>Accounts and acceptable use</h2>
          <p>
            Keep your password and invitation material private. Do not impersonate another member,
            access a league you are not authorized to view, probe or bypass security controls,
            upload malicious content, overload provider services, resell access, scrape the service,
            or use it for gambling, commercial exploitation, or unlawful activity. Report suspected
            account compromise or objectionable league content to the deployment operator promptly.
            The operator may remove content, revoke league access, or suspend an abusive account.
          </p>
        </section>

        <section>
          <h2>Fantasy providers and third-party data</h2>
          <p>
            Yahoo, ESPN, nflverse, and any other named sources own their services, trademarks, and
            data. Laces Out is not affiliated with or endorsed by them. Connecting a provider grants
            only the authorization you approve and does not transfer ownership of provider data.
            Provider availability, rules, and access terms may change independently of Laces Out.
          </p>
        </section>

        <section>
          <h2>AI analysis and generated recaps</h2>
          <p>
            Live Film Room and Weekly Reckoning requests may send the question or instructions and
            bounded, authorized league context to the AI provider selected for that request. The
            provider&apos;s terms and privacy practices apply. The native app asks for explicit
            permission before each live transfer; canceling sends nothing. AI output can be
            incomplete or wrong and remains subject to these acceptable-use rules. Report
            objectionable generated content to the deployment operator.
          </p>
        </section>

        <section>
          <h2>Your rankings and shared material</h2>
          <p>
            You keep responsibility for rankings, notes, imports, and other material you submit. You
            grant this deployment permission to store and process it only as needed to provide the
            service and the sharing actions you choose. Do not upload material you lack the right to
            use or disclose.
          </p>
        </section>

        <section>
          <h2>No guarantee of results</h2>
          <p>
            Fantasy outcomes are uncertain. Projections can be stale, provider data can be delayed,
            and injuries or lineup locks can change without warning. The service is provided as
            available for informational and entertainment purposes, without warranties or a
            guarantee of accuracy, uptime, league results, prizes, or fitness for a particular use.
            Verify consequential moves with the fantasy provider before acting.
          </p>
        </section>

        <section>
          <h2>Suspension, changes, and ending access</h2>
          <p>
            The operator may suspend access needed to protect members, providers, or the deployment,
            and may change or discontinue features. Material terms changes should be announced to
            members. You may stop using Laces Out at any time. A signed-in member can export data or
            permanently delete the account directly in Settings. The shared-league and encrypted
            backup retention described in the privacy policy still applies.
          </p>
        </section>

        <section id="contact">
          <h2>Contact</h2>
          {publicContactEmail ? (
            <p>
              Questions about these terms may be sent to the deployment operator at{" "}
              <a href={`mailto:${publicContactEmail}`}>{publicContactEmail}</a>.
            </p>
          ) : (
            <p>
              Contact the deployment operator through the channel used to share your invitation.
            </p>
          )}
        </section>

        <footer className={styles.footer}>
          <FileCheck2 size={15} aria-hidden="true" />
          <span>Free, invite-only, and independently operated.</span>
        </footer>
      </article>
    </main>
  );
}
