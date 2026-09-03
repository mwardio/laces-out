"use client";

import type {
  LeagueAnalyticsSnapshot,
  LeagueAnalyticsTeam,
  LeagueAnalyticsUnavailableReason,
  WeeklyAward,
} from "@laces-out/contracts";
import {
  Award,
  BarChart3,
  ChevronDown,
  Crosshair,
  Database,
  LoaderCircle,
  Percent,
  RefreshCw,
  ShieldAlert,
  Target,
  Trophy,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  parseLeagueAnalyticsSnapshot,
  parseLeagueListResponse,
  type LeagueListResponse,
} from "../lib/api-client";
import { projectionSourceAsOfText } from "../lib/projection-import-form";
import {
  DEMO_LEAGUE_ID,
  demoAnalyticsSnapshot,
  demoLeaguePortfolio,
} from "../lib/demo-contract-data";
import { providerLabel } from "../lib/copy";
import { AiCoachPanel } from "./ai-coach-panel";
import {
  providerForSelectedLeague,
  useFantasyProviderAttribution,
} from "./fantasy-provider-attribution";
import { ReckoningRecapPanel } from "./reckoning-recap-panel";
import styles from "./league-analytics-workbench.module.css";
import { ShareCardButton, type ShareCardAward } from "./share-card-button";
import { TeamAvatar } from "./team-avatar";
import { TeamClaimCallout } from "./team-claim-callout";
import { TourBanner } from "./tour-banner";

type PortfolioState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly portfolio: LeagueListResponse };

type AnalyticsState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly snapshot: LeagueAnalyticsSnapshot };

type AvailableOpponentScout = Extract<
  LeagueAnalyticsSnapshot["opponentScout"],
  { state: "available" }
>;
type OpponentScoutMatchup = AvailableOpponentScout["matchups"][number];

const decimal = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const signedDecimal = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 0,
});
/** All-play wins count halves for ties, so 7 stays "7" while 6.5 stays "6.5". */
const tally = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
/** Playoff odds and their sampling error move in fractions of a point, so whole percent hides them. */
const probability = new Intl.NumberFormat(undefined, {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function dateTime(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function record(value: { wins: number; losses: number; ties: number }): string {
  return value.ties > 0
    ? `${value.wins}–${value.losses}–${value.ties}`
    : `${value.wins}–${value.losses}`;
}

function Unavailable({
  title,
  reasons,
  projectionLink = false,
}: {
  readonly title: string;
  readonly reasons: readonly LeagueAnalyticsUnavailableReason[];
  readonly projectionLink?: boolean;
}) {
  return (
    <div className={styles.unavailable} role="status">
      <ShieldAlert size={19} aria-hidden="true" />
      <div>
        <strong>{title} unavailable</strong>
        <ul>
          {reasons.map((item) => (
            <li key={`${item.code}:${item.message}`}>{item.message}</li>
          ))}
        </ul>
        {projectionLink && reasons.some((item) => item.code.includes("PROJECTION")) ? (
          <Link href="/projections">Import weekly projections</Link>
        ) : null}
      </div>
    </div>
  );
}

function Provenance({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const projection = snapshot.provenance.projectionSet;
  const playoff = snapshot.playoffOdds;
  const playoffSummary =
    playoff === undefined
      ? "No playoff model"
      : playoff.state === "available"
        ? `${count.format(playoff.simulations)} simulations`
        : "Playoff model withheld";

  return (
    <details className={styles.provenance}>
      <summary>
        <Database size={16} aria-hidden="true" />
        <span>
          <strong>Data snapshot</strong>
          <small>
            {snapshot.provenance.matchupFreshness.label} ·{" "}
            {projection ? `Week ${projection.week} projections` : "No projection set"} ·{" "}
            {playoffSummary}
          </small>
        </span>
        <span className={styles.provenanceAction}>View details</span>
      </summary>
      <dl className={styles.provenanceDetails}>
        <div>
          <dt>Matchups</dt>
          <dd>
            {snapshot.provenance.matchupObservationsRead} reads,{" "}
            {snapshot.provenance.deduplicatedMatchups} current ·{" "}
            {snapshot.provenance.matchupFreshness.label}
          </dd>
        </div>
        <div>
          <dt>Projection source</dt>
          <dd>
            {projection
              ? `${projection.sourceLabel} · Week ${projection.week} · ${projection.visibility}`
              : "No compatible set"}
          </dd>
        </div>
        <div>
          <dt>Source as of</dt>
          <dd>
            {projection
              ? `${projectionSourceAsOfText(projection, dateTime)}${
                  projection.sourceObservedAtStatus === "verified"
                    ? ` · ${snapshot.provenance.projectionFreshness.label}`
                    : ""
                }`
              : snapshot.provenance.projectionFreshness.label}
          </dd>
        </div>
        <div>
          <dt>Imported</dt>
          <dd>
            {projection
              ? `${dateTime(projection.importedAt)} · ${projection.creatorDisplayName}`
              : "Not available"}
          </dd>
        </div>
        <div>
          <dt>Playoff model</dt>
          <dd>
            {playoff === undefined
              ? "Not in this snapshot"
              : playoff.state === "available"
                ? `${count.format(playoff.simulations)} seeded runs`
                : "Withheld — see section"}
            {playoff?.state === "available" ? (
              <code className={styles.seedValue}>{playoff.seed}</code>
            ) : null}
          </dd>
        </div>
      </dl>
    </details>
  );
}

function awardValue(award: WeeklyAward): string {
  return award.unit === "percent"
    ? percent.format(award.value)
    : `${decimal.format(award.value)} pts`;
}

function awardScore(detail: WeeklyAward["detail"]): string | null {
  if (detail.teamPoints === null || detail.opponentPoints === null) return null;
  return `${decimal.format(detail.teamPoints)}–${decimal.format(detail.opponentPoints)}`;
}

function awardAllPlay(detail: WeeklyAward["detail"]): string | null {
  if (detail.allPlayWins === null || detail.allPlayGames === null) return null;
  if (detail.allPlayGames === 0) return null;
  return `${tally.format(detail.allPlayWins)} of ${tally.format(detail.allPlayGames)}`;
}

/** "in a 128.4–131.2 loss to Gridiron Dept.", degrading to whatever the detail actually carries. */
function awardMatchupClause(detail: WeeklyAward["detail"]): string | null {
  const opponent = detail.opponentTeam?.name ?? null;
  const score = awardScore(detail);
  if (score === null || detail.teamPoints === null || detail.opponentPoints === null) {
    return opponent === null ? null : `against ${opponent}`;
  }
  const result =
    detail.teamPoints > detail.opponentPoints
      ? "win"
      : detail.teamPoints < detail.opponentPoints
        ? "loss"
        : "tie";
  const link = result === "win" ? "over" : result === "loss" ? "to" : "with";
  return opponent === null
    ? `in a ${score} ${result}`
    : `in a ${score} ${result} ${link} ${opponent}`;
}

/** Team names like "Gridiron Dept." already end a sentence; never double the period. */
function sentence(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

/**
 * One factual line per award, assembled only from the numbers the section supplied. A missing
 * detail drops its clause instead of printing a placeholder, so a card never implies a number it
 * was not given.
 */
function awardCaption(award: WeeklyAward): string {
  const detail = award.detail;
  const opponent = detail.opponentTeam?.name ?? null;
  const score = awardScore(detail);
  const allPlay = awardAllPlay(detail);
  const versus = [score, opponent === null ? null : `to ${opponent}`]
    .filter((part): part is string => part !== null)
    .join(" ");

  switch (award.id) {
    case "bad-beat":
      if (allPlay !== null) {
        return sentence(
          `Outscored ${allPlay} teams and still lost${versus === "" ? "" : `, ${versus}`}`,
        );
      }
      return versus === "" ? "" : sentence(`Lost ${versus}`);
    case "horseshoe": {
      const won = score !== null ? `Won ${score}` : opponent !== null ? `Beat ${opponent}` : null;
      if (allPlay === null) return won === null ? "" : sentence(won);
      return sentence(
        won === null
          ? `Won while outscoring just ${allPlay} teams`
          : `${won} while outscoring just ${allPlay} teams`,
      );
    }
    case "bench-warmer": {
      const clause = awardMatchupClause(detail);
      return sentence(
        clause === null ? "Points left on the bench" : `Points left on the bench ${clause}`,
      );
    }
    case "beatdown":
      if (opponent !== null) {
        return sentence(`Beat ${opponent}${score === null ? "" : ` ${score}`}`);
      }
      return score === null ? "" : sentence(`Won ${score}`);
    case "photo-finish": {
      const margin = award.unit === "points" ? decimal.format(award.value) : null;
      if (opponent === null) return margin === null ? "" : sentence(`Won by ${margin}`);
      return sentence(margin === null ? `Edged ${opponent}` : `Edged ${opponent} by ${margin}`);
    }
  }
}

/** Keeps a share payload inside the render route's field caps without dropping the field. */
function clampText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

/** The card renderer draws initials rather than a remote logo, so it needs at most three letters. */
function shareInitials(team: LeagueAnalyticsTeam): string {
  const abbreviation = team.abbreviation?.trim() ?? "";
  if (abbreviation.length > 0) return abbreviation.slice(0, 3);
  const words = team.name.split(/\s+/u).filter((word) => word.length > 0);
  const [first, second] = words;
  const derived =
    first === undefined ? "" : second === undefined ? first.slice(0, 2) : first[0]! + second[0]!;
  return derived.length > 0 ? derived : "?";
}

function AwardsSection({
  snapshot,
  isDemo,
}: {
  readonly snapshot: LeagueAnalyticsSnapshot;
  readonly isDemo: boolean;
}) {
  const section = snapshot.weeklyAwards;
  if (section.state === "unavailable") {
    return (
      <section
        className={`${styles.panel} ${styles.awardsPanel}`}
        id="analytics-awards"
        aria-labelledby="awards-title"
      >
        <SectionHeader
          icon={<Award size={18} aria-hidden="true" />}
          title="The Weekly Reckoning"
          tag="Awarded weekly"
          titleId="awards-title"
        />
        <Unavailable title="Weekly awards" reasons={section.reasons} />
      </section>
    );
  }

  const shareAwards: readonly ShareCardAward[] = section.awards.slice(0, 4).map((award) => ({
    label: clampText(award.label, 40),
    teamName: clampText(award.team.name, 60),
    initials: shareInitials(award.team),
    value: clampText(awardValue(award), 24),
    caption: clampText(awardCaption(award), 140),
  }));

  return (
    <section
      className={`${styles.panel} ${styles.awardsPanel}`}
      id="analytics-awards"
      aria-labelledby="awards-title"
    >
      <SectionHeader
        icon={<Award size={18} aria-hidden="true" />}
        title="The Weekly Reckoning"
        tag={`Week ${section.week}`}
        titleId="awards-title"
        action={
          shareAwards.length > 0 ? (
            <ShareCardButton
              payload={{
                leagueName: clampText(snapshot.league.name, 80),
                week: section.week,
                sample: isDemo,
                awards: shareAwards,
              }}
              label="Share card"
            />
          ) : undefined
        }
      />
      {section.awards.length > 0 ? (
        <ul className={styles.awardStrip}>
          {section.awards.map((award) => {
            const caption = awardCaption(award);
            return (
              <li
                className={`${styles.awardCard}${award.team.isCurrentUser ? ` ${styles.currentAward}` : ""}`}
                key={award.id}
                title={award.definition}
              >
                <p className={styles.awardLabel}>{award.label}</p>
                <div className={styles.awardTeam}>
                  <TeamAvatar
                    teamName={award.team.name}
                    logoUrl={award.team.logoUrl}
                    abbreviation={award.team.abbreviation}
                    size="large"
                    highlight={award.team.isCurrentUser}
                  />
                  <span className={styles.teamText}>
                    <strong>
                      {award.team.name}
                      {award.team.isCurrentUser ? (
                        <span className={styles.youLabel}>You</span>
                      ) : null}
                    </strong>
                    <small>{award.team.managerDisplayName ?? "Manager unavailable"}</small>
                  </span>
                </div>
                <strong className={styles.awardValue}>{awardValue(award)}</strong>
                {caption === "" ? null : <p className={styles.awardCaption}>{caption}</p>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.methodNote}>
          {section.withheld.length > 0
            ? `Every award for week ${section.week} is withheld; each reason is listed below.`
            : `No awards were produced for week ${section.week}.`}
        </p>
      )}
      {section.withheld.length > 0 ? (
        <div className={styles.withheldList}>
          {section.withheld.map((item) => (
            <p key={item.id}>
              <strong>{item.label} withheld</strong>
              {" — "}
              {item.reasons.map((reason) => reason.message).join(" ")}
            </p>
          ))}
        </div>
      ) : null}
      {section.definitions.length > 0 ? (
        <details className={styles.definitions}>
          <summary>How an award is earned</summary>
          <div>
            {section.definitions.map((definition) => (
              <p key={definition.id}>
                <strong>{definition.label}</strong> {definition.definition}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function ScoreSection({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const section = snapshot.scores;
  if (section.state === "unavailable") {
    return (
      <section className={styles.panel} id="analytics-season" aria-labelledby="score-title">
        <SectionHeader
          icon={<BarChart3 size={18} aria-hidden="true" />}
          title="Season results"
          tag="Stored scores only"
          titleId="score-title"
        />
        <Unavailable title="Score analytics" reasons={section.reasons} />
      </section>
    );
  }
  const ordered = [...section.teams].sort(
    (left, right) =>
      (right.actualRecord.winPercentage ?? -1) - (left.actualRecord.winPercentage ?? -1) ||
      (right.pointsFor.average ?? -Infinity) - (left.pointsFor.average ?? -Infinity) ||
      left.team.name.localeCompare(right.team.name),
  );
  return (
    <section className={styles.panel} id="analytics-season" aria-labelledby="score-title">
      <SectionHeader
        icon={<BarChart3 size={18} aria-hidden="true" />}
        title="Season results"
        tag={`${section.officialFinalMatchups} final matchups`}
        titleId="score-title"
      />
      <div
        className={`${styles.tableScroll} has-scroll-cue`}
        role="region"
        aria-label="Season results; scroll horizontally to view all columns"
        tabIndex={0}
      >
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Record</th>
              <th scope="col">Win%</th>
              <th scope="col">All-play</th>
              <th scope="col">All-play%</th>
              <th scope="col">xWins</th>
              <th scope="col">Luck</th>
              <th scope="col">PF / wk</th>
              <th scope="col">PA / game</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((item) => (
              <tr
                className={item.team.isCurrentUser ? styles.currentRow : undefined}
                key={item.team.id}
              >
                <th scope="row">
                  <div className={styles.teamCell}>
                    <TeamAvatar
                      teamName={item.team.name}
                      logoUrl={item.team.logoUrl}
                      abbreviation={item.team.abbreviation}
                      size="small"
                      highlight={item.team.isCurrentUser}
                    />
                    <div className={styles.teamText}>
                      <strong>
                        {item.team.name}
                        {item.team.isCurrentUser ? (
                          <span className={styles.youLabel}>You</span>
                        ) : null}
                      </strong>
                      <small>{item.team.managerDisplayName ?? "Manager unavailable"}</small>
                    </div>
                  </div>
                </th>
                <td>{record(item.actualRecord)}</td>
                <td>
                  {item.actualRecord.winPercentage === null
                    ? "—"
                    : percent.format(item.actualRecord.winPercentage)}
                </td>
                <td>{record(item.allPlay)}</td>
                <td>
                  {item.allPlay.winPercentage === null
                    ? "—"
                    : percent.format(item.allPlay.winPercentage)}
                </td>
                <td>{decimal.format(item.expectedWins)}</td>
                <td
                  className={
                    item.luckWins > 0
                      ? styles.positive
                      : item.luckWins < 0
                        ? styles.negative
                        : undefined
                  }
                >
                  {signedDecimal.format(item.luckWins)}
                </td>
                <td>
                  {item.pointsFor.average === null ? "—" : decimal.format(item.pointsFor.average)}
                </td>
                <td>
                  {item.pointsAgainst.average === null
                    ? "—"
                    : decimal.format(item.pointsAgainst.average)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {section.warnings.length > 0 ? (
        <div className={styles.warningList}>
          {section.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
      <details className={styles.definitions}>
        <summary>How these numbers are calculated</summary>
        <div>
          {section.definitions.map((definition) => (
            <p key={definition.id}>
              <strong>{definition.label}</strong> {definition.definition}
            </p>
          ))}
        </div>
      </details>
    </section>
  );
}

function SectionHeader({
  icon,
  title,
  tag,
  titleId,
  action,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly tag: string;
  readonly titleId: string;
  /** Optional control pinned to the end of the header, beside the tag. */
  readonly action?: ReactNode;
}) {
  return (
    <header className={styles.sectionHeader}>
      <span className={styles.sectionIcon}>{icon}</span>
      <div>
        <h2 id={titleId}>{title}</h2>
      </div>
      {action ? (
        <span className={styles.sectionMeta}>
          <span className={styles.sectionTag}>{tag}</span>
          {action}
        </span>
      ) : (
        <span className={styles.sectionTag}>{tag}</span>
      )}
    </header>
  );
}

function PowerSection({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const section = snapshot.power;
  return (
    <section
      className={`${styles.panel} ${styles.powerPanel}`}
      id="analytics-power"
      aria-labelledby="power-title"
    >
      <SectionHeader
        icon={<Trophy size={18} aria-hidden="true" />}
        title="Power board"
        tag="0–100 composite"
        titleId="power-title"
      />
      {section.state === "unavailable" ? (
        <Unavailable title="Power rankings" reasons={section.reasons} />
      ) : (
        <>
          <div className={styles.powerList}>
            {section.rankings.map((ranking) => (
              <article
                className={ranking.team.isCurrentUser ? styles.currentPower : undefined}
                key={ranking.team.id}
              >
                <span className={styles.rank}>{ranking.rank ?? "—"}</span>
                <div className={styles.powerTeam}>
                  <TeamAvatar
                    teamName={ranking.team.name}
                    logoUrl={ranking.team.logoUrl}
                    abbreviation={ranking.team.abbreviation}
                    size="small"
                    highlight={ranking.team.isCurrentUser}
                  />
                  <div className={styles.teamText}>
                    <strong>
                      {ranking.team.name}
                      {ranking.team.isCurrentUser ? (
                        <span className={styles.youLabel}>You</span>
                      ) : null}
                    </strong>
                    <small>{ranking.team.managerDisplayName ?? "Manager unavailable"}</small>
                  </div>
                </div>
                <strong className={styles.powerScore}>
                  {ranking.score === null ? "—" : decimal.format(ranking.score)}
                </strong>
                <div className={styles.coverage}>
                  <span style={{ width: `${Math.round(ranking.dataCoverage * 100)}%` }} />
                </div>
                <small className={styles.coverageLabel}>
                  {percent.format(ranking.dataCoverage)} inputs
                </small>
              </article>
            ))}
          </div>
          <div className={styles.factorKey}>
            {section.factors.map((factor) => (
              <span key={factor.id} title={factor.definition}>
                <strong>{Math.round(factor.configuredWeight * 100)}%</strong> {factor.label}
              </span>
            ))}
          </div>
          <details className={styles.definitions}>
            <summary>Power formula and tie-break</summary>
            <div>
              <p>{section.definition}</p>
              <p>{section.tieBreaker}</p>
              <p>
                Unavailable factors are excluded and remaining weights are renormalized per team.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function strengthClass(value: number | null): string | undefined {
  if (value === null) return styles.missingCell;
  if (value >= 67) return styles.strongCell;
  if (value <= 33) return styles.weakCell;
  return styles.middleCell;
}

function PositionalSection({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const section = snapshot.positional;
  return (
    <section className={styles.panel} id="analytics-positions" aria-labelledby="position-title">
      <SectionHeader
        icon={<Target size={18} aria-hidden="true" />}
        title="Positional map"
        tag="Dedicated starters"
        titleId="position-title"
      />
      {section.state === "unavailable" ? (
        <Unavailable title="Positional analysis" reasons={section.reasons} projectionLink />
      ) : (
        <>
          <div
            className={`${styles.tableScroll} has-scroll-cue`}
            role="region"
            aria-label="Positional map; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table className={`${styles.dataTable} ${styles.positionTable}`}>
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  {section.positions.map((position) => (
                    <th scope="col" key={position}>
                      {position}
                      <small>top {section.basis.starterCounts[position] ?? 0}</small>
                    </th>
                  ))}
                  <th scope="col">Profile</th>
                </tr>
              </thead>
              <tbody>
                {section.teams.map((team) => (
                  <tr
                    className={team.team.isCurrentUser ? styles.currentRow : undefined}
                    key={team.team.id}
                  >
                    <th scope="row">
                      <strong>
                        {team.team.name}
                        {team.team.isCurrentUser ? (
                          <span className={styles.youLabel}>You</span>
                        ) : null}
                      </strong>
                      <small>{percent.format(team.coverage)} coverage</small>
                    </th>
                    {section.positions.map((position) => {
                      const entry = team.entries.find((item) => item.position === position);
                      return (
                        <td
                          className={strengthClass(entry?.strengthPercentile ?? null)}
                          key={position}
                          title={
                            entry?.status === "available"
                              ? `${decimal.format(entry.projectedPoints ?? 0)} pts · #${entry.rank ?? "—"}`
                              : `${entry?.projectedPlayerCount ?? 0}/${entry?.rosterPlayerCount ?? 0} projected`
                          }
                        >
                          <strong>
                            {entry?.strengthPercentile === null ||
                            entry?.strengthPercentile === undefined
                              ? "—"
                              : Math.round(entry.strengthPercentile)}
                          </strong>
                          <small>{entry?.rank ? `#${entry.rank}` : "missing"}</small>
                        </td>
                      );
                    })}
                    <td
                      className={styles.profileCell}
                      aria-label={`${
                        team.strengths.length > 0
                          ? `Stronger positions: ${team.strengths.join(", ")}`
                          : "No standout stronger positions"
                      }. ${
                        team.weaknesses.length > 0
                          ? `Weaker positions: ${team.weaknesses.join(", ")}`
                          : "No standout weaker positions"
                      }.`}
                    >
                      <span
                        aria-hidden="true"
                        data-direction={team.strengths.length > 0 ? "up" : "neutral"}
                      >
                        {team.strengths.length > 0 ? `↑ ${team.strengths.join(" / ")}` : "—"}
                      </span>
                      <span
                        aria-hidden="true"
                        data-direction={team.weaknesses.length > 0 ? "down" : "neutral"}
                      >
                        {team.weaknesses.length > 0 ? `↓ ${team.weaknesses.join(" / ")}` : "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.methodNote}>{section.basis.definition}</p>
        </>
      )}
    </section>
  );
}

function metricValue(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  if (unit === "%") return percent.format(value);
  return decimal.format(value);
}

function projectionCoverage(projection: OpponentScoutMatchup["subjectProjection"]): string {
  if (projection.starterCount === 0) return "No starting lineup stored";
  if (projection.projectedStarterCount === projection.starterCount) {
    return `${projection.starterCount} starters projected`;
  }
  return `${projection.projectedStarterCount}/${projection.starterCount} starters projected`;
}

function ProjectionRoster({
  team,
  projection,
  players,
}: {
  readonly team: LeagueAnalyticsTeam;
  readonly projection: OpponentScoutMatchup["subjectProjection"];
  readonly players: OpponentScoutMatchup["subjectPlayers"];
}) {
  const groups = [
    { label: "Starters", players: players.filter((player) => player.isStarter) },
    { label: "Bench", players: players.filter((player) => !player.isStarter) },
  ].filter((group) => group.players.length > 0);

  return (
    <details className={styles.projectionRoster}>
      <summary>
        <span>
          <strong>
            {team.name}
            {team.isCurrentUser ? <span className={styles.youLabel}>You</span> : null}
          </strong>
          <small>{projectionCoverage(projection)}</small>
        </span>
        <span className={styles.rosterSummaryTotal}>
          <strong>
            {projection.projectedPoints === null
              ? "—"
              : `${decimal.format(projection.projectedPoints)} pts`}
          </strong>
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </summary>
      <div className={styles.projectionRosterBody}>
        {groups.length === 0 ? (
          <p>No current roster is stored for this team.</p>
        ) : (
          groups.map((group) => (
            <section key={group.label} aria-label={`${team.name} ${group.label.toLowerCase()}`}>
              <h4>{group.label}</h4>
              <ul>
                {group.players.map((player) => (
                  <li key={player.playerId}>
                    <span>
                      <strong>{player.name}</strong>
                      <small>
                        {player.primaryPosition}
                        {player.nflTeam ? ` · ${player.nflTeam}` : ""} · {player.slotCode}
                      </small>
                    </span>
                    <strong className={styles.playerProjection}>
                      {player.projectedPoints === null
                        ? "—"
                        : `${decimal.format(player.projectedPoints)} pts`}
                    </strong>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </details>
  );
}

function OpponentSection({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const section = snapshot.opponentScout;
  const matchups = section.state === "available" ? section.matchups : [];
  const defaultMatchupId = section.state === "available" ? section.defaultMatchupId : "";
  const [selectedMatchupId, setSelectedMatchupId] = useState(defaultMatchupId);
  const selectedMatchup =
    matchups.find((matchup) => matchup.id === selectedMatchupId) ?? matchups[0];

  return (
    <section
      className={`${styles.panel} ${styles.opponentPanel}`}
      id="analytics-opponent"
      aria-labelledby="scout-title"
    >
      <SectionHeader
        icon={<Crosshair size={18} aria-hidden="true" />}
        title="Matchup scout"
        tag={section.state === "available" ? `Week ${section.week}` : "League matchups"}
        titleId="scout-title"
      />
      {section.state === "unavailable" ? (
        <Unavailable title="Matchup scout" reasons={section.reasons} />
      ) : selectedMatchup ? (
        <>
          {matchups.length > 1 ? (
            <div className={styles.matchupPicker}>
              <label htmlFor="analytics-matchup">Current matchup</label>
              <select
                id="analytics-matchup"
                value={selectedMatchup.id}
                onChange={(event) => setSelectedMatchupId(event.target.value)}
              >
                {matchups.map((matchup) => (
                  <option value={matchup.id} key={matchup.id}>
                    {matchup.subject.name} vs {matchup.opponent.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className={styles.matchupScoreboard}>
            <article>
              <div className={styles.scoutTeamIdentity}>
                <TeamAvatar
                  teamName={selectedMatchup.subject.name}
                  logoUrl={selectedMatchup.subject.logoUrl}
                  abbreviation={selectedMatchup.subject.abbreviation}
                  size="large"
                  highlight={selectedMatchup.subject.isCurrentUser}
                />
                <span>
                  <small>
                    {selectedMatchup.subject.managerDisplayName ?? "Manager unavailable"}
                  </small>
                  <strong>
                    {selectedMatchup.subject.name}
                    {selectedMatchup.subject.isCurrentUser ? (
                      <span className={styles.youLabel}>You</span>
                    ) : null}
                  </strong>
                </span>
              </div>
              <div className={styles.teamProjectionTotal}>
                <small>Projected starters</small>
                <strong>
                  {selectedMatchup.subjectProjection.projectedPoints === null
                    ? "—"
                    : decimal.format(selectedMatchup.subjectProjection.projectedPoints)}
                </strong>
                <span>{projectionCoverage(selectedMatchup.subjectProjection)}</span>
              </div>
            </article>
            <div className={styles.matchupVersus}>
              <strong>vs</strong>
              <span>{selectedMatchup.matchupStatus.replace("-", " ")}</span>
            </div>
            <article>
              <div className={styles.scoutTeamIdentity}>
                <TeamAvatar
                  teamName={selectedMatchup.opponent.name}
                  logoUrl={selectedMatchup.opponent.logoUrl}
                  abbreviation={selectedMatchup.opponent.abbreviation}
                  size="large"
                  highlight={selectedMatchup.opponent.isCurrentUser}
                />
                <span>
                  <small>
                    {selectedMatchup.opponent.managerDisplayName ?? "Manager unavailable"}
                  </small>
                  <strong>
                    {selectedMatchup.opponent.name}
                    {selectedMatchup.opponent.isCurrentUser ? (
                      <span className={styles.youLabel}>You</span>
                    ) : null}
                  </strong>
                </span>
              </div>
              <div className={styles.teamProjectionTotal}>
                <small>Projected starters</small>
                <strong>
                  {selectedMatchup.opponentProjection.projectedPoints === null
                    ? "—"
                    : decimal.format(selectedMatchup.opponentProjection.projectedPoints)}
                </strong>
                <span>{projectionCoverage(selectedMatchup.opponentProjection)}</span>
              </div>
            </article>
          </div>
          <div className={styles.scoutMetrics}>
            {selectedMatchup.metrics.map((metric) => (
              <div key={metric.id} title={metric.definition}>
                <span>{metric.label}</span>
                <strong>{metricValue(metric.subjectValue, metric.unit)}</strong>
                <span
                  className={styles.metricEdge}
                  data-edge={metric.edgeOwner}
                  aria-label={
                    metric.edgeOwner === "subject"
                      ? `${selectedMatchup.subject.name} edge`
                      : metric.edgeOwner === "opponent"
                        ? `${selectedMatchup.opponent.name} edge`
                        : metric.edgeOwner === "even"
                          ? "Even"
                          : "Not enough data"
                  }
                >
                  {metric.edgeOwner === "subject"
                    ? "← Edge"
                    : metric.edgeOwner === "opponent"
                      ? "Edge →"
                      : metric.edgeOwner === "even"
                        ? "Even"
                        : "Not enough data"}
                </span>
                <strong>{metricValue(metric.opponentValue, metric.unit)}</strong>
              </div>
            ))}
          </div>
          <div className={styles.scoutDetailSection}>
            <header>
              <div>
                <h3>Positional strength</h3>
                <p>Dedicated-starter projections compared across the league.</p>
              </div>
            </header>
            {selectedMatchup.positionalBreakdown.length === 0 ? (
              <p className={styles.scoutEmpty}>Positional projections are not available yet.</p>
            ) : (
              <div
                className={styles.positionComparison}
                role="table"
                aria-label="Positional strength comparison"
              >
                <div className={styles.positionComparisonHeader} role="row">
                  <span role="columnheader">Pos</span>
                  <span role="columnheader">{selectedMatchup.subject.name}</span>
                  <span role="columnheader">Avg</span>
                  <span role="columnheader">{selectedMatchup.opponent.name}</span>
                </div>
                {selectedMatchup.positionalBreakdown.map((position) => (
                  <div className={styles.positionComparisonRow} role="row" key={position.position}>
                    <strong role="rowheader">{position.position}</strong>
                    <span
                      role="cell"
                      data-edge={position.edgeOwner === "subject" ? "winner" : undefined}
                    >
                      <strong>
                        {position.subject.projectedPoints === null
                          ? "—"
                          : `${decimal.format(position.subject.projectedPoints)} pts`}
                      </strong>
                      <small>
                        {position.subject.rank === null
                          ? "No rank"
                          : `#${position.subject.rank} · ${decimal.format(position.subject.strengthPercentile ?? 0)} pct`}
                      </small>
                    </span>
                    <span role="cell" className={styles.positionLeagueMean}>
                      {position.leagueMean === null ? "—" : decimal.format(position.leagueMean)}
                    </span>
                    <span
                      role="cell"
                      data-edge={position.edgeOwner === "opponent" ? "winner" : undefined}
                    >
                      <strong>
                        {position.opponent.projectedPoints === null
                          ? "—"
                          : `${decimal.format(position.opponent.projectedPoints)} pts`}
                      </strong>
                      <small>
                        {position.opponent.rank === null
                          ? "No rank"
                          : `#${position.opponent.rank} · ${decimal.format(position.opponent.strengthPercentile ?? 0)} pct`}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className={styles.scoutDetailSection}>
            <header>
              <div>
                <h3>Player projections</h3>
                <p>Every stored roster player, split between starters and bench.</p>
              </div>
            </header>
            <div className={styles.projectionRosters}>
              <ProjectionRoster
                team={selectedMatchup.subject}
                projection={selectedMatchup.subjectProjection}
                players={selectedMatchup.subjectPlayers}
              />
              <ProjectionRoster
                team={selectedMatchup.opponent}
                projection={selectedMatchup.opponentProjection}
                players={selectedMatchup.opponentPlayers}
              />
            </div>
          </div>
          <p className={styles.methodNote}>{section.definition}</p>
        </>
      ) : null}
    </section>
  );
}

/** A nonzero share must never round to a bare "0%", which would read as impossible. */
function seedShare(value: number): string {
  if (value === 0) return "—";
  if (value < 0.005) return "<1%";
  return percent.format(value);
}

/**
 * "0%" and "100%" are reserved for results the simulation actually produced in every or no run.
 * A near-miss is shown as a bound so a 99.96% team is never read as already qualified.
 */
function oddsShare(value: number): string {
  if (value === 0 || value === 1) return percent.format(value);
  if (value < 0.001) return "<0.1%";
  if (value > 0.999) return ">99.9%";
  return probability.format(value);
}

/** "8.4–5.6" or "8.4–5.6–1.0"; simulated ties are dropped only when there are effectively none. */
function projectedRecord(team: {
  readonly averageFinalWins: number;
  readonly averageFinalLosses: number;
  readonly averageFinalTies: number;
}): string {
  const base = `${decimal.format(team.averageFinalWins)}–${decimal.format(team.averageFinalLosses)}`;
  return team.averageFinalTies >= 0.05 ? `${base}–${decimal.format(team.averageFinalTies)}` : base;
}

function PlayoffOddsSection({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const section = snapshot.playoffOdds;
  const ordered =
    section?.state === "available"
      ? [...section.teams].sort(
          (left, right) =>
            right.playoffProbability - left.playoffProbability ||
            left.expectedSeed - right.expectedSeed ||
            left.team.name.localeCompare(right.team.name),
        )
      : [];
  const seeds =
    section?.state === "available"
      ? (section.teams[0]?.seedProbabilities.map((entry) => entry.seed) ?? [])
      : [];

  return (
    <section className={styles.panel} id="analytics-playoffs" aria-labelledby="playoffs-title">
      <SectionHeader
        icon={<Percent size={18} aria-hidden="true" />}
        title="Playoff odds"
        tag={
          section?.state === "available" ? `Top ${section.playoffTeamCount} qualify` : "Rule bound"
        }
        titleId="playoffs-title"
      />
      {section === undefined ? (
        <p className={styles.methodNote}>
          This snapshot carries no playoff odds section. Refresh against a synchronized league to
          simulate the remaining schedule.
        </p>
      ) : section.state === "unavailable" ? (
        <Unavailable title="Playoff odds" reasons={section.reasons} />
      ) : (
        <>
          <div
            className={`${styles.tableScroll} has-scroll-cue`}
            role="region"
            aria-label="Playoff odds; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table className={`${styles.dataTable} ${styles.playoffTable}`}>
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  <th scope="col">Playoff</th>
                  <th scope="col">± sampling</th>
                  <th scope="col">Exp. seed</th>
                  <th scope="col">Proj. record</th>
                  <th scope="col">Proj. PF</th>
                  <th scope="col">Wk mean</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((item) => (
                  <tr
                    className={item.team.isCurrentUser ? styles.currentRow : undefined}
                    key={item.team.id}
                  >
                    <th scope="row">
                      <div className={styles.teamCell}>
                        <TeamAvatar
                          teamName={item.team.name}
                          logoUrl={item.team.logoUrl}
                          abbreviation={item.team.abbreviation}
                          size="small"
                          highlight={item.team.isCurrentUser}
                        />
                        <div className={styles.teamText}>
                          <strong>
                            {item.team.name}
                            {item.team.isCurrentUser ? (
                              <span className={styles.youLabel}>You</span>
                            ) : null}
                          </strong>
                          <small>{item.team.managerDisplayName ?? "Manager unavailable"}</small>
                        </div>
                      </div>
                    </th>
                    <td>
                      <strong>{oddsShare(item.playoffProbability)}</strong>
                    </td>
                    <td className={styles.mutedCell}>
                      ± {probability.format(item.monteCarloStandardError)}
                    </td>
                    <td>{decimal.format(item.expectedSeed)}</td>
                    <td>{projectedRecord(item)}</td>
                    <td>{decimal.format(item.averageFinalPointsFor)}</td>
                    <td className={styles.mutedCell}>
                      {decimal.format(item.scoringMean)} ±{" "}
                      {decimal.format(item.scoringStandardDeviation)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.subTableTitle}>Seed distribution</p>
          <div
            className={`${styles.tableScroll} has-scroll-cue`}
            role="region"
            aria-label="Seed distribution; scroll horizontally to view every seed"
            tabIndex={0}
          >
            <table className={`${styles.dataTable} ${styles.seedTable}`}>
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  {seeds.map((seed) => (
                    <th scope="col" key={seed}>
                      #{seed}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ordered.map((item) => (
                  <tr
                    className={item.team.isCurrentUser ? styles.currentRow : undefined}
                    key={item.team.id}
                  >
                    <th scope="row">
                      <strong>
                        {item.team.name}
                        {item.team.isCurrentUser ? (
                          <span className={styles.youLabel}>You</span>
                        ) : null}
                      </strong>
                      <small>Expected #{decimal.format(item.expectedSeed)}</small>
                    </th>
                    {item.seedProbabilities.map((entry) => (
                      <td
                        className={
                          entry.seed <= section.playoffTeamCount ? undefined : styles.mutedCell
                        }
                        key={entry.seed}
                      >
                        {seedShare(entry.probability)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className={styles.definitions}>
            <summary>How these odds are produced</summary>
            <div>
              <p>{section.definition}</p>
              <p>
                <strong>{section.forecastBasis.label}</strong> {section.forecastBasis.definition}
              </p>
              {section.samplingErrorDefinition === null ? null : (
                <p>
                  <strong>Sampling error</strong> {section.samplingErrorDefinition}
                </p>
              )}
              <p>
                <strong>Inputs</strong> {section.factors.join("; ")}.
              </p>
              <p>
                <strong>Tie-breaks</strong> {section.tieBreakers.join("; ")}.
              </p>
              <p>
                {count.format(section.simulations)} simulations over{" "}
                {count.format(section.remainingMatchups)} remaining{" "}
                {section.remainingMatchups === 1 ? "matchup" : "matchups"}, seeded from{" "}
                <code className={styles.seedValue}>{section.seed}</code>.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function AnalyticsQuickRead({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const currentPower =
    snapshot.power.state === "available"
      ? snapshot.power.rankings.find((item) => item.team.isCurrentUser)
      : null;
  const scout = snapshot.opponentScout.state === "available" ? snapshot.opponentScout : null;
  const featuredMatchup =
    scout?.matchups.find(
      (matchup) => matchup.subject.isCurrentUser || matchup.opponent.isCurrentUser,
    ) ?? scout?.matchups[0];
  const currentScore =
    snapshot.scores.state === "available"
      ? snapshot.scores.teams.find((item) => item.team.isCurrentUser)
      : null;
  const currentPositions =
    snapshot.positional.state === "available"
      ? snapshot.positional.teams.find((item) => item.team.isCurrentUser)
      : null;
  const favorableEdges =
    featuredMatchup?.metrics.filter((metric) => metric.edgeOwner === "subject").length ?? 0;

  return (
    <nav className={styles.quickRead} aria-label="Jump to league analytics">
      <div className={styles.quickReadHeader}>
        <span>League summary</span>
      </div>
      <a href="#analytics-opponent">
        <Crosshair size={16} aria-hidden="true" />
        <span>
          <small>{featuredMatchup?.subject.isCurrentUser ? "Opponent" : "Matchup"}</small>
          <strong>
            {featuredMatchup?.subject.isCurrentUser
              ? `${favorableEdges} ${favorableEdges === 1 ? "edge" : "edges"} vs ${featuredMatchup.opponent.name}`
              : featuredMatchup
                ? `${featuredMatchup.subject.name} vs ${featuredMatchup.opponent.name}`
                : "Waiting for matchup"}
          </strong>
        </span>
      </a>
      <a href="#analytics-power">
        <Trophy size={16} aria-hidden="true" />
        <span>
          <small>Power</small>
          <strong>
            {currentPower
              ? `#${currentPower.rank ?? "—"} · ${currentPower.score === null ? "—" : decimal.format(currentPower.score)}`
              : "Waiting for inputs"}
          </strong>
        </span>
      </a>
      <a href="#analytics-positions">
        <Target size={16} aria-hidden="true" />
        <span>
          <small>Roster shape</small>
          <strong>
            {currentPositions?.strengths.length
              ? `Strong at ${currentPositions.strengths.slice(0, 2).join(" / ")}`
              : "Even profile"}
          </strong>
        </span>
      </a>
      <a href="#analytics-season">
        <BarChart3 size={16} aria-hidden="true" />
        <span>
          <small>Season</small>
          <strong>
            {currentScore
              ? `${record(currentScore.actualRecord)} · ${decimal.format(currentScore.expectedWins)} xW`
              : "No ledger yet"}
          </strong>
        </span>
      </a>
    </nav>
  );
}

export function LeagueAnalyticsWorkbench() {
  const [portfolio, setPortfolio] = useState<PortfolioState>({ state: "loading" });
  const [leagueId, setLeagueId] = useState("");
  const [analytics, setAnalytics] = useState<AnalyticsState>({ state: "idle" });
  const [isDemo, setIsDemo] = useState(false);
  const analyticsRequest = useRef<AbortController | null>(null);
  useFantasyProviderAttribution(
    portfolio.state === "ready"
      ? providerForSelectedLeague(portfolio.portfolio.leagues, leagueId)
      : null,
  );

  /** Opt in to the labeled tour after a failed load, matching the Overview page's offer. */
  const showSample = useCallback(() => {
    analyticsRequest.current?.abort();
    analyticsRequest.current = null;
    setIsDemo(true);
    setPortfolio({ state: "ready", portfolio: demoLeaguePortfolio });
    setLeagueId(DEMO_LEAGUE_ID);
    setAnalytics({ state: "ready", snapshot: demoAnalyticsSnapshot });
  }, []);

  const selectLeague = useCallback((nextLeagueId: string) => {
    setLeagueId(nextLeagueId);
    const url = new URL(window.location.href);
    if (nextLeagueId) url.searchParams.set("league", nextLeagueId);
    else url.searchParams.delete("league");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/v1/leagues`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          setIsDemo(true);
          setPortfolio({ state: "ready", portfolio: demoLeaguePortfolio });
          setLeagueId(DEMO_LEAGUE_ID);
          setAnalytics({ state: "ready", snapshot: demoAnalyticsSnapshot });
          return;
        }
        if (!response.ok) throw new Error("League portfolio could not be loaded.");
        const parsed = parseLeagueListResponse(await response.json());
        if (!parsed) throw new Error("The league portfolio response was invalid.");
        setPortfolio({ state: "ready", portfolio: parsed });
        const requestedLeagueId = new URLSearchParams(window.location.search).get("league");
        const requestedLeague = parsed.leagues.find((league) => league.id === requestedLeagueId);
        selectLeague(
          requestedLeague?.id ||
            parsed.leagues.find((league) => league.season)?.id ||
            parsed.leagues[0]?.id ||
            "",
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          setPortfolio({
            state: "error",
            message:
              error instanceof Error ? error.message : "League portfolio could not be loaded.",
          });
        }
      }
    })();
    return () => controller.abort();
  }, [selectLeague]);

  const loadAnalytics = useCallback(async () => {
    if (!leagueId) return;
    analyticsRequest.current?.abort();
    if (isDemo) {
      analyticsRequest.current = null;
      setAnalytics({ state: "ready", snapshot: demoAnalyticsSnapshot });
      return;
    }
    const controller = new AbortController();
    analyticsRequest.current = controller;
    setAnalytics({ state: "loading" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/leagues/${leagueId}/analytics`, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "That league is no longer accessible."
            : "League analytics could not be loaded.",
        );
      }
      const parsed = parseLeagueAnalyticsSnapshot(await response.json());
      if (!parsed) throw new Error("The analytics response failed its data contract.");
      if (controller.signal.aborted) return;
      setAnalytics({ state: "ready", snapshot: parsed });
    } catch (error) {
      if (controller.signal.aborted) return;
      setAnalytics({
        state: "error",
        message: error instanceof Error ? error.message : "League analytics could not be loaded.",
      });
    }
  }, [isDemo, leagueId]);

  useEffect(() => {
    if (leagueId) void loadAnalytics();
    return () => analyticsRequest.current?.abort();
  }, [leagueId, loadAnalytics]);

  const leagues = useMemo(
    () => (portfolio.state === "ready" ? portfolio.portfolio.leagues : []),
    [portfolio],
  );

  if (portfolio.state === "loading") {
    return (
      <div className={styles.gate} role="status">
        <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
        <div>
          <strong>Loading…</strong>
        </div>
      </div>
    );
  }
  if (portfolio.state === "signed-out") {
    return (
      <div className={styles.gate}>
        <ShieldAlert size={20} aria-hidden="true" />
        <div>
          <strong>Sign in to open league analytics</strong>
          <span>League history and private projections are protected by membership.</span>
          <Link href="/login">Sign in</Link>
        </div>
      </div>
    );
  }
  if (portfolio.state === "error") {
    return (
      <div className={styles.errorGroup}>
        <div className={styles.errorState} role="alert">
          <span>
            Your leagues could not be loaded. They are still there — this is a connection problem,
            not a data loss.
          </span>
        </div>
        <div className={styles.sampleOffer} role="status">
          <span>Nothing below would be your data.</span>
          <button type="button" onClick={showSample}>
            Show sample data
          </button>
        </div>
      </div>
    );
  }
  if (leagues.length === 0) {
    return (
      <div className={styles.gate}>
        <Database size={20} aria-hidden="true" />
        <div>
          <strong>No leagues yet</strong>
          <span>Connect Yahoo or ESPN to continue.</span>
          <Link href="/connections">Open League Sync</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {isDemo ? <TourBanner /> : null}
      <header className={styles.hero}>
        <div>
          <h1>League Analytics</h1>
          {isDemo ? (
            <span>
              Read the whole room with official results, all-play context, disclosed power rankings,
              roster construction, and the opponent directly in front of you.
            </span>
          ) : null}
        </div>
        <div className={styles.controls}>
          <label htmlFor="analytics-league">League</label>
          <select
            id="analytics-league"
            value={leagueId}
            onChange={(event) => selectLeague(event.target.value)}
          >
            {leagues.map((league) => (
              <option value={league.id} key={league.id}>
                {league.name}
                {league.season ? ` · ${league.season.season}` : " · setup needed"}
              </option>
            ))}
          </select>
          {/* Tour mode re-sets the identical snapshot, so this had no observable
              effect at all when pressed. */}
          <button
            type="button"
            onClick={() => void loadAnalytics()}
            disabled={isDemo || analytics.state === "loading"}
          >
            <RefreshCw
              className={analytics.state === "loading" ? styles.spin : undefined}
              size={15}
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>
      </header>

      {analytics.state === "loading" || analytics.state === "idle" ? (
        <div className={styles.loadingState} role="status">
          <LoaderCircle className={styles.spin} size={18} aria-hidden="true" />
          Loading…
        </div>
      ) : analytics.state === "error" ? (
        <div className={styles.errorState} role="alert">
          {analytics.message}
        </div>
      ) : (
        <>
          {!isDemo &&
          !(
            analytics.snapshot.power.state === "available" &&
            analytics.snapshot.power.rankings.some((ranking) => ranking.team.isCurrentUser)
          ) ? (
            <TeamClaimCallout leagueId={leagueId} />
          ) : null}
          <div className={styles.snapshotTitle}>
            <div>
              <strong>{analytics.snapshot.league.name}</strong>
              <span>
                {analytics.snapshot.league.season ?? "No season"} ·{" "}
                {providerLabel(analytics.snapshot.league.provider)} · Week{" "}
                {analytics.snapshot.league.currentWeek ?? "—"}
              </span>
            </div>
            <span>
              Generated {dateTime(analytics.snapshot.generatedAt)} ·{" "}
              {analytics.snapshot.membership.claimedTeamName ?? "No team selected"}
            </span>
          </div>
          <AnalyticsQuickRead snapshot={analytics.snapshot} />
          <AwardsSection snapshot={analytics.snapshot} isDemo={isDemo} />
          <ReckoningRecapPanel leagueId={leagueId} snapshot={analytics.snapshot} demo={isDemo} />
          <Provenance snapshot={analytics.snapshot} />
          <AiCoachPanel
            leagueId={leagueId}
            features={["weekly-brief", "standings-prediction"]}
            demo={isDemo}
            eyebrow="AI league read"
            title="Turn the league table into a forecast"
            description="Summarize the week or project the final order from stored results, all-play performance, roster strength, and current projections."
          />
          <div className={styles.primaryGrid}>
            <OpponentSection snapshot={analytics.snapshot} />
            <PowerSection snapshot={analytics.snapshot} />
          </div>
          <PlayoffOddsSection snapshot={analytics.snapshot} />
          <PositionalSection snapshot={analytics.snapshot} />
          <ScoreSection snapshot={analytics.snapshot} />
        </>
      )}
    </div>
  );
}
