"use client";

import type {
  LeagueListResponse,
  ScheduleEdgeAvailability,
  ScheduleEdgeByeFinding,
  ScheduleEdgeFinding,
  ScheduleEdgeMatrixResponse,
  ScheduleEdgeResponse,
  ScheduleEdgeRosterPlayer,
  ScheduleEdgeStrength,
} from "@laces-out/contracts";
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  Gauge,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import {
  apiBaseUrl,
  parseLeagueListResponse,
  parseScheduleEdgeMatrixResponse,
  parseScheduleEdgeResponse,
} from "../lib/api-client";
import { compactDate } from "../lib/copy";
import { DEMO_LEAGUE_ID, demoLeaguePortfolio } from "../lib/demo-contract-data";
import {
  demoScheduleEdgeMatrixResponse,
  demoScheduleEdgeResponse,
} from "../lib/demo-schedule-edge";
import { useDefaultLeague } from "../lib/use-default-league";
import {
  providerForSelectedLeague,
  useFantasyProviderAttribution,
} from "./fantasy-provider-attribution";
import { ScheduleBoard } from "./schedule-board";
import { TeamClaimCallout } from "./team-claim-callout";
import { TourBanner } from "./tour-banner";
import styles from "./schedule-edge-workbench.module.css";

type PortfolioState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly portfolio: LeagueListResponse };

type EdgeState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly data: ScheduleEdgeResponse };

type MatrixState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly data: ScheduleEdgeMatrixResponse };

interface RequestedWindows {
  readonly startWeek: number;
  readonly endWeek: number;
  readonly playoffStartWeek: number;
  readonly playoffEndWeek: number;
}

const weekOptions = Array.from({ length: 18 }, (_, index) => index + 1);
const positionOptions = ["QB", "RB", "WR", "TE"] as const;
type MatrixPosition = (typeof positionOptions)[number];

function requestedWindowsFromUrl(): RequestedWindows | null {
  const query = new URLSearchParams(window.location.search);
  const values = {
    startWeek: Number(query.get("startWeek")),
    endWeek: Number(query.get("endWeek")),
    playoffStartWeek: Number(query.get("playoffStartWeek")),
    playoffEndWeek: Number(query.get("playoffEndWeek")),
  };
  if (
    !Object.values(values).every((value) => Number.isInteger(value) && value >= 1 && value <= 18)
  ) {
    return null;
  }
  if (values.startWeek > values.endWeek || values.playoffStartWeek > values.playoffEndWeek) {
    return null;
  }
  return values;
}

function requestQuery(windows: RequestedWindows | null): string {
  if (!windows) return "";
  return new URLSearchParams({
    startWeek: String(windows.startWeek),
    endWeek: String(windows.endWeek),
    playoffStartWeek: String(windows.playoffStartWeek),
    playoffEndWeek: String(windows.playoffEndWeek),
  }).toString();
}

function contextualHref(href: string, leagueId: string): Route {
  const url = new URL(href, "https://laces.local");
  if (url.pathname === "/decisions" || url.pathname === "/projections") {
    url.searchParams.set("league", leagueId);
  }
  return `${url.pathname}${url.search}${url.hash}` as Route;
}

function kickoff(value: string | null): string {
  if (!value) return "Kickoff TBD";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function points(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function percentile(value: number | null): string {
  if (value === null) return "—";
  const rounded = Math.round(value);
  const remainder = rounded % 100;
  const suffix =
    remainder >= 11 && remainder <= 13
      ? "th"
      : rounded % 10 === 1
        ? "st"
        : rounded % 10 === 2
          ? "nd"
          : rounded % 10 === 3
            ? "rd"
            : "th";
  return `${rounded}${suffix}`;
}

function pointDifference(value: number | null): string {
  if (value === null) return "Difference unavailable";
  if (Math.abs(value) < 0.05) return "At league average";
  return `${value > 0 ? "+" : ""}${points(value)} pts vs league average`;
}

function labelText(value: string): string {
  const readable = value.replaceAll("-", " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

function validationDetail(status: ScheduleEdgeResponse["algorithm"]["validationStatus"]): string {
  if (status === "withheld") return "The historical evidence gate is unavailable.";
  if (status === "validated") return "The evidence gate passed; this view remains descriptive.";
  return "Directional labels are intentionally withheld.";
}

function descriptiveFindings(
  findings: readonly ScheduleEdgeFinding[],
): readonly ScheduleEdgeFinding[] {
  return findings.filter(
    (finding) => finding.kind !== "favorable-window" && finding.kind !== "difficult-window",
  );
}

function SectionHeader({
  icon,
  kicker,
  title,
  detail,
  id,
}: {
  readonly icon: ReactNode;
  readonly kicker?: string;
  readonly title: string;
  readonly detail?: string;
  readonly id: string;
}) {
  return (
    <header className={styles.sectionHeader}>
      <span className={styles.sectionIcon}>{icon}</span>
      <span>
        {kicker ? <small>{kicker}</small> : null}
        <h2 id={id}>{title}</h2>
      </span>
      {detail ? <span className={styles.sectionDetail}>{detail}</span> : null}
    </header>
  );
}

function AvailabilityNotice({
  availability,
  title,
}: {
  readonly availability: ScheduleEdgeAvailability;
  readonly title: string;
}) {
  if (availability.state === "available") return null;
  return (
    <div className={styles.availabilityNotice} data-state={availability.state} role="status">
      <ShieldAlert size={18} aria-hidden="true" />
      <span>
        <strong>
          {title} {availability.state === "partial" ? "is incomplete" : "is unavailable"}
        </strong>
        {availability.reason ? <small>{availability.reason}</small> : null}
      </span>
    </div>
  );
}

function WindowControls({
  data,
  demo,
  loading,
  onApply,
}: {
  readonly data: ScheduleEdgeResponse;
  readonly demo: boolean;
  readonly loading: boolean;
  readonly onApply: (windows: RequestedWindows) => void;
}) {
  const [draft, setDraft] = useState<RequestedWindows>({
    startWeek: data.windows.selected.startWeek,
    endWeek: data.windows.selected.endWeek,
    playoffStartWeek: data.windows.playoff.startWeek,
    playoffEndWeek: data.windows.playoff.endWeek,
  });

  useEffect(() => {
    setDraft({
      startWeek: data.windows.selected.startWeek,
      endWeek: data.windows.selected.endWeek,
      playoffStartWeek: data.windows.playoff.startWeek,
      playoffEndWeek: data.windows.playoff.endWeek,
    });
  }, [
    data.windows.playoff.endWeek,
    data.windows.playoff.startWeek,
    data.windows.selected.endWeek,
    data.windows.selected.startWeek,
  ]);

  const valid = draft.startWeek <= draft.endWeek && draft.playoffStartWeek <= draft.playoffEndWeek;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid && !demo) onApply(draft);
  }

  return (
    <form className={styles.windowControls} onSubmit={submit}>
      <div className={styles.windowGroup}>
        <span>Next look</span>
        <label>
          <span className="sr-only">Starting week</span>
          <select
            value={draft.startWeek}
            disabled={demo}
            onChange={(event) =>
              setDraft((current) => ({ ...current, startWeek: Number(event.target.value) }))
            }
          >
            {weekOptions.map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <i aria-hidden="true">to</i>
        <label>
          <span className="sr-only">Ending week</span>
          <select
            value={draft.endWeek}
            disabled={demo}
            onChange={(event) =>
              setDraft((current) => ({ ...current, endWeek: Number(event.target.value) }))
            }
          >
            {weekOptions.map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.windowGroup}>
        <span>Playoff look</span>
        <label>
          <span className="sr-only">Playoff starting week</span>
          <select
            value={draft.playoffStartWeek}
            disabled={demo}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                playoffStartWeek: Number(event.target.value),
              }))
            }
          >
            {weekOptions.map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <i aria-hidden="true">to</i>
        <label>
          <span className="sr-only">Playoff ending week</span>
          <select
            value={draft.playoffEndWeek}
            disabled={demo}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                playoffEndWeek: Number(event.target.value),
              }))
            }
          >
            {weekOptions.map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
      </div>
      {demo ? (
        <span className={styles.fixedWindow}>Fixed tour window</span>
      ) : (
        <button type="submit" disabled={!valid || loading}>
          {loading ? (
            <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
          ) : (
            <RefreshCw size={15} aria-hidden="true" />
          )}
          Apply
        </button>
      )}
      {!valid ? <span className={styles.windowError}>The ending week must come later.</span> : null}
    </form>
  );
}

function SnapshotContext({
  data,
  demo,
}: {
  readonly data: ScheduleEdgeResponse;
  readonly demo: boolean;
}) {
  const sourceTimes = data.sources
    .map((source) => source.fetchedAt)
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  const oldestRequiredInput =
    sourceTimes.length === 0 ? null : new Date(Math.min(...sourceTimes)).toISOString();

  return (
    <section className={styles.snapshotContext} aria-label="Matchup Outlook context">
      <div>
        <UserRound size={15} aria-hidden="true" />
        <span>
          <small>Team</small>
          <strong>{data.league.claimedTeam?.name ?? "No team selected"}</strong>
        </span>
      </div>
      <div>
        <Gauge size={15} aria-hidden="true" />
        <span>
          <small>Evidence use</small>
          <strong>{labelText(data.algorithm.validationStatus)}</strong>
        </span>
      </div>
      <div>
        <Clock3 size={15} aria-hidden="true" />
        <span>
          <small>Inputs checked</small>
          <strong>{demo ? "Fixed tour fixture" : compactDate(oldestRequiredInput)}</strong>
        </span>
      </div>
      <div>
        <CalendarDays size={15} aria-hidden="true" />
        <span>
          <small>League week</small>
          <strong>
            {data.league.currentWeek ? `Week ${data.league.currentWeek}` : "Preseason"}
          </strong>
        </span>
      </div>
    </section>
  );
}

function findingIcon(finding: ScheduleEdgeFinding) {
  if (finding.kind === "bye-gap") return <CircleAlert size={18} aria-hidden="true" />;
  return <CalendarClock size={18} aria-hidden="true" />;
}

function FindingsSection({
  data,
  demo,
}: {
  readonly data: ScheduleEdgeResponse;
  readonly demo: boolean;
}) {
  const findings = descriptiveFindings(data.findings);
  return (
    <section
      className={styles.findingsSection}
      id="schedule-now"
      aria-labelledby="schedule-now-title"
    >
      <div className={styles.findingsHeading}>
        <span>
          <h2 id="schedule-now-title">Bye-week gaps</h2>
        </span>
        <span>{data.windows.selected.label}</span>
      </div>
      {findings.length === 0 ? (
        <div className={styles.clearFinding}>
          <Check size={18} aria-hidden="true" />
          <span>
            <strong>No bye-week issue in this window</strong>
            <small>
              The current roster can cover every affirmed absence in the selected weeks.
            </small>
          </span>
        </div>
      ) : (
        <div className={styles.findingGrid}>
          {findings.map((finding) => (
            <article data-severity={finding.severity} key={finding.id}>
              <span className={styles.findingIcon}>{findingIcon(finding)}</span>
              <div>
                <span className={styles.findingMeta}>
                  {finding.week ? `Week ${finding.week}` : labelText(finding.kind)}
                </span>
                <h3>{finding.title}</h3>
                <p>{finding.detail}</p>
                {finding.factors.length > 0 ? (
                  <ul>
                    {finding.factors.slice(0, 3).map((factor) => (
                      <li key={factor}>{factor}</li>
                    ))}
                  </ul>
                ) : null}
                {finding.href ? (
                  <Link href={contextualHref(finding.href, data.league.id)}>
                    Open the supporting view
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                ) : null}
                {demo ? <span className="sr-only">Illustrative sample finding</span> : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function MatchupBadge({ player }: { readonly player: ScheduleEdgeRosterPlayer }) {
  if (player.matchup.state === "unavailable" || player.matchup.percentile === null) {
    return <span className={styles.matchupBadge}>Unavailable</span>;
  }
  return (
    <span className={styles.matchupBadge}>{percentile(player.matchup.percentile)} percentile</span>
  );
}

function StrengthSummary({
  label,
  strength,
}: {
  readonly label: string;
  readonly strength: ScheduleEdgeStrength;
}) {
  return (
    <div className={styles.strengthSummary}>
      <span>{label}</span>
      <strong>{percentile(strength.averagePercentile)}</strong>
      <small>
        {strength.rank === null
          ? (strength.reason ?? labelText(strength.state))
          : `Allowance rank ${strength.rank} of ${strength.teamsRanked} · ${labelText(strength.confidence)} coverage`}
      </small>
    </div>
  );
}

function RosterSection({
  data,
  demo,
}: {
  readonly data: ScheduleEdgeResponse;
  readonly demo: boolean;
}) {
  return (
    <section className={styles.panel} id="schedule-roster" aria-labelledby="schedule-roster-title">
      <SectionHeader
        icon={<UserRound size={18} aria-hidden="true" />}
        title="Roster"
        detail={`${data.roster.length} players`}
        id="schedule-roster-title"
      />
      <AvailabilityNotice availability={data.availability.roster} title="Roster outlook" />
      {data.roster.length === 0 ? (
        <div className={styles.emptyState}>
          <Database size={20} aria-hidden="true" />
          <span>
            <strong>No selected roster is available</strong>
            <small>
              Select your team in Settings to add personalized schedule and bye context.
            </small>
          </span>
          <Link href="/settings#teams">Open Settings</Link>
        </div>
      ) : (
        <div className={styles.rosterList}>
          {data.roster.map((player) => (
            <article key={player.playerId}>
              <div className={styles.playerIdentity}>
                {demo ? (
                  <strong>{player.name}</strong>
                ) : (
                  <Link href={`/stats/players/${player.playerId}?season=${data.league.season}`}>
                    {player.name}
                  </Link>
                )}
                <span>
                  {player.primaryPosition} · {player.nflTeam ?? "Team unknown"}
                  {player.currentSlot ? ` · ${player.currentSlot}` : ""}
                </span>
              </div>
              <div className={styles.nextGame}>
                <span>Next</span>
                <strong>
                  {player.next.state === "bye"
                    ? `Week ${player.next.week} bye`
                    : player.next.state === "game"
                      ? `${player.next.opponent ? `Opponent ${player.next.opponent}` : "Opponent TBD"}`
                      : "Schedule unknown"}
                </strong>
                <small>
                  {player.next.state === "game"
                    ? kickoff(player.next.kickoffAt)
                    : player.next.reason}
                </small>
              </div>
              <div className={styles.playerMatchup}>
                <span>Points allowed</span>
                <MatchupBadge player={player} />
                <small>
                  {player.matchup.state === "available"
                    ? `${pointDifference(player.matchup.pointDifferential)} · ${player.matchup.currentGames + player.matchup.priorGames} game sample`
                    : player.matchup.reason}
                </small>
              </div>
              <StrengthSummary
                label={data.windows.selected.label}
                strength={player.selectedWindow}
              />
              <StrengthSummary label={data.windows.playoff.label} strength={player.playoffWindow} />
              <div className={styles.projectionContext}>
                <span>Projection</span>
                <strong>{points(player.projection?.weeklyPoints ?? null)}</strong>
                <small>
                  {player.projection
                    ? `Weekly points · ${player.projection.source}`
                    : (data.availability.projections.reason ?? "No compatible projection")}
                </small>
              </div>
              <div className={styles.rowLinks}>
                <Link href={`/decisions?league=${data.league.id}`}>Decision Desk</Link>
                <Link href={`/projections?league=${data.league.id}`}>Projection Lab</Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const byeOrder: Record<ScheduleEdgeByeFinding["status"], number> = {
  gap: 0,
  thin: 1,
  unknown: 2,
  covered: 3,
};

function ByeCard({ finding }: { readonly finding: ScheduleEdgeByeFinding }) {
  return (
    <article className={styles.byeCard} data-status={finding.status}>
      <div className={styles.byeWeek}>
        <span>Week</span>
        <strong>{finding.week}</strong>
      </div>
      <div>
        <span className={styles.byeStatus}>{labelText(finding.status)}</span>
        <p>{finding.detail}</p>
        {finding.affectedPlayers.length > 0 ? (
          <span className={styles.affectedPlayers}>
            {finding.affectedPlayers.map((player) => player.name).join(", ")}
          </span>
        ) : null}
        {finding.unfilledSlotLabels.length > 0 ? (
          <small>Open slots: {finding.unfilledSlotLabels.join(", ")}</small>
        ) : finding.fragilePlayerIds.length > 0 ? (
          <small>One additional absence would break the lineup.</small>
        ) : null}
      </div>
    </article>
  );
}

function ByePressureSection({ data }: { readonly data: ScheduleEdgeResponse }) {
  const ordered = [...data.byeWeeks].sort(
    (left, right) => byeOrder[left.status] - byeOrder[right.status] || left.week - right.week,
  );
  const attention = ordered.filter((finding) => finding.status !== "covered");
  const covered = ordered.filter((finding) => finding.status === "covered");

  return (
    <section className={styles.panel} id="schedule-byes" aria-labelledby="schedule-byes-title">
      <SectionHeader
        icon={<CalendarClock size={18} aria-hidden="true" />}
        title="Bye pressure"
        detail={`${attention.length} to review`}
        id="schedule-byes-title"
      />
      <AvailabilityNotice availability={data.availability.byeFeasibility} title="Bye feasibility" />
      {ordered.length === 0 ? (
        <div className={styles.emptyState}>
          <CalendarCheck size={20} aria-hidden="true" />
          <span>
            <strong>No bye pressure in this window</strong>
            <small>No affirmed bye creates a lineup constraint in the selected weeks.</small>
          </span>
        </div>
      ) : (
        <>
          <div className={styles.byeList}>
            {attention.map((finding) => (
              <ByeCard finding={finding} key={`${finding.week}:${finding.status}`} />
            ))}
          </div>
          {covered.length > 0 ? (
            <details className={styles.coveredByes}>
              <summary>
                {covered.length} covered bye week{covered.length === 1 ? "" : "s"}
                <ChevronRight size={15} aria-hidden="true" />
              </summary>
              <div className={styles.byeList}>
                {covered.map((finding) => (
                  <ByeCard finding={finding} key={`${finding.week}:${finding.status}`} />
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function PlayoffWindowSection({ data }: { readonly data: ScheduleEdgeResponse }) {
  const supported = data.roster
    .filter(
      (player) =>
        player.playoffWindow.state !== "unavailable" &&
        player.playoffWindow.averagePercentile !== null,
    )
    .sort(
      (left, right) =>
        (right.playoffWindow.averagePercentile ?? -1) -
          (left.playoffWindow.averagePercentile ?? -1) || left.name.localeCompare(right.name),
    );
  const highest = supported.slice(0, 3);
  const lowest = [...supported]
    .reverse()
    .filter((player) => !highest.some((item) => item.playerId === player.playerId))
    .slice(0, 3);

  return (
    <section
      className={styles.panel}
      id="schedule-playoffs"
      aria-labelledby="schedule-playoffs-title"
    >
      <SectionHeader
        icon={<Gauge size={18} aria-hidden="true" />}
        title="Playoff window"
        detail={data.windows.playoff.label}
        id="schedule-playoffs-title"
      />
      {supported.length === 0 ? (
        <div className={styles.emptyState}>
          <ShieldAlert size={20} aria-hidden="true" />
          <span>
            <strong>No playoff-window comparison yet</strong>
            <small>{data.availability.matchups.reason ?? "Matchup evidence is unavailable."}</small>
          </span>
        </div>
      ) : (
        <div className={styles.playoffColumns}>
          <div>
            <h3>Higher allowance percentiles</h3>
            {highest.map((player) => (
              <div key={player.playerId}>
                <span>
                  <strong>{player.name}</strong>
                  <small>
                    {player.primaryPosition} · {player.nflTeam}
                  </small>
                </span>
                <span>
                  <strong>{percentile(player.playoffWindow.averagePercentile)}</strong>
                  <small>#{player.playoffWindow.rank ?? "—"} by allowance</small>
                </span>
              </div>
            ))}
          </div>
          <div>
            <h3>Lower allowance percentiles</h3>
            {lowest.map((player) => (
              <div key={player.playerId}>
                <span>
                  <strong>{player.name}</strong>
                  <small>
                    {player.primaryPosition} · {player.nflTeam}
                  </small>
                </span>
                <span>
                  <strong>{percentile(player.playoffWindow.averagePercentile)}</strong>
                  <small>#{player.playoffWindow.rank ?? "—"} by allowance</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function WeekStrip({ strength }: { readonly strength: ScheduleEdgeStrength }) {
  return (
    <div className={styles.weekStrip}>
      {strength.weeks.map((week) => (
        <span key={week.week}>
          <small>W{week.week}</small>
          <strong>
            {week.state === "bye" ? "Bye" : week.state === "unknown" ? "—" : (week.opponent ?? "—")}
          </strong>
          <i>{percentile(week.percentile)}</i>
        </span>
      ))}
    </div>
  );
}

function MatrixSection({ state }: { readonly state: MatrixState }) {
  const [position, setPosition] = useState<MatrixPosition>("QB");
  const [view, setView] = useState<"selected" | "playoff">("selected");
  const [showAll, setShowAll] = useState(false);

  if (state.state === "loading" || state.state === "idle") {
    return (
      <section
        className={styles.panel}
        id="schedule-matrix"
        aria-labelledby="schedule-matrix-title"
      >
        <SectionHeader
          icon={<UsersRound size={18} aria-hidden="true" />}
          kicker="League-scored history"
          title="Compare opponent allowances"
          id="schedule-matrix-title"
        />
        <div className={styles.loadingState} role="status">
          <LoaderCircle className={styles.spin} size={19} aria-hidden="true" />
          Loading…
        </div>
      </section>
    );
  }
  if (state.state === "error") {
    return (
      <section
        className={styles.panel}
        id="schedule-matrix"
        aria-labelledby="schedule-matrix-title"
      >
        <SectionHeader
          icon={<UsersRound size={18} aria-hidden="true" />}
          kicker="League-scored history"
          title="Compare opponent allowances"
          id="schedule-matrix-title"
        />
        <div className={styles.errorState} role="alert">
          <ShieldAlert size={18} aria-hidden="true" />
          {state.message}
        </div>
      </section>
    );
  }

  const data = state.data;
  const rows = data.teams
    .map((team) => {
      const value = team.positions.find((item) => item.position === position);
      return value ? { team: team.team, value } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => {
      const leftStrength =
        view === "selected" ? left.value.selectedWindow : left.value.playoffWindow;
      const rightStrength =
        view === "selected" ? right.value.selectedWindow : right.value.playoffWindow;
      return (
        (leftStrength.rank ?? 99) - (rightStrength.rank ?? 99) ||
        left.team.localeCompare(right.team)
      );
    });
  const visibleRows = showAll ? rows : rows.slice(0, 12);
  const window = view === "selected" ? data.windows.selected : data.windows.playoff;

  return (
    <section className={styles.panel} id="schedule-matrix" aria-labelledby="schedule-matrix-title">
      <SectionHeader
        icon={<UsersRound size={18} aria-hidden="true" />}
        kicker="League-scored history"
        title="Compare opponent allowances"
        detail={window.label}
        id="schedule-matrix-title"
      />
      <AvailabilityNotice
        availability={data.availability.matchups}
        title="Historical matchup context"
      />
      <div className={styles.matrixControls}>
        <div aria-label="Position" role="group">
          {positionOptions.map((option) => (
            <button
              type="button"
              aria-pressed={position === option}
              onClick={() => {
                setPosition(option);
                setShowAll(false);
              }}
              key={option}
            >
              {option}
            </button>
          ))}
        </div>
        <div aria-label="Schedule window" role="group">
          <button
            type="button"
            aria-pressed={view === "selected"}
            onClick={() => {
              setView("selected");
              setShowAll(false);
            }}
          >
            Next
          </button>
          <button
            type="button"
            aria-pressed={view === "playoff"}
            onClick={() => {
              setView("playoff");
              setShowAll(false);
            }}
          >
            Playoffs
          </button>
        </div>
      </div>
      {visibleRows.length === 0 ? (
        <div className={styles.emptyState}>
          <Database size={20} aria-hidden="true" />
          <span>
            <strong>No {position} history is available</strong>
            <small>The admitted sources did not return a usable position window.</small>
          </span>
        </div>
      ) : (
        <div className={styles.matrixRows}>
          <div className={styles.matrixHeader} aria-hidden="true">
            <span>Team</span>
            <span>Avg allowed</span>
            <span>Allowance rank</span>
            <span>Week by week</span>
          </div>
          {visibleRows.map((row) => {
            const strength =
              view === "selected" ? row.value.selectedWindow : row.value.playoffWindow;
            return (
              <article key={row.team}>
                <strong className={styles.matrixTeam}>{row.team}</strong>
                <span className={styles.matrixScore}>{percentile(strength.averagePercentile)}</span>
                <span className={styles.matrixRank}>
                  {strength.rank === null ? "—" : `#${strength.rank}`}
                  <small>{labelText(strength.confidence)} coverage</small>
                </span>
                <WeekStrip strength={strength} />
              </article>
            );
          })}
        </div>
      )}
      {rows.length > 12 ? (
        <button
          className={styles.showAll}
          type="button"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show first 12" : `Show all ${rows.length} teams`}
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}

function QuickRead({ data }: { readonly data: ScheduleEdgeResponse }) {
  const findings = descriptiveFindings(data.findings);
  const firstBye = data.byeWeeks
    .filter((finding) => finding.status !== "covered")
    .sort((left, right) => byeOrder[left.status] - byeOrder[right.status])[0];
  const highestAllowance = [...data.roster]
    .filter((player) => player.selectedWindow.averagePercentile !== null)
    .sort(
      (left, right) =>
        (right.selectedWindow.averagePercentile ?? -1) -
        (left.selectedWindow.averagePercentile ?? -1),
    )[0];

  return (
    <nav className={styles.quickRead} aria-label="Jump to Matchup Outlook sections">
      <div className={styles.quickReadHeader}>
        <span>Matchup summary</span>
      </div>
      <a href="#schedule-now">
        <CalendarCheck size={16} aria-hidden="true" />
        <span>
          <small>Bye alert</small>
          <strong>{findings[0]?.title ?? "No roster gap found"}</strong>
        </span>
      </a>
      <a href="#schedule-byes">
        <CalendarClock size={16} aria-hidden="true" />
        <span>
          <small>Byes</small>
          <strong>
            {firstBye ? `Week ${firstBye.week} · ${labelText(firstBye.status)}` : "Covered"}
          </strong>
        </span>
      </a>
      <a href="#schedule-roster">
        <UserRound size={16} aria-hidden="true" />
        <span>
          <small>Highest percentile</small>
          <strong>
            {highestAllowance
              ? `${highestAllowance.name} · ${percentile(highestAllowance.selectedWindow.averagePercentile)}`
              : "Waiting for roster"}
          </strong>
        </span>
      </a>
      <a href="#schedule-matrix">
        <Gauge size={16} aria-hidden="true" />
        <span>
          <small>Research</small>
          <strong>NFL teams by position</strong>
        </span>
      </a>
    </nav>
  );
}

function OfficialScheduleDisclosure() {
  const [open, setOpen] = useState(false);
  return (
    <section className={styles.disclosurePanel} id="official-schedule">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className={styles.sectionIcon}>
            <CalendarDays size={18} aria-hidden="true" />
          </span>
          <span>
            <small>Official reference</small>
            <strong>Browse the NFL schedule</strong>
            <i>Kickoffs, results, team views, and affirmed bye weeks.</i>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </summary>
        {open ? <ScheduleBoard embedded /> : null}
      </details>
    </section>
  );
}

function MethodDisclosure({
  data,
  demo,
}: {
  readonly data: ScheduleEdgeResponse;
  readonly demo: boolean;
}) {
  const availability = Object.entries(data.availability);
  return (
    <section className={styles.disclosurePanel} id="schedule-method">
      <details>
        <summary>
          <span className={styles.sectionIcon}>
            <Database size={18} aria-hidden="true" />
          </span>
          <span>
            <small>Method and sources</small>
            <strong>See what supports the read</strong>
            <i>Definitions, coverage, freshness, and validation.</i>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </summary>
        <div className={styles.methodBody}>
          <div className={styles.methodStatus}>
            <div>
              <span>Policy</span>
              <strong>{data.algorithm.version}</strong>
              <small>Versioned calculation</small>
            </div>
            <div>
              <span>Validation</span>
              <strong>{labelText(data.algorithm.validationStatus)}</strong>
              <small>{validationDetail(data.algorithm.validationStatus)}</small>
            </div>
            <div>
              <span>Built</span>
              <strong>{demo ? "Fixed tour fixture" : compactDate(data.generatedAt)}</strong>
              <small>Input {data.algorithm.inputHash.slice(0, 10)}…</small>
            </div>
            <div>
              <span>Scoring</span>
              <strong>{data.scoring.profileKeyHash ? "League compatible" : "Unavailable"}</strong>
              <small>
                {data.scoring.warnings.length > 0
                  ? `${data.scoring.warnings.length} warning${data.scoring.warnings.length === 1 ? "" : "s"}`
                  : "No scoring warnings"}
              </small>
            </div>
          </div>
          <div className={styles.evidenceRecord}>
            <span>
              <small>Evidence checksum</small>
              <strong>{data.algorithm.evidenceChecksum ?? "Not published"}</strong>
            </span>
            <p>
              The checksum identifies the historical evaluation artifact behind this policy.
              Percentiles are shown as context; directional labels and outcome claims stay hidden.
            </p>
          </div>
          <div className={styles.availabilityGrid}>
            {availability.map(([name, value]) => (
              <div key={name}>
                <span className={styles.sourceDot} data-state={value.state} aria-hidden="true" />
                <span>
                  <strong>{labelText(name)}</strong>
                  <small>{value.reason ?? labelText(value.state)}</small>
                </span>
              </div>
            ))}
          </div>
          <div className={styles.sourceList}>
            {data.sources.map((source) => (
              <article key={`${source.dataset}:${source.key}`}>
                <span>
                  <strong>{source.name}</strong>
                  <small>{labelText(source.dataset.replaceAll("-", " "))}</small>
                </span>
                <span>
                  <strong>{demo ? "Tour fixture" : compactDate(source.fetchedAt)}</strong>
                  <small>
                    {source.quality.rowsRead === null
                      ? labelText(source.state)
                      : `${source.quality.rowsRead.toLocaleString()} rows`}
                  </small>
                </span>
              </article>
            ))}
          </div>
          <dl className={styles.definitions}>
            <div>
              <dt>Position percentile</dt>
              <dd>Higher percentiles mean more league-scored points were allowed historically.</dd>
            </div>
            <div>
              <dt>Window average</dt>
              <dd>
                The simple mean of available position percentiles in the selected weeks. Confirmed
                byes are counted but omitted from the mean.
              </dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>
                Describes the amount and completeness of current- and prior-season evidence. It does
                not predict an individual player&apos;s result.
              </dd>
            </div>
            <div>
              <dt>Bye feasibility</dt>
              <dd>
                Tests whether the stored roster can still fill every starter slot under the
                league&apos;s eligibility rules.
              </dd>
            </div>
          </dl>
        </div>
      </details>
    </section>
  );
}

export function ScheduleEdgeWorkbench() {
  const [portfolio, setPortfolio] = useState<PortfolioState>({ state: "loading" });
  const [selectedLeagueId, setSelectedLeagueId] = useState("");
  const [windows, setWindows] = useState<RequestedWindows | null>(null);
  const [edge, setEdge] = useState<EdgeState>({ state: "idle" });
  const [matrix, setMatrix] = useState<MatrixState>({ state: "idle" });
  const edgeRequest = useRef<AbortController | null>(null);
  const matrixRequest = useRef<AbortController | null>(null);
  const { defaultLeagueId, loaded: preferenceLoaded } = useDefaultLeague();
  useFantasyProviderAttribution(
    portfolio.state === "ready"
      ? providerForSelectedLeague(portfolio.portfolio.leagues, selectedLeagueId)
      : null,
  );

  useEffect(() => {
    if (!preferenceLoaded) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/v1/leagues`, {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (response.status === 401) {
          setPortfolio({ state: "signed-out" });
          setSelectedLeagueId(DEMO_LEAGUE_ID);
          setEdge({ state: "ready", data: demoScheduleEdgeResponse });
          setMatrix({ state: "ready", data: demoScheduleEdgeMatrixResponse });
          return;
        }
        if (!response.ok) throw new Error("Your synced leagues could not be loaded.");
        const parsed = parseLeagueListResponse(await response.json());
        if (!parsed) throw new Error("The league response failed its data contract.");
        if (controller.signal.aborted) return;
        setPortfolio({ state: "ready", portfolio: parsed });
        const requestedLeagueId = new URLSearchParams(window.location.search).get("league");
        const usable = parsed.leagues.filter((league) => league.season !== null);
        const selected =
          usable.find((league) => league.id === requestedLeagueId)?.id ??
          usable.find((league) => league.id === defaultLeagueId)?.id ??
          usable[0]?.id ??
          "";
        setSelectedLeagueId(selected);
        setWindows(requestedWindowsFromUrl());
      } catch (error) {
        if (!controller.signal.aborted) {
          setPortfolio({
            state: "error",
            message:
              error instanceof Error ? error.message : "Your synced leagues could not be loaded.",
          });
        }
      }
    })();
    return () => controller.abort();
  }, [defaultLeagueId, preferenceLoaded]);

  const isDemo = portfolio.state === "signed-out";

  const loadEdge = useCallback(async () => {
    edgeRequest.current?.abort();
    matrixRequest.current?.abort();
    if (isDemo) {
      setEdge({ state: "ready", data: demoScheduleEdgeResponse });
      setMatrix({ state: "ready", data: demoScheduleEdgeMatrixResponse });
      return;
    }
    if (!selectedLeagueId) {
      setEdge({ state: "idle" });
      setMatrix({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    edgeRequest.current = controller;
    setEdge({ state: "loading" });
    setMatrix({ state: "idle" });
    const query = requestQuery(windows);
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedLeagueId)}/schedule-edge${query ? `?${query}` : ""}`,
        {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "This league is no longer available to your account."
            : "Matchup Outlook could not be loaded.",
        );
      }
      const parsed = parseScheduleEdgeResponse(await response.json());
      if (!parsed) throw new Error("Matchup Outlook failed its data contract.");
      if (parsed.league.id !== selectedLeagueId) {
        throw new Error("Matchup Outlook did not match the selected league.");
      }
      if (!controller.signal.aborted) setEdge({ state: "ready", data: parsed });
    } catch (error) {
      if (!controller.signal.aborted) {
        setEdge({
          state: "error",
          message: error instanceof Error ? error.message : "Matchup Outlook could not be loaded.",
        });
      }
    } finally {
      if (edgeRequest.current === controller) edgeRequest.current = null;
    }
  }, [isDemo, selectedLeagueId, windows]);

  useEffect(() => {
    void loadEdge();
    return () => edgeRequest.current?.abort();
  }, [loadEdge]);

  useEffect(() => {
    if (isDemo || edge.state !== "ready") return;
    const controller = new AbortController();
    matrixRequest.current?.abort();
    matrixRequest.current = controller;
    setMatrix({ state: "loading" });
    const resolved: RequestedWindows = {
      startWeek: edge.data.windows.selected.startWeek,
      endWeek: edge.data.windows.selected.endWeek,
      playoffStartWeek: edge.data.windows.playoff.startWeek,
      playoffEndWeek: edge.data.windows.playoff.endWeek,
    };
    const query = requestQuery(resolved);
    void (async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedLeagueId)}/schedule-edge/matrix?${query}`,
          {
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("The all-team schedule comparison could not be loaded.");
        const parsed = parseScheduleEdgeMatrixResponse(await response.json());
        if (!parsed) throw new Error("The schedule comparison failed its data contract.");
        if (parsed.league.id !== selectedLeagueId) {
          throw new Error("The schedule comparison did not match the selected league.");
        }
        if (!controller.signal.aborted) setMatrix({ state: "ready", data: parsed });
      } catch (error) {
        if (!controller.signal.aborted) {
          setMatrix({
            state: "error",
            message:
              error instanceof Error
                ? error.message
                : "The all-team schedule comparison could not be loaded.",
          });
        }
      } finally {
        if (matrixRequest.current === controller) matrixRequest.current = null;
      }
    })();
    return () => controller.abort();
  }, [edge, isDemo, selectedLeagueId]);

  function selectLeague(leagueId: string) {
    edgeRequest.current?.abort();
    matrixRequest.current?.abort();
    setSelectedLeagueId(leagueId);
    setEdge({ state: "loading" });
    setMatrix({ state: "idle" });
    const url = new URL(window.location.href);
    if (leagueId) url.searchParams.set("league", leagueId);
    else url.searchParams.delete("league");
    window.history.replaceState(window.history.state, "", url);
  }

  function applyWindows(next: RequestedWindows) {
    edgeRequest.current?.abort();
    matrixRequest.current?.abort();
    setEdge({ state: "loading" });
    setMatrix({ state: "idle" });
    setWindows(next);
    const url = new URL(window.location.href);
    for (const [name, value] of Object.entries(next)) {
      url.searchParams.set(name, String(value));
    }
    window.history.replaceState(window.history.state, "", url);
  }

  const leagues =
    portfolio.state === "ready"
      ? portfolio.portfolio.leagues.filter((league) => league.season !== null)
      : isDemo
        ? demoLeaguePortfolio.leagues
        : [];

  const readyData = edge.state === "ready" ? edge.data : null;

  return (
    <div className={styles.page}>
      {isDemo ? <TourBanner /> : null}

      <header className={styles.hero}>
        <div>
          <h1>Matchup Outlook</h1>
          {isDemo ? (
            <span>
              See how upcoming opponents have scored and where bye weeks could leave a roster hole.
            </span>
          ) : null}
        </div>
        {leagues.length > 0 ? (
          <div className={styles.leagueControls}>
            <label htmlFor="schedule-edge-league">League</label>
            <select
              id="schedule-edge-league"
              value={selectedLeagueId}
              disabled={isDemo}
              onChange={(event) => selectLeague(event.target.value)}
            >
              {leagues.map((league) => (
                <option value={league.id} key={league.id}>
                  {league.name}
                  {league.season ? ` · ${league.season.season}` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={isDemo || edge.state === "loading"}
              onClick={() => void loadEdge()}
            >
              <RefreshCw
                className={edge.state === "loading" ? styles.spin : undefined}
                size={15}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        ) : null}
      </header>

      {portfolio.state === "loading" ? (
        <div className={styles.loadingState} role="status">
          <LoaderCircle className={styles.spin} size={19} aria-hidden="true" />
          Loading…
        </div>
      ) : portfolio.state === "error" ? (
        <div className={styles.errorState} role="alert">
          <AlertTriangle size={19} aria-hidden="true" />
          <span>
            <strong>Personalized Matchup Outlook is unavailable</strong>
            {portfolio.message}
          </span>
        </div>
      ) : portfolio.state === "ready" && leagues.length === 0 ? (
        <div className={styles.setupState}>
          <Database size={20} aria-hidden="true" />
          <span>
            <strong>Connect a league to add your roster</strong>
            The official schedule is still available below.
          </span>
          <Link href="/connections">
            Open League Sync
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      ) : edge.state === "loading" || edge.state === "idle" ? (
        <div className={styles.loadingState} role="status">
          <LoaderCircle className={styles.spin} size={19} aria-hidden="true" />
          Loading…
        </div>
      ) : edge.state === "error" ? (
        <div className={styles.errorState} role="alert">
          <ShieldAlert size={19} aria-hidden="true" />
          <span>
            <strong>Matchup Outlook could not be built</strong>
            {edge.message}
          </span>
        </div>
      ) : readyData ? (
        <>
          <WindowControls data={readyData} demo={isDemo} loading={false} onApply={applyWindows} />
          <SnapshotContext data={readyData} demo={isDemo} />
          <QuickRead data={readyData} />
          <FindingsSection data={readyData} demo={isDemo} />
          {!isDemo && readyData.league.claimedTeam === null ? (
            <TeamClaimCallout leagueId={selectedLeagueId} />
          ) : null}
          <div className={styles.primaryGrid}>
            <RosterSection data={readyData} demo={isDemo} />
            <div className={styles.sideStack}>
              <ByePressureSection data={readyData} />
              <PlayoffWindowSection data={readyData} />
            </div>
          </div>
          <MatrixSection state={matrix} />
        </>
      ) : null}

      <OfficialScheduleDisclosure />
      {readyData ? <MethodDisclosure data={readyData} demo={isDemo} /> : null}
    </div>
  );
}
