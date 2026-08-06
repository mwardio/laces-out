"use client";

import type {
  StatsCenterMetricDescriptor,
  StatsCenterPlayerDetailResponse,
  StatsCenterScoring,
} from "@laces-out/contracts";
import {
  ArrowLeft,
  CalendarOff,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseStatsCenterPlayerDetail } from "../lib/api-client";
import styles from "./player-profile.module.css";
import { dateTime, number, rate, signed, weekCoverage } from "./stats-formatting";

interface FilterState {
  readonly season: number;
  readonly weekFrom: number | null;
  readonly weekTo: number | null;
  readonly scoring: StatsCenterScoring;
}

type ViewState =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "missing" }
  | { readonly state: "ready"; readonly data: StatsCenterPlayerDetailResponse };

function defaultSeason(): number {
  const now = new Date();
  return now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear();
}

/** Only metrics with a value in this window are worth a tile; the rest state their reason. */
function summaryTiles(data: StatsCenterPlayerDetailResponse): readonly {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}[] {
  const { summary } = data;
  return [
    {
      label: "Games",
      value: number(summary.games),
      hint: `${summary.snapGames} with snap rows`,
    },
    {
      label: "Opportunities",
      value: number(summary.opportunities),
      hint: `${number(summary.opportunitiesPerGame, 1)} per game`,
    },
    {
      label: "Target share",
      value: rate(summary.targetShare),
      hint: `${number(summary.targets)} targets`,
    },
    {
      label: "Snap share",
      value: rate(summary.offensiveSnapShare),
      hint: `${number(summary.offensiveSnaps)} snaps`,
    },
    {
      label: data.filters.scoring === "ppr" ? "Points (PPR)" : "Points (standard)",
      value: number(
        data.filters.scoring === "ppr" ? summary.totals.pointsPpr : summary.totals.pointsStandard,
        1,
      ),
      hint: `${number(
        data.filters.scoring === "ppr" ? summary.perGame.pointsPpr : summary.perGame.pointsStandard,
        1,
      )} per game`,
    },
    {
      label: "WOPR",
      value: number(summary.ratios.weightedOpportunityRating, 3),
      hint: `${rate(summary.ratios.airYardsShare)} air-yards share`,
    },
  ];
}

function metricRows(
  data: StatsCenterPlayerDetailResponse,
  family: StatsCenterMetricDescriptor["family"],
): readonly {
  readonly descriptor: StatsCenterMetricDescriptor;
  readonly total: number | null;
  readonly perGame: number | null;
  readonly isRatio: boolean;
}[] {
  const totals: Partial<Record<string, number | null>> = data.summary.totals;
  const perGame: Partial<Record<string, number | null>> = data.summary.perGame;
  const ratios: Partial<Record<string, number | null>> = data.summary.ratios;
  return data.metrics
    .filter((descriptor) => descriptor.family === family)
    .map((descriptor) => {
      const isRatio = descriptor.kind !== "additive";
      return {
        descriptor,
        total: isRatio ? (ratios[descriptor.id] ?? null) : (totals[descriptor.id] ?? null),
        perGame: isRatio ? null : (perGame[descriptor.id] ?? null),
        isRatio,
      };
    });
}

export function PlayerProfile({ playerId }: { readonly playerId: string }) {
  const [filters, setFilters] = useState<FilterState>({
    season: defaultSeason(),
    weekFrom: null,
    weekTo: null,
    scoring: "ppr",
  });
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (next: FilterState) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setView({ state: "loading" });
      const query = new URLSearchParams({
        season: String(next.season),
        scoring: next.scoring,
      });
      if (next.weekFrom !== null) query.set("weekFrom", String(next.weekFrom));
      if (next.weekTo !== null) query.set("weekTo", String(next.weekTo));
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/stats/players/${encodeURIComponent(playerId)}?${query.toString()}`,
          {
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (response.status === 404) {
          setView({ state: "missing" });
          return;
        }
        if (response.status === 401) {
          throw new Error("Sign in to browse player profiles.");
        }
        if (!response.ok) throw new Error("This player profile could not be loaded.");
        const parsed = parseStatsCenterPlayerDetail(await response.json());
        if (!parsed) throw new Error("The player profile response failed its data contract.");
        if (!controller.signal.aborted) setView({ state: "ready", data: parsed });
      } catch (error) {
        if (!controller.signal.aborted) {
          setView({
            state: "error",
            message:
              error instanceof Error ? error.message : "This player profile could not be loaded.",
          });
        }
      }
    },
    [playerId],
  );

  useEffect(() => {
    // Later reads are driven by the form, so the effect only performs the first load.
    void load({ season: defaultSeason(), weekFrom: null, weekTo: null, scoring: "ppr" });
    return () => requestRef.current?.abort();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(filters);
  }

  const seasons = Array.from({ length: 6 }, (_, index) => new Date().getFullYear() - index);

  return (
    <div className={styles.page}>
      <Link className={styles.back} href="/stats">
        <ArrowLeft size={15} aria-hidden="true" />
        Back to Stats Center
      </Link>

      {/* The heading renders before the fetch resolves; the player's name is filled in when it
          arrives. Gating the whole header on `ready` left the page with no h1 on first paint. */}
      <header className={styles.hero}>
        <div>
          <p>
            {view.state === "ready"
              ? `${view.data.player.position} · ${view.data.player.team ?? "Free agent"}${
                  view.data.player.status ? ` · ${view.data.player.status}` : ""
                }`
              : "Player profile"}
          </p>
          <h1>{view.state === "ready" ? view.data.player.name : "Loading player"}</h1>
          <span>
            {view.state === "ready" && view.data.player.rookieSeason
              ? `Rookie season ${String(view.data.player.rookieSeason)}. `
              : ""}
            Regular-season observations from the admitted weekly datasets.
          </span>
        </div>
        <UserRound size={34} strokeWidth={1.5} aria-hidden="true" />
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
          <span>From week</span>
          <select
            value={filters.weekFrom ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                weekFrom: event.target.value ? Number(event.target.value) : null,
              }))
            }
          >
            <option value="">Week 1</option>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>To week</span>
          <select
            value={filters.weekTo ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                weekTo: event.target.value ? Number(event.target.value) : null,
              }))
            }
          >
            <option value="">Latest</option>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Scoring</span>
          <select
            value={filters.scoring}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                scoring: event.target.value === "standard" ? "standard" : "ppr",
              }))
            }
          >
            <option value="ppr">Source PPR</option>
            <option value="standard">Source standard</option>
          </select>
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

      {view.state === "loading" ? (
        <div className={styles.stateCard} role="status">
          <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
          <div>
            <strong>Reading this player&apos;s admitted rows</strong>
            <span>Rebuilding the game log and window metrics.</span>
          </div>
        </div>
      ) : view.state === "missing" ? (
        <div className={styles.stateCard} role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div>
            <strong>No player matches this link</strong>
            <span>The identifier is valid but no player record carries it.</span>
          </div>
        </div>
      ) : view.state === "error" ? (
        <div className={styles.stateCard} role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div>
            <strong>This profile is unavailable</strong>
            <span>{view.message}</span>
          </div>
        </div>
      ) : (
        <ProfileBody data={view.data} />
      )}
    </div>
  );
}

function ProfileBody({ data }: { readonly data: StatsCenterPlayerDetailResponse }) {
  const { summary } = data;
  const trendEntries = [
    ["Opportunities per game", summary.trend.opportunitiesPerGame],
    ["Targets per game", summary.trend.targetsPerGame],
    ["Carries per game", summary.trend.carriesPerGame],
    ["Target share", summary.trend.targetShare],
    ["Snap share", summary.trend.offensiveSnapShare],
    ["Points", summary.trend.fantasyPoints],
  ] as const;

  return (
    <>
      <section className={styles.tiles} aria-label="Window summary">
        {summaryTiles(data).map((tile) => (
          <article key={tile.label}>
            <p>{tile.label}</p>
            <strong>{tile.value}</strong>
            <span>{tile.hint}</span>
          </article>
        ))}
      </section>

      <section className={styles.panel} aria-labelledby="game-log-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Week by week</p>
            <h2 id="game-log-title">Game log</h2>
          </div>
          <span>
            {data.gameLog.length} row{data.gameLog.length === 1 ? "" : "s"}
          </span>
        </div>
        {data.gameLog.length === 0 ? (
          <div className={styles.emptyState}>
            <CalendarOff size={22} aria-hidden="true" />
            <strong>No admitted rows cover this window</strong>
            <span>Try another season or a wider week range.</span>
          </div>
        ) : (
          <div
            className={`${styles.tableScroll} has-scroll-cue`}
            role="region"
            aria-label="Game log; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Week</th>
                  <th scope="col">Opp</th>
                  <th scope="col">TGT</th>
                  <th scope="col">TGT%</th>
                  <th scope="col">CAR</th>
                  <th scope="col">OPP</th>
                  <th scope="col">SNAP</th>
                  <th scope="col">SNAP%</th>
                  <th scope="col">PTS</th>
                </tr>
              </thead>
              <tbody>
                {data.gameLog.map((entry) => (
                  <tr
                    key={`${entry.week}-${entry.gameId ?? "bye"}`}
                    className={entry.bye ? styles.byeRow : undefined}
                  >
                    <th scope="row">
                      {entry.week}
                      {entry.bye ? <span className={styles.byeTag}>Bye</span> : null}
                    </th>
                    <td>{entry.bye ? "—" : (entry.opponentTeam ?? "—")}</td>
                    <td>{number(entry.targets)}</td>
                    <td>{rate(entry.targetShare)}</td>
                    <td>{number(entry.carries)}</td>
                    <td>{number(entry.opportunities)}</td>
                    <td>{number(entry.offensiveSnaps)}</td>
                    <td>{rate(entry.offensiveSnapShare)}</td>
                    <td>{number(entry.points, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.definition}>
          A bye row appears only where the admitted schedule affirms the team had no game that week.
          Weeks the schedule cannot vouch for are left out rather than guessed at.
        </p>
      </section>

      <section className={styles.panel} aria-labelledby="trend-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Recent form</p>
            <h2 id="trend-title">Trend</h2>
          </div>
          <span>
            Last {data.filters.recentWindow} weeks · {data.filters.recentWeightDecay} decay
          </span>
        </div>
        <div
          className={`${styles.tableScroll} has-scroll-cue`}
          role="region"
          aria-label="Recent form metrics; scroll horizontally to view all columns"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Window avg</th>
                <th scope="col">Recent avg</th>
                <th scope="col">Change</th>
                <th scope="col">Weeks</th>
              </tr>
            </thead>
            <tbody>
              {trendEntries.map(([label, trend]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{number(trend.seasonAverage, 2)}</td>
                  <td>{number(trend.recentWeightedAverage, 2)}</td>
                  <td>{signed(trend.absoluteChange, 2)}</td>
                  <td>
                    {trend.status === "available"
                      ? `${trend.recentSampleSize} / ${trend.sampleSize}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.definition}>{data.definitions.recentTrend}</p>
      </section>

      <section className={styles.panel} aria-labelledby="boom-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Distribution</p>
            <h2 id="boom-title">Boom and bust</h2>
          </div>
          {summary.boomBust.threshold ? (
            <span>
              Boom ≥ {summary.boomBust.threshold.boomAtOrAbove} · Bust ≤{" "}
              {summary.boomBust.threshold.bustAtOrBelow}
            </span>
          ) : null}
        </div>
        {summary.boomBust.status === "available" ? (
          <div className={styles.boomGrid}>
            <article>
              <p>Boom rate</p>
              <strong>{rate(summary.boomBust.boomRate)}</strong>
              <span>{number(summary.boomBust.booms)} games</span>
            </article>
            <article>
              <p>Bust rate</p>
              <strong>{rate(summary.boomBust.bustRate)}</strong>
              <span>{number(summary.boomBust.busts)} games</span>
            </article>
            <article>
              <p>Average points</p>
              <strong>{number(summary.boomBust.averagePoints, 1)}</strong>
              <span>±{number(summary.boomBust.standardDeviation, 1)} population sd</span>
            </article>
            <article>
              <p>Scored games</p>
              <strong>{number(summary.boomBust.games)}</strong>
              <span>{number(summary.boomBust.missingGames)} without points</span>
            </article>
          </div>
        ) : (
          <div className={styles.warning} role="status">
            <ShieldAlert size={18} aria-hidden="true" />
            <div>
              <strong>Boom and bust are withheld</strong>
              <span>{summary.boomBust.reason}</span>
            </div>
          </div>
        )}
        <p className={styles.definition}>{data.definitions.boomBust}</p>
      </section>

      {(["production", "efficiency"] as const).map((familyKey) => {
        const rows = metricRows(data, familyKey);
        if (rows.length === 0) return null;
        return (
          <section className={styles.panel} aria-labelledby={`${familyKey}-title`} key={familyKey}>
            <div className={styles.panelHeading}>
              <div>
                <p>{familyKey === "production" ? "Scored output" : "Derived efficiency"}</p>
                <h2 id={`${familyKey}-title`}>
                  {familyKey === "production" ? "Production" : "Efficiency"}
                </h2>
              </div>
            </div>
            <div
              className={`${styles.tableScroll} has-scroll-cue`}
              role="region"
              aria-label={`${familyKey === "production" ? "Production" : "Efficiency"} metrics; scroll horizontally to view all columns`}
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Window</th>
                    <th scope="col">Per game</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.descriptor.id}>
                      <th scope="row" title={row.descriptor.definition}>
                        {row.descriptor.label}
                      </th>
                      <td>{number(row.total, row.isRatio ? 3 : 1)}</td>
                      <td>{row.isRatio ? "—" : number(row.perGame, 1)}</td>
                      <td className={styles.metricState}>
                        {row.descriptor.state === "available" ? (
                          "available"
                        ) : (
                          <span title={row.descriptor.reason ?? undefined}>
                            {row.descriptor.state}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <section className={styles.panel} aria-labelledby="profile-source-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Audit trail</p>
            <h2 id="profile-source-title">Source health</h2>
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
                  <dt>Weeks covered</dt>
                  <dd>{weekCoverage(source.coveredWeeks)}</dd>
                </div>
              </dl>
              {source.reason ? <p>{source.reason}</p> : null}
              {source.attribution ? (
                source.attributionUrl ? (
                  <a href={source.attributionUrl} target="_blank" rel="noreferrer">
                    {source.attribution}
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                ) : (
                  <span>{source.attribution}</span>
                )
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
