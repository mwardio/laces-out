import { ArrowLeft, Info } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { LacesOutMark } from "../../components/laces-out-mark";

import {
  ROS_COUNT_WORDS,
  rosHeldOutSeasons,
  rosScenarioPaths,
  rosScoringProfiles,
  rosSourceSeasons,
  nominalIntervalPercent,
  weeklyChampionOutcome,
  weeklyScopeFigures,
  weeklySeasons,
} from "./evidence";
import styles from "./methodology.module.css";

/** A spelled count that keeps reading correctly however many profiles or seasons are in play. */
function countWord(count: number): string {
  return ROS_COUNT_WORDS[count] ?? String(count);
}

const releasePaths = rosScenarioPaths.release.toLocaleString("en-US");
const referencePaths = rosScenarioPaths.reference.toLocaleString("en-US");
const weeklySeasonCountWord = countWord(weeklySeasons.length);
const rosHeldOutCountWord = countWord(rosHeldOutSeasons.length);
const rosProfileCountWord = countWord(rosScoringProfiles.length);
/** The smallest forecast total, preserving the claim if a future profile has a narrower scope. */
const rosMinimumForecasts = Math.min(
  ...rosScoringProfiles.map((profile) => profile.forecasts),
).toLocaleString("en-US");
/**
 * The weekly figures the page publishes as proof points. Selected by label here, above `metadata`,
 * because everything below that marker is held to the no-numeric-literals rule in
 * `evidence.test.ts` and these labels carry digits.
 */
const WEEKLY_HEADLINE_FIGURES = [
  "Seasons replayed",
  "Player forecasts graded",
  "Team-defense forecasts graded",
  "Player error (MAE)",
  "Player interval coverage (nominal 70%)",
];
const weeklyHeadlineFigures = weeklyScopeFigures.filter((figure) =>
  WEEKLY_HEADLINE_FIGURES.includes(figure.label),
);

/**
 * Deliberately indexable, unlike the signed-in product surfaces such as `/schedule`, which set
 * `index: false`. This page exists to let anyone check the claims made on the landing page without
 * an account, so hiding it from search would defeat its purpose.
 */
export const metadata: Metadata = {
  title: "Forecast methodology",
  description:
    "How Laces Out builds and validates its weekly and rest-of-season forecasts, and what it withholds when the evidence is not there.",
  alternates: { canonical: "/methodology" },
  robots: { index: true, follow: true },
};

/**
 * One header sentence plus a body-size note. The note carries the factual qualifier, so it is never
 * optional — only smaller than the sentence that titles the table.
 */
function TableCaption({ title, note }: { readonly title: ReactNode; readonly note: ReactNode }) {
  return (
    <caption>
      <span className={styles.captionTitle}>{title}</span>
      <span className={styles.captionNote}>{note}</span>
    </caption>
  );
}

export default function MethodologyPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span>
            <strong>Laces Out</strong>
            <small>Forecast methodology</small>
          </span>
        </Link>
        <Link className={styles.back} href="/">
          <ArrowLeft size={15} aria-hidden="true" /> Back to Laces Out
        </Link>
      </header>

      <article className={styles.document}>
        <div className={styles.heading}>
          <p>Method and evidence</p>
          <h1>How the forecasts are built and validated</h1>
        </div>

        <section className={styles.section}>
          <h2>How a forecast is made</h2>
          <div className={styles.pillars}>
            <div className={styles.pillar}>
              <h3>Scored in your league&rsquo;s terms</h3>
              <p>
                The engine forecasts raw stat components &mdash; passing yards, receptions, sacks
                &mdash; and prices them with your league&rsquo;s own scoring rules. A projection
                means what your league means by it.
              </p>
            </div>
            <div className={styles.pillar}>
              <h3>Exact scoring matches, no fallback</h3>
              <p>
                A rule the engine cannot price makes its position unsupported rather than
                approximated, and no position is priced from a partial rule set. Validated evidence
                is used only where that position&rsquo;s scoring key matches the league&rsquo;s
                exactly &mdash; never a near neighbour&rsquo;s.
              </p>
            </div>
            <div className={styles.pillar}>
              <h3>Walk-forward backtests</h3>
              <p>
                Both models are graded by replaying completed NFL seasons at weekly cutoffs. At each
                cutoff the model sees only what existed strictly before it, and realized outcomes
                are used to grade rather than as a feature.
              </p>
            </div>
            <div className={styles.pillar}>
              <h3>Distributions, not point guesses</h3>
              <p>
                Each rest-of-season projection is simulated over {releasePaths} paths, and
                convergence is spot-checked per position-and-horizon stratum against a larger{" "}
                {referencePaths}-path reference run. Both models publish a point estimate inside a
                nominal {nominalIntervalPercent}% interval, and coverage of that interval is itself
                gated.
              </p>
            </div>
            <div className={styles.pillar}>
              <h3>Per-cell release gates</h3>
              <p>
                Every position and horizon is judged on its own evidence and released on its own. A
                cell that does not clear receives nothing rather than a weaker number.
              </p>
            </div>
            <div className={styles.pillar}>
              <h3>Receipts on every set</h3>
              <p>
                Every published projection set carries its model version, input checksum, data
                freshness and warnings in the app, so a number can always be traced to the run that
                produced it.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Two models, graded separately</h2>
          <p>
            Evidence for one model never carries over to the other, so they are graded and gated
            apart.
          </p>
          <ul>
            <li>
              <strong>Weekly forecasts</strong> estimate a single upcoming week for one player or
              team defense. They are re-scored under your league&rsquo;s own rules and publish when
              that week&rsquo;s inputs and gates pass. This is the model behind lineup and start-sit
              calls.
            </li>
            <li>
              <strong>Rest-of-season forecasts</strong> estimate the remainder of a season as a
              distribution rather than a single number, simulating week-by-week availability, role
              and production. They release per league and per position, and only against evidence
              admitted for that league&rsquo;s own scoring.
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Weekly forecasts</h2>
          <p>
            The model that publishes is backtested across {weeklySeasonCountWord} completed NFL
            seasons and re-gated before every release. A richer contextual model is allowed to
            displace the simpler recency baseline only when it beats it by a stated margin on enough
            completed weeks; otherwise the baseline defends and keeps publishing. Sample floors,
            interval coverage and bias are gated per position on every sweep, and a set that fails
            any of them is not published.
          </p>
          <div
            className={styles.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Weekly replay results"
          >
            <table className={styles.table}>
              <TableCaption
                title="Weekly accuracy, measured by replaying completed seasons."
                note="Error is mean absolute error in fantasy points against realized outcomes."
              />
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {weeklyHeadlineFigures.map((figure) => (
                  <tr key={figure.label}>
                    <th scope="row">{figure.label}</th>
                    <td className={styles.numeric}>{figure.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            A promotion rule is only worth having if it can decline, and here it does. The simpler
            model is still winning at every player position, where the richer contextual model came
            in under the required margin. Team defense is held to a different and weaker test: it
            only has to beat its baseline, with no margin required. It does, by{" "}
            {weeklyChampionOutcome.defenseImprovement}.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Rest-of-season forecasts</h2>

          <aside className={styles.status}>
            <Info size={18} aria-hidden="true" />
            <div>
              <strong>Rest-of-season release is gated per league and per position.</strong>
              <p>
                A league receives rest-of-season forecasts only when its scoring matches an admitted
                evidence artifact that has cleared its gates, and its own inputs &mdash; a synced
                league, the current NFL player pool, and a complete remaining-season window &mdash;
                are in place. The rail re-evaluates this hourly, and every run records what it
                released and what it withheld.
              </p>
            </div>
          </aside>

          <p>
            The model simulates the remainder of a season week by week &mdash; availability, role
            and production together &mdash; and reports a distribution rather than a single number.
            It is validated on the same principle as the weekly model: replayed read-only across{" "}
            {rosHeldOutCountWord} fully held-out NFL seasons at weekly cutoffs, with players sampled
            by a prespecified rule rather than chosen after the fact.
          </p>
          <p>
            Because a forecast is only meaningful under the rules it is scored by, the replay is run
            once per scoring profile, currently {rosProfileCountWord} of them, and each grades at
            least {rosMinimumForecasts} forecasts against realized outcomes.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Where we hold back and why</h2>
          <ul>
            <li>
              <strong>A gate that does not clear withholds rather than warns.</strong> When a
              position, horizon or league fails one, Laces Out shows nothing for it rather than a
              weaker number without saying so. A withheld cell means no number is published for that
              position and horizon at all, not a lower-confidence number, so no claim is made about
              the model there.
            </li>
            <li>
              <strong>The rest-of-season evidence is development evidence.</strong> Its held-out
              seasons have been replayed while the model was being revised, so they are not a clean
              out-of-sample test. A genuine confirmation requires a season the model has never seen,
              which is why release stays gated cell by cell rather than granted to the model as a
              whole.
            </li>
            <li>
              <strong>Long horizons are the hard case.</strong> Predicting how many games a player
              will actually play carries irreducible dispersion over a nine-plus week window, which
              is why that horizon is held to a wider tolerance and why its gates are evidence tests
              rather than precise estimates.
            </li>
            <li>
              <strong>These are forecasts, not guarantees.</strong> Laces Out is read-only. It
              prepares decisions and links you to your league host; it never submits a lineup,
              waiver claim, trade or draft pick.
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Underlying data</h2>
          <p>
            Official nflverse play-by-play derived weekly player and team statistics, weekly
            rosters, injury reports, snap counts and schedules for {rosSourceSeasons.first}
            &ndash;{rosSourceSeasons.last}. Every season&rsquo;s inputs are pinned by checksum
            inside the evidence bundle each replay is graded from, and the validation reports behind
            these figures are operator artifacts rather than public files.
          </p>
        </section>
      </article>

      <p className={styles.footer}>
        Independent and non-commercial. Not affiliated with or endorsed by the NFL, Yahoo, or ESPN.{" "}
        <Link href="/privacy">Privacy</Link> &middot; <Link href="/terms">Terms</Link>
      </p>
    </main>
  );
}
