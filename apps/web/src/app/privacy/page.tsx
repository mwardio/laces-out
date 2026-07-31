import { ArrowLeft, LockKeyhole, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../../components/laces-out-mark";
import { cloudflareWebAnalyticsEnabled, publicContactEmail } from "../../lib/public-site";

import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Laces Out handles account, fantasy league, notification, and AI data.",
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
          <p>Hosted or self-hosted deployment</p>
          <h1>Privacy policy</h1>
          <span>Effective July 31, 2026</span>
        </div>

        <aside className={styles.summary}>
          <ShieldCheck size={20} aria-hidden="true" />
          <p>
            Laces Out has no advertising network and does not sell personal information. The
            operator of the server you choose—Laces Out or a self-host—controls that
            deployment&apos;s database, encrypted backups, provider configuration, and retention
            schedule.
          </p>
        </aside>

        <section>
          <h2>What this deployment stores</h2>
          <ul>
            <li>
              Your display name, normalized email address, password hash, and revocable sessions.
            </li>
            <li>
              Notification-device labels and push-service delivery credentials when you explicitly
              enable alerts. Notification permission is never requested merely by signing in.
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
            <li>
              Weekly Reckoning recaps your league generates, and the League Intel notes that
              personalize them. Both are league data, visible to league members. A recap keeps the
              provider, model, requester, time, and tone level it was written with, and a reroll
              replaces it. Mild recaps stay clean; Medium and Scorched deliberately allow uncensored
              profanity and NSFW adult humor. A failed generation is not stored.
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
          <p>
            The native iOS app communicates with the Laces Out server you select and contains no ad
            network or third-party product-analytics SDK. It stores the selected server address and
            app preferences on your device, keeps the authenticated server cookie in system-managed
            website storage, and uses the system share sheet only when you choose to share. Its
            bundled demo uses local sample data and does not require an account.
          </p>
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
            recommendations, and analytics — plus your league&apos;s League Intel notes when you ask
            for a Weekly Reckoning recap — to Google Gemini by default using the operator&apos;s
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
            A signed-in member can go directly to{" "}
            <Link href="/settings#account-data">Settings → Your data</Link> to download a portable
            JSON export or permanently delete the account. The export includes identity,
            preferences, memberships, private rankings and projections, activity, connection
            metadata, notification history, and AI usage. It deliberately excludes password hashes,
            session or invitation tokens, OAuth and ESPN bridge credentials, push endpoints and
            keys, browser-handoff tokens, encrypted fantasy-provider or AI keys, provider request
            hashes, and share-link tokens.
          </p>
          <p>
            When the native app opens an authenticated web tool, the server stores only a digest of
            a random, single-use handoff lasting at most two minutes. Its bearer is carried in a URL
            fragment that is not sent in HTTP requests or referrers, removed from browser history,
            atomically rotated into a one-minute HttpOnly cookie, then deleted when the ordinary
            revocable browser session is created.
          </p>
          <p>
            Account deletion requires the current password and an explicit destructive confirmation.
            It immediately revokes all sessions, provider and AI credentials, bridge devices, push
            subscriptions, invitations, preferences, private rankings/imports/shares, private
            projections, activity receipts, and league memberships from the live database. A league
            with surviving members is preserved and ownership moves to a surviving commissioner,
            manager, or viewer in that order. A league with no other member is deleted. Shared
            synced facts, league-visible numeric projections, immutable change events, and bounded
            usage/audit records remain only where other members or security accounting still require
            them; direct account attribution is removed, including user identifiers embedded in
            surviving projection and cloned-ranking provenance. League Intel text last written by
            the member and Weekly Reckoning recap text generated by that member are deleted.
          </p>
          <p>
            Encrypted backups may retain deleted records until the deployment operator&apos;s
            documented backup rotation completes. Contact the operator if you cannot sign in or need
            help with an exceptional access request.
          </p>
        </section>

        <section>
          <h2>Security and your choices</h2>
          <p>
            Passwords are protected with Argon2id, browser sessions are HTTP-only, production
            traffic is intended to use HTTPS, and provider credentials are encrypted at rest. No
            internet service can promise absolute security. Use a unique password, revoke provider
            access if a device or server is compromised, and report unexpected league or account
            activity to the operator promptly.
          </p>
        </section>

        <section id="contact">
          <h2>Policy changes and contact</h2>
          <p>
            Material policy changes should be announced to members before new processing begins. The
            operator of the server you selected is responsible for access, backup retention,
            security, and policy questions for that deployment. The official hosted service and a
            self-hosted instance may have different operators.
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
