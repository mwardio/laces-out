"use client";

import type { LeagueAnalyticsSnapshot, LeagueAnalyticsUnavailableReason } from "@fantasy/contracts";
import {
  Activity,
  BarChart3,
  Clock3,
  Crosshair,
  Database,
  Info,
  LoaderCircle,
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
import { AiCoachPanel } from "./ai-coach-panel";
import styles from "./league-analytics-workbench.module.css";

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

function dateTime(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function providerLabel(value: string | null): string {
  if (value === "espn") return "ESPN";
  if (value === "yahoo") return "Yahoo";
  return "League host";
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
        <strong>{title} is waiting for real data</strong>
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
  return (
    <section className={styles.provenance} aria-label="Analytics provenance">
      <div>
        <Clock3 size={16} aria-hidden="true" />
        <span>
          <small>
            Matchups · {snapshot.provenance.matchupObservationsRead} reads →{" "}
            {snapshot.provenance.deduplicatedMatchups} current
          </small>
          <strong>{snapshot.provenance.matchupFreshness.label}</strong>
        </span>
      </div>
      <div>
        <Activity size={16} aria-hidden="true" />
        <span>
          <small>Projection source</small>
          <strong>
            {projection
              ? `${projection.sourceLabel} · Week ${projection.week} · ${projection.visibility}`
              : "No compatible set"}
          </strong>
        </span>
      </div>
      <div>
        <Target size={16} aria-hidden="true" />
        <span>
          <small>Source as of</small>
          <strong>
            {projection
              ? `${projectionSourceAsOfText(projection, dateTime)}${
                  projection.sourceObservedAtStatus === "verified"
                    ? ` · ${snapshot.provenance.projectionFreshness.label}`
                    : ""
                }`
              : snapshot.provenance.projectionFreshness.label}
          </strong>
        </span>
      </div>
      <div>
        <Database size={16} aria-hidden="true" />
        <span>
          <small>Imported at{projection ? ` · ${projection.creatorDisplayName}` : ""}</small>
          <strong>{projection ? dateTime(projection.importedAt) : "Not available"}</strong>
        </span>
      </div>
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
          kicker="Official results"
          title="Season ledger"
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
        kicker="Official results"
        title="Season ledger"
        tag={`${section.officialFinalMatchups} final matchups`}
        titleId="score-title"
      />
      <div
        className={`${styles.tableScroll} has-scroll-cue`}
        role="region"
        aria-label="Season ledger; scroll horizontally to view all columns"
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
                  <strong>
                    {item.team.name}
                    {item.team.isCurrentUser ? <span className={styles.youLabel}>You</span> : null}
                  </strong>
                  <small>{item.team.managerDisplayName ?? "Manager unavailable"}</small>
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
  kicker,
  title,
  tag,
  titleId,
}: {
  readonly icon: ReactNode;
  readonly kicker: string;
  readonly title: string;
  readonly tag: string;
  readonly titleId: string;
}) {
  return (
    <header className={styles.sectionHeader}>
      <span className={styles.sectionIcon}>{icon}</span>
      <div>
        <p>{kicker}</p>
        <h2 id={titleId}>{title}</h2>
      </div>
      <span className={styles.sectionTag}>{tag}</span>
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
        kicker="Availability weighted"
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
                  <strong>
                    {ranking.team.name}
                    {ranking.team.isCurrentUser ? (
                      <span className={styles.youLabel}>You</span>
                    ) : null}
                  </strong>
                  <small>{ranking.team.managerDisplayName ?? "Manager unavailable"}</small>
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
    <section
      className={`${styles.panel} ${styles.widePanel}`}
      id="analytics-positions"
      aria-labelledby="position-title"
    >
      <SectionHeader
        icon={<Target size={18} aria-hidden="true" />}
        kicker="Projection backed"
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
                              ? `${decimal.format(entry.projectedPoints ?? 0)} projected points; rank ${entry.rank} of ${section.teams.length}`
                              : `${entry?.projectedPlayerCount ?? 0} of ${entry?.rosterPlayerCount ?? 0} rostered players projected`
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
                    <td className={styles.profileCell}>
                      <span>
                        Up {team.strengths.length > 0 ? team.strengths.join(" / ") : "even"}
                      </span>
                      <span>
                        Down {team.weaknesses.length > 0 ? team.weaknesses.join(" / ") : "even"}
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

function OpponentSection({ snapshot }: { readonly snapshot: LeagueAnalyticsSnapshot }) {
  const section = snapshot.opponentScout;
  return (
    <section
      className={`${styles.panel} ${styles.opponentPanel}`}
      id="analytics-opponent"
      aria-labelledby="scout-title"
    >
      <SectionHeader
        icon={<Crosshair size={18} aria-hidden="true" />}
        kicker="Current matchup"
        title="Opponent scout"
        tag={section.state === "available" ? `Week ${section.week}` : "Team specific"}
        titleId="scout-title"
      />
      {section.state === "unavailable" ? (
        <Unavailable title="Opponent scout" reasons={section.reasons} />
      ) : (
        <>
          <div className={styles.matchupHeader}>
            <div>
              <small>Your team</small>
              <strong>{section.subject.name}</strong>
            </div>
            <span>vs</span>
            <div>
              <small>{section.matchupStatus}</small>
              <strong>{section.opponent.name}</strong>
            </div>
          </div>
          <div className={styles.scoutMetrics}>
            {section.metrics.map((metric) => (
              <div key={metric.id} title={metric.definition}>
                <span>{metric.label}</span>
                <strong>{metricValue(metric.subjectValue, metric.unit)}</strong>
                <span className={styles.metricEdge} data-edge={metric.edgeOwner}>
                  {metric.edgeOwner === "subject"
                    ? "Your edge"
                    : metric.edgeOwner === "opponent"
                      ? "Opponent edge"
                      : metric.edgeOwner === "even"
                        ? "Even"
                        : "Not enough data"}
                </span>
                <strong>{metricValue(metric.opponentValue, metric.unit)}</strong>
              </div>
            ))}
          </div>
          <p className={styles.methodNote}>{section.definition}</p>
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
  const opponent = snapshot.opponentScout.state === "available" ? snapshot.opponentScout : null;
  const currentScore =
    snapshot.scores.state === "available"
      ? snapshot.scores.teams.find((item) => item.team.isCurrentUser)
      : null;
  const currentPositions =
    snapshot.positional.state === "available"
      ? snapshot.positional.teams.find((item) => item.team.isCurrentUser)
      : null;
  const favorableEdges =
    opponent?.metrics.filter((metric) => metric.edgeOwner === "subject").length ?? 0;

  return (
    <nav className={styles.quickRead} aria-label="Jump to league analytics">
      <div className={styles.quickReadHeader}>
        <span>League in 10 seconds</span>
        <small>Tap for the full read</small>
      </div>
      <a href="#analytics-opponent">
        <Crosshair size={16} aria-hidden="true" />
        <span>
          <small>Opponent</small>
          <strong>
            {opponent
              ? `${favorableEdges} ${favorableEdges === 1 ? "edge" : "edges"} vs ${opponent.opponent.name}`
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
    </nav>
  );
}

export function LeagueAnalyticsWorkbench() {
  const [portfolio, setPortfolio] = useState<PortfolioState>({ state: "loading" });
  const [leagueId, setLeagueId] = useState("");
  const [analytics, setAnalytics] = useState<AnalyticsState>({ state: "idle" });
  const [isDemo, setIsDemo] = useState(false);
  const analyticsRequest = useRef<AbortController | null>(null);

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
          <strong>Loading league access</strong>
          <span>Checking synchronized seasons and team claims.</span>
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
      <div className={styles.errorState} role="alert">
        {portfolio.message}
      </div>
    );
  }
  if (leagues.length === 0) {
    return (
      <div className={styles.gate}>
        <Database size={20} aria-hidden="true" />
        <div>
          <strong>No synchronized leagues yet</strong>
          <span>Connect Yahoo or ESPN to create the first season ledger.</span>
          <Link href="/connections">Open connections</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {isDemo ? (
        <div className={styles.demoNotice} role="status">
          <Info size={17} aria-hidden="true" />
          <span>
            <strong>Locker room tour</strong>
            Illustrative league metrics and opponent scouting. No live account data is shown.
          </span>
        </div>
      ) : null}
      <header className={styles.hero}>
        <div>
          <p>League intelligence</p>
          <h1>League Analytics</h1>
          <span>
            Read the whole room with official results, all-play context, disclosed power rankings,
            roster construction, and the opponent directly in front of you.
          </span>
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
            title={isDemo ? "Sign in to refresh against your own league" : undefined}
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
          Rebuilding league context from stored facts…
        </div>
      ) : analytics.state === "error" ? (
        <div className={styles.errorState} role="alert">
          {analytics.message}
        </div>
      ) : (
        <>
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
              {analytics.snapshot.membership.claimedTeamName ?? "No team claimed"}
            </span>
          </div>
          <AnalyticsQuickRead snapshot={analytics.snapshot} />
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
          <ScoreSection snapshot={analytics.snapshot} />
          <PositionalSection snapshot={analytics.snapshot} />
        </>
      )}
    </div>
  );
}
