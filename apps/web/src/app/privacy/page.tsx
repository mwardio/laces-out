import { ArrowLeft, LockKeyhole, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../../components/laces-out-mark";
import { cloudflareWebAnalyticsEnabled, publicContactEmail } from "../../lib/public-site";

import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How a self-hosted Laces Out deployment handles account and fantasy league data.",
  robots: { index: true, follow: false },
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span>
            <strong>Laces Out</strong>
            <small>Privacy &amp; data use</small>
          </span>
        </Link>
        <Link className={styles.back} href="/">
          <ArrowLeft size={15} /> Back to Laces Out
        </Link>
      </header>

      <article className={styles.document}>
        <div className={styles.heading}>
          <p>Private, self-hosted deployment</p>
          <h1>Privacy policy</h1>
          <span>Effective July 17, 2026</span>
        </div>

        <aside className={styles.summary}>
          <ShieldCheck size={20} aria-hidden="true" />
          <p>
            Laces Out has no advertising network and does not sell personal information. The person
            who sent your invite operates this deployment and controls its database and backups.
          </p>
        </aside>

        <section>
          <h2>What this deployment stores</h2>
          <ul>
            <li>
              Your display name, normalized email address, password hash, and revocable sessions.
            </li>
            <li>
              Fantasy league settings, teams, rosters, standings, matchups, draft events, and the
              team you claim in each league.
            </li>
            <li>
              Your rankings, auction values, notes, shares, and recommendation inputs or feedback.
            </li>
            <li>
              Operational records such as sync time, source freshness, request correlation IDs, and
              security audit events. Application logs are configured to redact credentials.
            </li>
            <li>
              Film room provider, model, request status, token counts, and timing. If you add a
              personal model-provider API key, it is encrypted. Laces Out does not retain the
              question or answer.
            </li>
          </ul>
        </section>

        <section>
          <h2>Provider connections</h2>
          <p>
            Yahoo authorization happens on Yahoo. The server stores Yahoo tokens in an encrypted,
            versioned credential envelope and uses them only for read-only fantasy sync initiated
            through this deployment. The current release shows the last successful sync and keeps
            unattended Yahoo league refreshes disabled until that scheduler is separately validated.
          </p>
          <p>
            ESPN does not provide this app with a supported consumer Fantasy OAuth flow. The
            one-click sync bookmark and optional browser companion use the ESPN session already
            present in your browser. They send bounded league data to Laces Out, but never send your
            ESPN password or the values of ESPN cookies. Every scoped sync credential can be revoked
            from the League Sync screen.
          </p>
        </section>

        <section>
          <h2>How data is used and shared</h2>
          <p>
            Data is used to synchronize leagues, run deterministic draft and in-season analysis,
            show league-wide statistics to authorized league members, and operate or secure this
            deployment. Private rankings, notes, provider credentials, and personal recommendation
            settings are not exposed to another member unless you explicitly create a permitted
            share.
          </p>
          <p>Laces Out does not sell data or run behavioral advertising.</p>
          {cloudflareWebAnalyticsEnabled ? (
            <p>
              This deployment uses Cloudflare Web Analytics so the operator can see aggregate
              traffic levels. It reports page views through a script loaded from Cloudflare; it is
              not used to build a profile of you, and it plays no part in any recommendation.
              Cloudflare states that it does not log query strings, so the contents of a search or
              filter are not sent. What Cloudflare records and retains is described in its own
              documentation and governed by its terms, not by this policy.
            </p>
          ) : (
            <p>
              This deployment does not include a product-analytics beacon. An operator who adds
              analytics must update this policy before collecting traffic data.
            </p>
          )}
          <p>
            Provider and football-data services receive only the requests required to retrieve their
            data. Film room sends your question and a bounded snapshot of your authorized league,
            recommendations, and analytics to Google Gemini by default using the operator&apos;s
            Google AI Studio project. This included access currently uses Gemini 3.6 Flash and
            requires no personal key. Google states that free-tier submitted content may be used to
            improve its products. You may instead add a separately billed OpenAI, Anthropic, Gemini,
            DeepSeek, Grok, or OpenRouter API key and choose the model; that key is encrypted, is
            not shown again after save, and can be removed at any time. Provider processing is
            governed by that provider&apos;s account terms and privacy choices.
          </p>
        </section>

        <section>
          <h2>Retention, export, and deletion</h2>
          <p>
            The live database retains an account and its authorized artifacts until they are deleted
            by the deployment operator or required for an active shared league. Encrypted backups
            may retain deleted records until that operator’s documented backup rotation completes.
            Ask the person who invited you to export your data, revoke a connection, delete a share,
            or delete your account and associated private data.
          </p>
        </section>

        <section>
          <h2>Security and your choices</h2>
          <p>
            Passwords are protected with Argon2id, browser sessions are HTTP-only, production
            traffic is intended to use HTTPS, and provider credentials are encrypted at rest. No
            small self-hosted service can promise absolute security. Use a unique password, revoke
            provider access if a device or server is compromised, and report unexpected league or
            account activity to the operator promptly.
          </p>
        </section>

        <section id="contact">
          <h2>Policy changes and contact</h2>
          <p>
            Material policy changes should be announced to members before new processing begins.
            This is a private deployment rather than a centrally operated Laces Out service; the
            person who issued your invite operates it and is responsible for access, deletion,
            security, and policy questions.
          </p>
          {publicContactEmail ? (
            <p>
              Provider reviewers, members, and security researchers may contact the deployment
              operator at <a href={`mailto:${publicContactEmail}`}>{publicContactEmail}</a>.
            </p>
          ) : (
            <p>
              Members should contact the operator through the channel used to share their invite.
            </p>
          )}
        </section>

        <footer className={styles.footer}>
          <LockKeyhole size={15} aria-hidden="true" />
          <span>Read-only provider access by default. No hidden transactions.</span>
        </footer>
      </article>
    </main>
  );
}
