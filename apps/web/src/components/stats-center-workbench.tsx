"use client";

import type { StatsCenterMetric, StatsCenterPlayer, StatsCenterResponse } from "@fantasy/contracts";
import {
  ChartSpline,
  Database,
  ExternalLink,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl, parseStatsCenterResponse } from "../lib/api-client";
import styles from "./stats-center-workbench.module.css";

interface FilterState {
  readonly season: number;
  readonly week: number | null;
  readonly position: string;
  readonly search: string;
  readonly sort: StatsCenterMetric;
}

type ViewState =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly data: StatsCenterResponse; readonly demo: boolean };

const metricOptions: readonly { value: StatsCenterMetric; label: string; short: string }[] = [
  { value: "opportunities", label: "Opportunities", short: "OPP" },
  { value: "targets", label: "Targets", short: "TGT" },
  { value: "carries", label: "Carries", short: "CAR" },
  { value: "targetShare", label: "Target share", short: "TGT%" },
  { value: "offensiveSnapShare", label: "Offensive snap share", short: "SNAP%" },
];

const samplePlayers: readonly StatsCenterPlayer[] = [
  {
    playerId: "10000000-0000-4000-8000-000000000001",
    name: "Amon-Ra St. Brown",
    position: "WR",
    team: "DET",
    games: 5,
    snapGames: 5,
    targets: 49,
    carries: 1,
    opportunities: 50,
    targetsPerGame: 9.8,
    carriesPerGame: 0.2,
    opportunitiesPerGame: 10,
    targetShare: 0.286,
    offensiveSnaps: 298,
    offensiveSnapShare: 0.91,
  },
  {
    playerId: "10000000-0000-4000-8000-000000000002",
    name: "Breece Hall",
    position: "RB",
    team: "NYJ",
    games: 5,
    snapGames: 5,
    targets: 27,
    carries: 76,
    opportunities: 103,
    targetsPerGame: 5.4,
    carriesPerGame: 15.2,
    opportunitiesPerGame: 20.6,
    targetShare: 0.168,
    offensiveSnaps: 244,
    offensiveSnapShare: 0.72,
  },
  {
    playerId: "10000000-0000-4000-8000-000000000003",
    name: "Trey McBride",
    position: "TE",
    team: "ARI",
    games: 5,
    snapGames: 5,
    targets: 42,
    carries: 0,
    opportunities: 42,
    targetsPerGame: 8.4,
    carriesPerGame: 0,
    opportunitiesPerGame: 8.4,
    targetShare: 0.241,
    offensiveSnaps: 281,
    offensiveSnapShare: 0.88,
  },
  {
    playerId: "10000000-0000-4000-8000-000000000004",
    name: "Jayden Daniels",
    position: "QB",
    team: "WAS",
    games: 5,
    snapGames: 5,
    targets: 0,
    carries: 41,
    opportunities: 41,
    targetsPerGame: 0,
    carriesPerGame: 8.2,
    opportunitiesPerGame: 8.2,
    targetShare: 0,
    offensiveSnaps: 321,
    offensiveSnapShare: 0.98,
  },
];

function defaultSeason(): number {
  const now = new Date();
  return now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear();
}

const initialFilters: FilterState = {
  season: defaultSeason(),
  week: null,
  position: "",
  search: "",
  sort: "opportunities",
};

function metricValue(player: StatsCenterPlayer, metric: StatsCenterMetric): number | null {
  if (metric === "targets") return player.targets;
  if (metric === "carries") return player.carries;
  if (metric === "opportunities") return player.opportunities;
  if (metric === "targetShare") return player.targetShare;
  return player.offensiveSnapShare;
}

function sampleResponse(filters: FilterState): StatsCenterResponse {
  const normalizedSearch = filters.search.trim().toLocaleLowerCase();
  const hasSample = filters.season === 2025 && filters.week === null;
  const players = hasSample
    ? samplePlayers
        .filter(
          (player) =>
            (!filters.position || player.position === filters.position) &&
            (!normalizedSearch || player.name.toLocaleLowerCase().includes(normalizedSearch)),
        )
        .sort((left, right) => {
          const leftValue = metricValue(left, filters.sort);
          const rightValue = metricValue(right, filters.sort);
          return (rightValue ?? -1) - (leftValue ?? -1) || left.name.localeCompare(right.name);
        })
    : [];
  const datasetState = hasSample
    ? { state: "available" as const, reason: null }
    : { state: "no-data" as const, reason: "The tour includes a 2025 all-weeks sample only." };
  return {
    generatedAt: new Date().toISOString(),
    filters: {
      season: filters.season,
      week: filters.week,
      position: filters.position || null,
      search: filters.search.trim(),
      sort: filters.sort,
      limit: 50,
    },
    availability: {
      targets: datasetState,
      carries: datasetState,
      opportunities: datasetState,
      targetShare: datasetState,
      offensiveSnapShare: datasetState,
      redZone: {
        state: "unavailable",
        reason: "Red-zone attempts and targets are not present in the admitted weekly datasets.",
      },
      boomBust: {
        state: "unavailable",
        reason: "Boom and bust rates wait for verified league scoring and complete coverage.",
      },
      fantasyPointsAllowed: {
        state: "unavailable",
        reason: "Fantasy points allowed waits for verified league scoring and complete coverage.",
      },
    },
    sources: [
      {
        dataset: "weekly-stats",
        state: "available",
        key: "tour.weekly-stats.2025",
        name: "Tour weekly stats",
        attribution: "Illustrative sample modeled on nflverse fields",
        attributionUrl: "https://github.com/nflverse/nflverse-data",
        fetchedAt: "2026-01-10T12:00:00.000Z",
        checksumSha256: "1".repeat(64),
        coveredWeeks: [1, 2, 3, 4, 5],
        quality: { rowsRead: 4, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
        reason: null,
      },
      {
        dataset: "snap-counts",
        state: "available",
        key: "tour.snap-counts.2025",
        name: "Tour snap counts",
        attribution: "Illustrative sample modeled on nflverse fields",
        attributionUrl: "https://github.com/nflverse/nflverse-data",
        fetchedAt: "2026-01-10T12:00:00.000Z",
        checksumSha256: "2".repeat(64),
        coveredWeeks: [1, 2, 3, 4, 5],
        quality: { rowsRead: 4, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
        reason: null,
      },
    ],
    players,
    totalMatched: players.length,
    truncated: false,
    definitions: {
      opportunities: "Opportunities equal carries plus targets from weekly stat rows.",
      targetShare:
        "Target share is player targets divided by all player targets for the same team and games.",
      offensiveSnapShare:
        "Season offensive snap share is the unweighted mean of game-level offensive snap shares.",
    },
  };
}

function dateTime(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** "1–5" for a contiguous run, "1–3, 5" when weeks are missing. */
function weekCoverage(weeks: readonly number[]): string {
  const sorted = [...weeks].sort((left, right) => left - right);
  const first = sorted[0];
  if (first === undefined) return "None";
  const runs: string[] = [];
  let start = first;
  let previous = first;
  for (const week of sorted.slice(1)) {
    if (week === previous + 1) {
      previous = week;
      continue;
    }
    runs.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = week;
    previous = week;
  }
  runs.push(start === previous ? `${start}` : `${start}–${previous}`);
  return runs.join(", ");
}

function number(value: number | null, digits = 0): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
}

function rate(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function StatsCenterWorkbench() {
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async (next: FilterState, demo = false) => {
    requestRef.current?.abort();
    if (demo) {
      setView({ state: "ready", data: sampleResponse(next), demo: true });
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setView({ state: "loading" });
    const query = new URLSearchParams({
      season: String(next.season),
      sort: next.sort,
      limit: "50",
    });
    if (next.week !== null) query.set("week", String(next.week));
    if (next.position) query.set("position", next.position);
    if (next.search.trim()) query.set("search", next.search.trim());
    try {
      const response = await fetch(`${apiBaseUrl}/v1/stats/players?${query.toString()}`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 401) {
        const tourFilters = { ...next, season: 2025, week: null };
        setFilters(tourFilters);
        setView({ state: "ready", data: sampleResponse(tourFilters), demo: true });
        return;
      }
      if (!response.ok) throw new Error("Stats Center could not load its admitted datasets.");
      const parsed = parseStatsCenterResponse(await response.json());
      if (!parsed) throw new Error("The Stats Center response failed its data contract.");
      if (!controller.signal.aborted) setView({ state: "ready", data: parsed, demo: false });
    } catch (error) {
      if (!controller.signal.aborted) {
        setView({
          state: "error",
          message: error instanceof Error ? error.message : "Stats Center could not be loaded.",
        });
      }
    }
  }, []);

  useEffect(() => {
    void load(initialFilters);
    return () => requestRef.current?.abort();
  }, [load]);

  const seasons = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, index) => current - index);
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(filters, view.state === "ready" && view.demo);
  }

  function chooseMetric(metric: StatsCenterMetric) {
    const next = { ...filters, sort: metric };
    setFilters(next);
    void load(next, view.state === "ready" && view.demo);
  }

  return (
    <div className={styles.page}>
      {view.state === "ready" && view.demo ? (
        <div className={styles.demoNotice} role="status">
          <Info size={17} aria-hidden="true" />
          <span>
            <strong>Locker room tour</strong>
            Illustrative opportunity and participation rows. No live player data is shown.
          </span>
        </div>
      ) : null}

      <header className={styles.hero}>
        <div>
          <p>Usage before points</p>
          <h1>Stats Center</h1>
          <span>
            Compare the volume that creates fantasy value: targets, carries, total opportunities,
            target share, and time on the field.
          </span>
        </div>
        <ChartSpline size={34} strokeWidth={1.5} aria-hidden="true" />
      </header>

      <form className={styles.filters} onSubmit={submit}>
        <label>
          <span>Season</span>
          <select
            value={filters.season}
            onChange={(event) =>
              setFilters((current) => ({ ...current, season: Number(event.target.value) }))
            }
          >
            {seasons.map((season) => (
              <option value={season} key={season}>
                {season}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Week</span>
          <select
            value={filters.week ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                week: event.target.value ? Number(event.target.value) : null,
              }))
            }
          >
            <option value="">All weeks</option>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Position</span>
          <select
            value={filters.position}
            onChange={(event) =>
              setFilters((current) => ({ ...current, position: event.target.value }))
            }
          >
            <option value="">All positions</option>
            {["QB", "RB", "WR", "TE", "K"].map((position) => (
              <option value={position} key={position}>
                {position}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.search}>
          <span>Player</span>
          <span>
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              maxLength={80}
              placeholder="Search by name"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.target.value }))
              }
            />
          </span>
        </label>
        <button type="submit" disabled={view.state === "loading"}>
          <RefreshCw
            className={view.state === "loading" ? styles.spin : undefined}
            size={15}
            aria-hidden="true"
          />
          Apply
        </button>
      </form>

      <div className={styles.metricTabs} aria-label="Sort player leaders by metric">
        {metricOptions.map((metric) => (
          <button
            type="button"
            className={filters.sort === metric.value ? styles.activeMetric : undefined}
            aria-pressed={filters.sort === metric.value}
            onClick={() => chooseMetric(metric.value)}
            key={metric.value}
          >
            <span>{metric.short}</span>
            {metric.label}
          </button>
        ))}
      </div>

      {view.state === "loading" ? (
        <div className={styles.stateCard} role="status">
          <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
          <div>
            <strong>Reading the latest admitted files</strong>
            <span>Resolving players and rebuilding opportunity metrics.</span>
          </div>
        </div>
      ) : view.state === "error" ? (
        <div className={styles.stateCard} role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div>
            <strong>Stats Center is unavailable</strong>
            <span>{view.message}</span>
          </div>
        </div>
      ) : (
        <StatsResult data={view.data} />
      )}
    </div>
  );
}

function StatsResult({ data }: { readonly data: StatsCenterResponse }) {
  const selectedAvailability = data.availability[data.filters.sort];
  return (
    <>
      {selectedAvailability.state !== "available" ? (
        <div className={styles.warning} role="status">
          <ShieldAlert size={18} aria-hidden="true" />
          <div>
            <strong>
              {selectedAvailability.state === "no-data"
                ? "No observations for this view"
                : "This metric is withheld"}
            </strong>
            <span>{selectedAvailability.reason}</span>
          </div>
        </div>
      ) : null}

      <section className={styles.leaderPanel} aria-labelledby="leader-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Regular-season observations</p>
            <h2 id="leader-title">
              {metricOptions.find((metric) => metric.value === data.filters.sort)?.label} leaders
            </h2>
          </div>
          {/* The API caps `players` at `limit` but reports the uncapped
              `totalMatched`. Printing only the latter claimed the table showed
              every match. */}
          <span>
            {data.truncated
              ? `Top ${data.players.length} of ${data.totalMatched} players`
              : `${data.totalMatched} player${data.totalMatched === 1 ? "" : "s"}`}
            {data.filters.week ? ` · Week ${data.filters.week}` : " · All weeks"}
          </span>
        </div>
        {data.players.length === 0 ? (
          <div className={styles.emptyState}>
            <Database size={22} aria-hidden="true" />
            <strong>No player rows match this view</strong>
            <span>Try another season, week, position, or player name.</span>
          </div>
        ) : (
          <div
            className={`${styles.tableScroll} has-scroll-cue`}
            role="region"
            aria-label="Player opportunity leaders; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">G</th>
                  <th scope="col">TGT</th>
                  <th scope="col">CAR</th>
                  <th scope="col">OPP</th>
                  <th scope="col">OPP / G</th>
                  <th scope="col">TGT%</th>
                  <th scope="col">SNAP%</th>
                </tr>
              </thead>
              <tbody>
                {data.players.map((player, index) => (
                  <tr key={player.playerId}>
                    <th scope="row">
                      <span className={styles.rank}>{index + 1}</span>
                      <span>
                        <strong>{player.name}</strong>
                        <small>
                          {player.position} · {player.team ?? "FA"}
                        </small>
                      </span>
                    </th>
                    <td>{player.games}</td>
                    <td>{number(player.targets)}</td>
                    <td>{number(player.carries)}</td>
                    <td>{number(player.opportunities)}</td>
                    <td>{number(player.opportunitiesPerGame, 1)}</td>
                    <td>{rate(player.targetShare)}</td>
                    <td>{rate(player.offensiveSnapShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.definition}>
          {
            data.definitions[
              data.filters.sort === "offensiveSnapShare"
                ? "offensiveSnapShare"
                : data.filters.sort === "targetShare"
                  ? "targetShare"
                  : "opportunities"
            ]
          }
        </p>
      </section>

      <section className={styles.sourceSection} aria-labelledby="source-title">
        <div className={styles.sectionHeading}>
          <div>
            <p>Audit trail</p>
            <h2 id="source-title">Source health</h2>
          </div>
        </div>
        <div className={styles.sourceGrid}>
          {data.sources.map((source) => (
            <article key={source.dataset}>
              <div>
                <span className={`${styles.sourceState} ${styles[`sourceState--${source.state}`]}`}>
                  {source.state}
                </span>
                <strong>{source.name}</strong>
              </div>
              <dl>
                <div>
                  <dt>Checked</dt>
                  <dd>{dateTime(source.fetchedAt)}</dd>
                </div>
                <div>
                  <dt>Identity match</dt>
                  <dd>{rate(source.quality.matchRate)}</dd>
                </div>
                <div>
                  <dt>Unresolved</dt>
                  <dd>{number(source.quality.rowsUnmatched)}</dd>
                </div>
                <div>
                  <dt>Rejected</dt>
                  <dd>{number(source.quality.rowsRejected)}</dd>
                </div>
                {source.coveredWeeks.length > 0 ? (
                  <div>
                    <dt>Weeks covered</dt>
                    <dd>{weekCoverage(source.coveredWeeks)}</dd>
                  </div>
                ) : null}
              </dl>
              {source.reason ? <p>{source.reason}</p> : null}
              {source.attribution ? (
                source.attributionUrl ? (
                  <a href={source.attributionUrl} target="_blank" rel="noreferrer">
                    {source.attribution}
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                ) : (
                  <span className={styles.attribution}>{source.attribution}</span>
                )
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className={styles.withheld} aria-labelledby="withheld-title">
        <div className={styles.sectionHeading}>
          <div>
            <p>Honest gaps</p>
            <h2 id="withheld-title">Not inferred from partial data</h2>
          </div>
        </div>
        <div>
          {(
            [
              ["Red-zone usage", data.availability.redZone],
              ["Boom / bust", data.availability.boomBust],
              ["Fantasy points allowed", data.availability.fantasyPointsAllowed],
            ] as const
          ).map(([label, item]) => (
            <article key={label}>
              <strong>{label}</strong>
              <span>{item.reason}</span>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
