"use client";

import type {
  ProjectionPlayerListResponse,
  ProjectionPlayerRow,
  ProjectionSetSummary,
} from "@laces-out/contracts";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  LoaderCircle,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl, parseProjectionPlayerList } from "../lib/api-client";
import styles from "./projection-player-browser.module.css";

type Horizon = "week" | "rest-of-season";
type DetailState =
  | { readonly state: "idle" | "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly detail: ProjectionPlayerListResponse };
type SortKey = "projection" | "floor" | "ceiling" | "name";

interface ProjectionPlayerBrowserProps {
  readonly leagueSeasonId: string;
  readonly leagueName: string;
  readonly currentWeek: number | null;
  readonly projectionSets: readonly ProjectionSetSummary[];
  readonly listState: "loading" | "ready" | "error";
  readonly listError?: string | undefined;
  /** Tour mode. The board is the most number-dense surface in the app; without a
      marker of its own a visitor reads fabricated rows as their league's data. */
  readonly sample?: boolean;
  /** A newer managed run was withheld. The panel above hides its forecast in that
      case; without this the board went on serving the older published set with no
      hint the two surfaces were describing different things. */
  readonly withheldNewerRun?: boolean;
}

const SAMPLE_CHECKSUM = `sha256:${"7".repeat(64)}`;
const SAMPLE_WEEKLY_ID = "70000000-0000-4000-8000-000000000001";
const SAMPLE_ROS_ID = "70000000-0000-4000-8000-000000000002";
const SAMPLE_SEASON_ID = "70000000-0000-4000-8000-000000000003";

function sampleManaged(computedAt: string) {
  return {
    modelVersion: "first-party-v1",
    computedAt,
    inputCheckedAt: "2026-10-08T18:40:00.000Z",
    trainingCutoff: { season: 2026, week: 5 },
    statsThrough: { season: 2026, week: 5 },
    qualityState: "publishable" as const,
    championByPosition: [],
    coverage: { projected: 213, eligible: 214, ratio: 213 / 214 },
    warnings: [],
    backtest: {
      samples: 1_840,
      mae: 4.18,
      baselineMae: 4.62,
      intervalCoverage: 0.79,
    },
  };
}

const SAMPLE_WEEKLY_SET: ProjectionSetSummary = {
  id: SAMPLE_WEEKLY_ID,
  leagueSeasonId: SAMPLE_SEASON_ID,
  creatorUserId: null,
  creatorDisplayName: null,
  origin: "laces-out",
  managed: sampleManaged("2026-10-08T18:43:00.000Z"),
  visibility: "league",
  sourceLabel: "Laces Out Week 6 forecast",
  sourceFileName: null,
  season: 2026,
  week: 6,
  horizon: "week",
  playerCount: 213,
  inputChecksum: SAMPLE_CHECKSUM,
  sourceChecksum: SAMPLE_CHECKSUM,
  sourceObservedAt: "2026-10-08T18:40:00.000Z",
  sourceObservedAtStatus: "verified",
  importedAt: "2026-10-08T18:43:00.000Z",
  isOwnedByCurrentUser: false,
};

const SAMPLE_ROS_SET: ProjectionSetSummary = {
  ...SAMPLE_WEEKLY_SET,
  id: SAMPLE_ROS_ID,
  managed: sampleManaged("2026-10-08T18:46:00.000Z"),
  sourceLabel: "Laces Out rest-of-season forecast",
  week: null,
  horizon: "rest-of-season",
  playerCount: 210,
  importedAt: "2026-10-08T18:46:00.000Z",
};

function samplePlayer(
  input: Omit<
    ProjectionPlayerRow,
    "playerId" | "eligiblePositions" | "status" | "confidence" | "ros"
  > & {
    readonly ordinal: number;
    readonly confidence?: number | null;
    readonly ros?: ProjectionPlayerRow["ros"];
  },
): ProjectionPlayerRow {
  return {
    playerId: `71000000-0000-4000-8000-${String(input.ordinal).padStart(12, "0")}`,
    fullName: input.fullName,
    nflTeam: input.nflTeam,
    primaryPosition: input.primaryPosition,
    eligiblePositions: [input.primaryPosition],
    status: null,
    overallRank: input.overallRank,
    positionRank: input.positionRank,
    meanPoints: input.meanPoints,
    floorPoints: input.floorPoints,
    ceilingPoints: input.ceilingPoints,
    confidence: input.confidence ?? null,
    ros: input.ros ?? null,
  };
}

const SAMPLE_WEEKLY_PLAYERS: readonly ProjectionPlayerRow[] = [
  samplePlayer({
    ordinal: 1,
    fullName: "Ja'Marr Chase",
    nflTeam: "CIN",
    primaryPosition: "WR",
    overallRank: 1,
    positionRank: 1,
    meanPoints: 22.8,
    floorPoints: 14.2,
    ceilingPoints: 33.1,
    confidence: 0.84,
  }),
  samplePlayer({
    ordinal: 2,
    fullName: "Bijan Robinson",
    nflTeam: "ATL",
    primaryPosition: "RB",
    overallRank: 2,
    positionRank: 1,
    meanPoints: 21.4,
    floorPoints: 13.7,
    ceilingPoints: 30.2,
    confidence: 0.81,
  }),
  samplePlayer({
    ordinal: 3,
    fullName: "Josh Allen",
    nflTeam: "BUF",
    primaryPosition: "QB",
    overallRank: 3,
    positionRank: 1,
    meanPoints: 20.9,
    floorPoints: 15.1,
    ceilingPoints: 29.6,
    confidence: 0.87,
  }),
  samplePlayer({
    ordinal: 4,
    fullName: "Amon-Ra St. Brown",
    nflTeam: "DET",
    primaryPosition: "WR",
    overallRank: 4,
    positionRank: 2,
    meanPoints: 19.7,
    floorPoints: 13.9,
    ceilingPoints: 27.4,
    confidence: 0.86,
  }),
  samplePlayer({
    ordinal: 5,
    fullName: "Trey McBride",
    nflTeam: "ARI",
    primaryPosition: "TE",
    overallRank: 5,
    positionRank: 1,
    meanPoints: 17.2,
    floorPoints: 11.4,
    ceilingPoints: 24.8,
    confidence: 0.82,
  }),
];

function sampleRos(
  ordinal: number,
  fullName: string,
  nflTeam: string,
  primaryPosition: string,
  overallRank: number,
  positionRank: number,
  meanPoints: number,
  floorPoints: number,
  ceilingPoints: number,
  expectedGames: number,
): ProjectionPlayerRow {
  return samplePlayer({
    ordinal,
    fullName,
    nflTeam,
    primaryPosition,
    overallRank,
    positionRank,
    meanPoints,
    floorPoints,
    ceilingPoints,
    ros: {
      windowStartWeek: 7,
      windowEndWeek: 17,
      asOfWeek: 6,
      asOfAt: "2026-10-08T18:46:00.000Z",
      scheduledGames: 11,
      expectedGames,
      medianPoints: Math.round(meanPoints * 0.98 * 10) / 10,
      meanPointsPerExpectedGame: Math.round((meanPoints / expectedGames) * 10) / 10,
      pointsStddev: Math.round((ceilingPoints - floorPoints) * 0.32 * 10) / 10,
    },
  });
}

const SAMPLE_ROS_PLAYERS: readonly ProjectionPlayerRow[] = [
  sampleRos(11, "Ja'Marr Chase", "CIN", "WR", 1, 1, 241.6, 182.8, 300.9, 10.7),
  sampleRos(12, "Bijan Robinson", "ATL", "RB", 2, 1, 228.3, 171.2, 284.7, 10.8),
  sampleRos(13, "Amon-Ra St. Brown", "DET", "WR", 3, 2, 219.8, 172.5, 269.4, 10.9),
  sampleRos(14, "Josh Allen", "BUF", "QB", 4, 1, 217.4, 176.1, 261.8, 10.8),
  sampleRos(15, "Trey McBride", "ARI", "TE", 5, 1, 178.2, 133.6, 223.9, 10.6),
];

const SAMPLE_DETAILS: Readonly<Record<string, ProjectionPlayerListResponse>> = {
  [SAMPLE_WEEKLY_ID]: {
    projectionSet: SAMPLE_WEEKLY_SET,
    players: [...SAMPLE_WEEKLY_PLAYERS],
  },
  [SAMPLE_ROS_ID]: {
    projectionSet: SAMPLE_ROS_SET,
    players: [...SAMPLE_ROS_PLAYERS],
  },
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly detail?: unknown; readonly title?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.title === "string") return body.title;
  } catch {
    // Fall through to the status-aware message.
  }
  return `Projection rows could not be loaded (${response.status})`;
}

function readableDate(value: string | null): string {
  if (!value) return "Source time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function points(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function setLabel(set: ProjectionSetSummary): string {
  const window = set.horizon === "week" ? `Week ${set.week ?? "—"}` : "Rest of season";
  const owner =
    set.origin === "laces-out"
      ? "Laces Out"
      : set.isOwnedByCurrentUser
        ? "My set"
        : (set.creatorDisplayName ?? "League set");
  return `${window} · ${owner} · ${set.sourceLabel}`;
}

/** Which timestamp the context line is actually showing. */
function timestampLabel(set: ProjectionSetSummary | undefined): string {
  if (!set) return "";
  if (set.origin === "laces-out" && set.managed) return "inputs checked";
  if (set.sourceObservedAt) return "source as of";
  return "imported";
}

function preferredSet(
  sets: readonly ProjectionSetSummary[],
  horizon: Horizon,
  currentWeek: number | null,
): ProjectionSetSummary | undefined {
  const candidates = sets.filter((set) => set.horizon === horizon);
  if (horizon === "week") {
    return (
      candidates.find(
        (set) => set.origin === "laces-out" && currentWeek !== null && set.week === currentWeek,
      ) ??
      candidates.find((set) => set.origin === "laces-out") ??
      candidates[0]
    );
  }
  return candidates.find((set) => set.origin === "laces-out") ?? candidates[0];
}

function ProjectionBoard({
  leagueSeasonId,
  leagueName,
  currentWeek,
  projectionSets,
  listState,
  listError,
  sample = false,
  withheldNewerRun = false,
  sampleDetails,
}: ProjectionPlayerBrowserProps & {
  readonly sampleDetails?: Readonly<Record<string, ProjectionPlayerListResponse>>;
}) {
  const [horizon, setHorizon] = useState<Horizon>("week");
  const [selectedSetId, setSelectedSetId] = useState("");
  const [detail, setDetail] = useState<DetailState>({ state: "idle" });
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState("ALL");
  const [sort, setSort] = useState<SortKey>("projection");
  const abortRef = useRef<AbortController | null>(null);
  const candidateSets = useMemo(
    () => projectionSets.filter((set) => set.horizon === horizon),
    [horizon, projectionSets],
  );
  const activeSet =
    candidateSets.find((set) => set.id === selectedSetId) ??
    preferredSet(projectionSets, horizon, currentWeek);

  useEffect(() => {
    abortRef.current?.abort();
    // Drop the outgoing set's rows immediately. Without this the previous
    // horizon's numbers render under the new horizon's column labels
    // (Projected/Floor/Ceiling vs ROS Total/P15/P85) until the fetch lands.
    setDetail({ state: "loading" });
    if (!activeSet) {
      setDetail({ state: "idle" });
      return;
    }
    if (sampleDetails) {
      const sample = sampleDetails[activeSet.id];
      setDetail(
        sample
          ? { state: "ready", detail: sample }
          : { state: "error", message: "Sample projection rows are unavailable." },
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setDetail({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/league-seasons/${encodeURIComponent(leagueSeasonId)}/projections/${encodeURIComponent(activeSet.id)}/players`,
          {
            credentials: "include",
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (abortRef.current !== controller) return;
        if (!response.ok) throw new Error(await responseMessage(response));
        const parsed = parseProjectionPlayerList(await response.json());
        if (!parsed || parsed.projectionSet.id !== activeSet.id) {
          throw new Error("Projection rows did not match the selected set.");
        }
        setDetail({ state: "ready", detail: parsed });
      } catch (error) {
        if (isAbortError(error) || abortRef.current !== controller) return;
        setDetail({
          state: "error",
          message: error instanceof Error ? error.message : "Projection rows could not be loaded.",
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();
    return () => controller.abort();
  }, [activeSet, leagueSeasonId, sampleDetails]);

  const players = detail.state === "ready" ? detail.detail.players : [];
  const positions = useMemo(
    () =>
      [...new Set(players.map((player) => player.primaryPosition))].sort((left, right) =>
        left.localeCompare(right),
      ),
    [players],
  );
  /* Deferred so each keystroke repaints the input immediately and the
     full-set filter/sort catches up off the urgent path. */
  const deferredQuery = useDeferredValue(query);
  const visiblePlayers = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("en-US");
    return players
      .filter(
        (player) =>
          (position === "ALL" || player.primaryPosition === position) &&
          (normalizedQuery.length === 0 ||
            player.fullName.toLocaleLowerCase("en-US").includes(normalizedQuery) ||
            player.nflTeam?.toLocaleLowerCase("en-US").includes(normalizedQuery)),
      )
      .sort((left, right) => {
        if (sort === "name") return left.fullName.localeCompare(right.fullName);
        const leftValue =
          sort === "floor"
            ? left.floorPoints
            : sort === "ceiling"
              ? left.ceilingPoints
              : left.meanPoints;
        const rightValue =
          sort === "floor"
            ? right.floorPoints
            : sort === "ceiling"
              ? right.ceilingPoints
              : right.meanPoints;
        return (rightValue ?? Number.NEGATIVE_INFINITY) - (leftValue ?? Number.NEGATIVE_INFINITY);
      });
  }, [players, position, deferredQuery, sort]);

  /* The grid renders every match; on a full projection set that is the whole
     admitted pool. 200 rows is more than a screen can use — the search and
     position filters are the way to reach the tail. */
  const renderedPlayers = useMemo(() => visiblePlayers.slice(0, 200), [visiblePlayers]);

  const resolvedSet = detail.state === "ready" ? detail.detail.projectionSet : activeSet;
  const rosWindow = horizon === "rest-of-season" ? players.find((player) => player.ros)?.ros : null;

  return (
    <section
      className={styles.board}
      id="player-projections"
      aria-labelledby="projection-board-title"
    >
      <header className={styles.header}>
        <div>
          <h2 id="projection-board-title">Player projections</h2>
        </div>
        <span className={styles.headerBadges}>
          {sample ? <span className={styles.sampleBadge}>Tour preview</span> : null}
          <span className={styles.scope}>
            <ShieldCheck size={14} aria-hidden="true" />
            {leagueName}
          </span>
        </span>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.tabs} aria-label="Projection window">
          <button
            type="button"
            className={horizon === "week" ? styles.activeTab : undefined}
            aria-pressed={horizon === "week"}
            onClick={() => {
              setHorizon("week");
              setSelectedSetId("");
            }}
          >
            Weekly
            {listState === "ready" ? (
              <span>{projectionSets.filter((set) => set.horizon === "week").length}</span>
            ) : null}
          </button>
          <button
            type="button"
            className={horizon === "rest-of-season" ? styles.activeTab : undefined}
            aria-pressed={horizon === "rest-of-season"}
            onClick={() => {
              setHorizon("rest-of-season");
              setSelectedSetId("");
            }}
          >
            Rest of Season
            {listState === "ready" ? (
              <span>{projectionSets.filter((set) => set.horizon === "rest-of-season").length}</span>
            ) : null}
          </button>
        </div>

        {candidateSets.length > 0 ? (
          <label className={styles.setControl}>
            <span>Projection set</span>
            <select
              value={activeSet?.id ?? ""}
              onChange={(event) => setSelectedSetId(event.target.value)}
            >
              {candidateSets.map((set) => (
                <option key={set.id} value={set.id}>
                  {setLabel(set)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {listState === "loading" ? (
        <div className={styles.state} role="status">
          <LoaderCircle className={styles.spin} size={19} aria-hidden="true" />
          Loading published projection sets…
        </div>
      ) : listState === "error" ? (
        <div className={styles.state} role="alert">
          <AlertTriangle size={19} aria-hidden="true" />
          {listError ?? "Published projection sets could not be loaded."}
        </div>
      ) : !activeSet ? (
        <div className={styles.empty}>
          <BarChart3 size={21} aria-hidden="true" />
          <div>
            <strong>No {horizon === "week" ? "weekly" : "rest-of-season"} forecast yet.</strong>
          </div>
        </div>
      ) : detail.state === "loading" || detail.state === "idle" ? (
        <div className={styles.state} role="status">
          <LoaderCircle className={styles.spin} size={19} aria-hidden="true" />
          Loading player projections…
        </div>
      ) : detail.state === "error" ? (
        <div className={styles.state} role="alert">
          <AlertTriangle size={19} aria-hidden="true" />
          {detail.message}
        </div>
      ) : (
        <>
          {withheldNewerRun && horizon === "week" && resolvedSet?.origin === "laces-out" ? (
            <div className={styles.withheldNotice} role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>A newer run was withheld. Showing the last passing set.</span>
            </div>
          ) : null}

          <div className={styles.context}>
            <div>
              {resolvedSet?.origin === "custom" &&
              resolvedSet.sourceObservedAtStatus === "unverified" ? (
                <AlertTriangle size={16} aria-hidden="true" />
              ) : (
                <CheckCircle2 size={16} aria-hidden="true" />
              )}
              <span>
                <strong>{resolvedSet?.sourceLabel}</strong>
                {horizon === "week"
                  ? `Week ${resolvedSet?.week ?? "—"} · ${resolvedSet?.season}`
                  : rosWindow
                    ? `Weeks ${rosWindow.windowStartWeek}–${rosWindow.windowEndWeek} · as of Week ${rosWindow.asOfWeek}`
                    : `Rest of season · ${resolvedSet?.season}`}
              </span>
            </div>
            {/* The timestamp's meaning changes with the set's origin, and a custom
                set can carry an unverified source time. Say which is being shown
                rather than printing a bare date under a green check. */}
            <span>
              {players.length.toLocaleString()} players · {timestampLabel(resolvedSet)}{" "}
              {readableDate(
                resolvedSet?.managed?.inputCheckedAt ??
                  resolvedSet?.sourceObservedAt ??
                  resolvedSet?.importedAt ??
                  null,
              )}
              {resolvedSet?.origin === "custom" &&
              resolvedSet.sourceObservedAtStatus === "unverified" ? (
                <small className={styles.unverified}>Unverified source time</small>
              ) : null}
            </span>
          </div>

          <div className={styles.filters}>
            <label className={styles.search}>
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">Search players</span>
              <input
                type="search"
                value={query}
                placeholder="Search player or team"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              <span className="sr-only">Filter by position</span>
              <select value={position} onChange={(event) => setPosition(event.target.value)}>
                <option value="ALL">All positions</option>
                {positions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Sort projections</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                <option value="projection">Highest projection</option>
                <option value="floor">Highest floor</option>
                <option value="ceiling">Highest ceiling</option>
                <option value="name">Player name</option>
              </select>
            </label>
          </div>

          <div
            className={`${styles.table} has-scroll-cue`}
            role="table"
            aria-label="Player projections"
          >
            <div className={styles.tableHeader} role="row">
              <span role="columnheader" title="Overall rank within this projection set">
                Ovr
              </span>
              <span role="columnheader">Player</span>
              <span role="columnheader">Pos.</span>
              <div className={styles.metricHeaders}>
                <span role="columnheader">{horizon === "week" ? "Projected" : "ROS Total"}</span>
                <span role="columnheader">{horizon === "week" ? "Floor" : "P15"}</span>
                <span role="columnheader">{horizon === "week" ? "Ceiling" : "P85"}</span>
                <span role="columnheader">
                  {horizon === "week" ? "Confidence" : "Expected Games"}
                </span>
              </div>
            </div>

            {visiblePlayers.length > 0 ? (
              renderedPlayers.map((player) => (
                <div className={styles.playerRow} role="row" key={player.playerId}>
                  <span className={styles.rank} role="cell">
                    {player.overallRank}
                  </span>
                  <div className={styles.identity} role="cell">
                    <strong>{player.fullName}</strong>
                    <span>
                      {player.nflTeam ?? "FA"} · {player.primaryPosition}
                      {player.positionRank}
                      {player.status ? ` · ${player.status}` : ""}
                    </span>
                  </div>
                  <span className={styles.position} role="cell">
                    {player.primaryPosition}
                  </span>
                  <div className={styles.rowMetrics}>
                    <div className={styles.primaryMetric} role="cell">
                      <span>{horizon === "week" ? "Projected" : "ROS Total"}</span>
                      <strong>{points(player.meanPoints)}</strong>
                      {horizon === "rest-of-season" &&
                      player.ros?.meanPointsPerExpectedGame !== null &&
                      player.ros?.meanPointsPerExpectedGame !== undefined ? (
                        <small>{points(player.ros.meanPointsPerExpectedGame)} / game</small>
                      ) : null}
                    </div>
                    <div role="cell">
                      <span>{horizon === "week" ? "Floor" : "P15"}</span>
                      <strong>{points(player.floorPoints)}</strong>
                    </div>
                    <div role="cell">
                      <span>{horizon === "week" ? "Ceiling" : "P85"}</span>
                      <strong>{points(player.ceilingPoints)}</strong>
                    </div>
                    <div role="cell">
                      <span>{horizon === "week" ? "Confidence" : "Expected Games"}</span>
                      <strong>
                        {horizon === "week"
                          ? player.confidence === null
                            ? "—"
                            : `${Math.round(player.confidence * 100)}%`
                          : points(player.ros?.expectedGames ?? null)}
                      </strong>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className={styles.noMatches}>No players match those filters.</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function ProjectionPlayerBrowser(props: ProjectionPlayerBrowserProps) {
  return <ProjectionBoard {...props} />;
}

export function ProjectionPlayerTour() {
  return (
    <ProjectionBoard
      leagueSeasonId={SAMPLE_SEASON_ID}
      leagueName="North Loop Auction"
      currentWeek={6}
      projectionSets={[SAMPLE_WEEKLY_SET, SAMPLE_ROS_SET]}
      listState="ready"
      sample
      sampleDetails={SAMPLE_DETAILS}
    />
  );
}
