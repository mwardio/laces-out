import type {
  StatsCenterAdditiveMetric,
  StatsCenterBoomBust,
  StatsCenterGameLogEntry,
  StatsCenterMetricDescriptor,
  StatsCenterPlayerDetailResponse,
  StatsCenterRatioMetric,
  StatsCenterResponse,
  StatsCenterScoring,
  StatsCenterSort,
  StatsCenterSource,
  StatsCenterTrend,
  StatsCenterTrendMetric,
} from "@fantasy/contracts";
import {
  playerSnapCountObservations,
  playerWeeklyStatObservations,
  players,
  type Database,
} from "@fantasy/db";
import {
  derivePlayerOpportunityMetrics,
  type BoomBustSummary,
  type DerivedNumericMetric,
  type OpportunityTrendMetric,
  type PlayerOpportunityMetrics,
  type WeeklyPlayerSnapObservation,
  type WeeklyPlayerStatObservation,
} from "@fantasy/league-analytics";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import {
  admittedSourceContract,
  selectAdmittedSource,
  type AdmittedSourceRow,
} from "./admitted-source.js";
import {
  STATS_CENTER_ADDITIVE_METRIC_IDS,
  STATS_CENTER_METRIC_DESCRIPTORS,
  STATS_CENTER_RATIO_METRIC_IDS,
  aggregateStatsCenterMetrics,
  buildTeamAirYardsByGame,
  describeStatsCenterMetricAvailability,
  type StatsCenterMetricRow,
} from "./stats-center-metrics.js";

const DATASET_ROW_LIMIT = 60_001;
const POSITION_PATTERN = /^[A-Z0-9/+.-]{1,20}$/u;
const TEAM_PATTERN = /^[A-Z]{2,4}$/u;

/**
 * Boom and bust thresholds are declared constants, not derived from the data, and they are
 * applied to the source dataset's own standard or PPR points rather than any league's rules.
 * The response repeats that caveat so a reader never mistakes these for league-scored games.
 */
const BOOM_BUST_THRESHOLDS: Readonly<
  Record<
    StatsCenterScoring,
    Readonly<Record<string, { boomAtOrAbove: number; bustAtOrBelow: number }>>
  >
> = {
  ppr: {
    QB: { boomAtOrAbove: 25, bustAtOrBelow: 15 },
    RB: { boomAtOrAbove: 20, bustAtOrBelow: 8 },
    WR: { boomAtOrAbove: 20, bustAtOrBelow: 8 },
    TE: { boomAtOrAbove: 15, bustAtOrBelow: 5 },
    K: { boomAtOrAbove: 12, bustAtOrBelow: 5 },
  },
  standard: {
    QB: { boomAtOrAbove: 24, bustAtOrBelow: 14 },
    RB: { boomAtOrAbove: 18, bustAtOrBelow: 6 },
    WR: { boomAtOrAbove: 16, bustAtOrBelow: 5 },
    TE: { boomAtOrAbove: 12, bustAtOrBelow: 3 },
    K: { boomAtOrAbove: 12, bustAtOrBelow: 5 },
  },
};

/**
 * Stated outright rather than appended to the analytics package's definition, which describes
 * *league-scored* thresholds. Composing the two produced a sentence that claimed league scoring
 * and disclaimed it in the same breath.
 */
function boomBustDefinition(scoring: StatsCenterScoring): string {
  const label = scoring === "ppr" ? "PPR" : "standard";
  return (
    `Boom and bust classify each game against documented, position-specific thresholds applied ` +
    `to the source dataset's own ${label} points. Those points are the upstream dataset's scoring, ` +
    `not any league's rules, so the rates do not describe what a player scored in your league. ` +
    `Games without a stored point total are excluded and disclosed.`
  );
}

/**
 * The slice of a season a read covers. Narrowing this is what keeps the row bound distant.
 * `teams` is a set rather than one team because a single player's window has to cover every
 * team he appeared for, and each of those team-games needs its full roster of rows for the
 * share denominators to stay honest.
 */
export interface StatsCenterWindow {
  readonly season: number;
  readonly weekFrom: number | null;
  readonly weekTo: number | null;
  readonly teams: readonly string[] | null;
}

export interface StatsCenterQuery {
  readonly season: number;
  readonly weekFrom: number | null;
  readonly weekTo: number | null;
  readonly team: string | null;
  readonly position: string | null;
  readonly search: string;
  readonly sort: StatsCenterSort;
  readonly scoring: StatsCenterScoring;
  readonly recentWindow: number;
  readonly recentWeightDecay: number;
  readonly limit: number;
}

export type StatsCenterSourceRow = AdmittedSourceRow;

export interface StatsCenterWeeklyRow {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly playerName: string | null;
  readonly position: string | null;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: Record<string, number>;
  readonly advanced: Record<string, number | null>;
  readonly sourceFantasyPoints: Record<string, number>;
}

export interface StatsCenterSnapRow {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly playerName: string | null;
  readonly position: string | null;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly offenseSnaps: number;
  readonly offenseShare: string;
}

export interface StatsCenterPlayerIdentity {
  readonly playerId: string;
  readonly fullName: string;
  readonly primaryPosition: string;
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly rookieSeason: number | null;
}

export interface StatsCenterRepository {
  findSource(key: string): Promise<StatsCenterSourceRow | undefined>;
  listWeeklyStats(
    sourceId: string,
    checksum: string,
    window: StatsCenterWindow,
    limit: number,
  ): Promise<readonly StatsCenterWeeklyRow[]>;
  listSnapCounts(
    sourceId: string,
    checksum: string,
    window: StatsCenterWindow,
    limit: number,
  ): Promise<readonly StatsCenterSnapRow[]>;
  findPlayer(playerId: string): Promise<StatsCenterPlayerIdentity | undefined>;
  /** The teams a player appeared for in the window, which scopes the follow-up read. */
  listPlayerTeams(
    sourceId: string,
    checksum: string,
    playerId: string,
    window: StatsCenterWindow,
  ): Promise<readonly string[]>;
}

export class DrizzleStatsCenterRepository implements StatsCenterRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  findSource(key: string): Promise<StatsCenterSourceRow | undefined> {
    return selectAdmittedSource(this.#database, key);
  }

  async listWeeklyStats(
    sourceId: string,
    checksum: string,
    window: StatsCenterWindow,
    limit: number,
  ): Promise<readonly StatsCenterWeeklyRow[]> {
    return this.#database
      .select({
        externalPlayerId: playerWeeklyStatObservations.externalPlayerId,
        playerId: playerWeeklyStatObservations.playerId,
        playerName: players.fullName,
        position: players.primaryPosition,
        season: playerWeeklyStatObservations.season,
        week: playerWeeklyStatObservations.week,
        gameId: playerWeeklyStatObservations.gameId,
        team: playerWeeklyStatObservations.team,
        opponentTeam: playerWeeklyStatObservations.opponentTeam,
        components: playerWeeklyStatObservations.components,
        advanced: playerWeeklyStatObservations.advanced,
        sourceFantasyPoints: playerWeeklyStatObservations.sourceFantasyPoints,
      })
      .from(playerWeeklyStatObservations)
      .leftJoin(players, eq(playerWeeklyStatObservations.playerId, players.id))
      .where(
        and(
          eq(playerWeeklyStatObservations.sourceId, sourceId),
          eq(playerWeeklyStatObservations.inputChecksum, checksum),
          eq(playerWeeklyStatObservations.season, window.season),
          eq(playerWeeklyStatObservations.seasonType, "REG"),
          ...(window.weekFrom === null
            ? []
            : [gte(playerWeeklyStatObservations.week, window.weekFrom)]),
          ...(window.weekTo === null
            ? []
            : [lte(playerWeeklyStatObservations.week, window.weekTo)]),
          ...(window.teams === null
            ? []
            : [inArray(playerWeeklyStatObservations.team, [...window.teams])]),
        ),
      )
      .orderBy(
        asc(playerWeeklyStatObservations.week),
        asc(playerWeeklyStatObservations.gameId),
        asc(playerWeeklyStatObservations.externalPlayerId),
      )
      .limit(limit);
  }

  async listSnapCounts(
    sourceId: string,
    checksum: string,
    window: StatsCenterWindow,
    limit: number,
  ): Promise<readonly StatsCenterSnapRow[]> {
    return this.#database
      .select({
        externalPlayerId: playerSnapCountObservations.externalPlayerId,
        playerId: playerSnapCountObservations.playerId,
        playerName: players.fullName,
        position: players.primaryPosition,
        season: playerSnapCountObservations.season,
        week: playerSnapCountObservations.week,
        gameId: playerSnapCountObservations.gameId,
        team: playerSnapCountObservations.team,
        opponentTeam: playerSnapCountObservations.opponentTeam,
        offenseSnaps: playerSnapCountObservations.offenseSnaps,
        offenseShare: playerSnapCountObservations.offenseShare,
      })
      .from(playerSnapCountObservations)
      .leftJoin(players, eq(playerSnapCountObservations.playerId, players.id))
      .where(
        and(
          eq(playerSnapCountObservations.sourceId, sourceId),
          eq(playerSnapCountObservations.inputChecksum, checksum),
          eq(playerSnapCountObservations.season, window.season),
          eq(playerSnapCountObservations.seasonType, "REG"),
          ...(window.weekFrom === null
            ? []
            : [gte(playerSnapCountObservations.week, window.weekFrom)]),
          ...(window.weekTo === null ? [] : [lte(playerSnapCountObservations.week, window.weekTo)]),
          ...(window.teams === null
            ? []
            : [inArray(playerSnapCountObservations.team, [...window.teams])]),
        ),
      )
      .orderBy(
        asc(playerSnapCountObservations.week),
        asc(playerSnapCountObservations.gameId),
        asc(playerSnapCountObservations.externalPlayerId),
      )
      .limit(limit);
  }

  async findPlayer(playerId: string): Promise<StatsCenterPlayerIdentity | undefined> {
    const [row] = await this.#database
      .select({
        playerId: players.id,
        fullName: players.fullName,
        primaryPosition: players.primaryPosition,
        nflTeam: players.nflTeam,
        status: players.status,
        rookieSeason: players.rookieSeason,
      })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    return row;
  }

  async listPlayerTeams(
    sourceId: string,
    checksum: string,
    playerId: string,
    window: StatsCenterWindow,
  ): Promise<readonly string[]> {
    const rows = await this.#database
      .selectDistinct({ team: playerWeeklyStatObservations.team })
      .from(playerWeeklyStatObservations)
      .where(
        and(
          eq(playerWeeklyStatObservations.sourceId, sourceId),
          eq(playerWeeklyStatObservations.inputChecksum, checksum),
          eq(playerWeeklyStatObservations.season, window.season),
          eq(playerWeeklyStatObservations.seasonType, "REG"),
          eq(playerWeeklyStatObservations.playerId, playerId),
          ...(window.weekFrom === null
            ? []
            : [gte(playerWeeklyStatObservations.week, window.weekFrom)]),
          ...(window.weekTo === null
            ? []
            : [lte(playerWeeklyStatObservations.week, window.weekTo)]),
        ),
      );
    return rows.map((row) => row.team);
  }
}

function sourceContract(
  dataset: StatsCenterSource["dataset"],
  key: string,
  source: StatsCenterSourceRow | undefined,
): StatsCenterSource {
  return admittedSourceContract(
    dataset,
    key,
    dataset === "weekly-stats" ? "Weekly player stats" : "Snap counts",
    source,
  );
}

function nonnegativeIntegerComponent(
  components: Record<string, number>,
  key: "targets" | "carries",
): number {
  const value = components[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Stored weekly stat component ${key} is invalid`);
  }
  return value;
}

function metricNumber(metric: {
  readonly status: "available" | "unavailable";
  readonly value: number | null;
}): number | null {
  return metric.status === "available" ? metric.value : null;
}

function availability(state: "available" | "unavailable" | "no-data", reason: string | null) {
  return { state, reason } as const;
}

function trendContract(metric: OpportunityTrendMetric): StatsCenterTrend {
  return {
    status: metric.status,
    seasonAverage: metric.seasonAverage,
    recentWeightedAverage: metric.recentWeightedAverage,
    absoluteChange: metric.absoluteChange,
    sampleSize: metric.sampleSize,
    recentSampleSize: metric.recentSampleSize,
    reason: metric.reason,
  };
}

function boomBustContract(
  summary: BoomBustSummary,
  threshold: { readonly boomAtOrAbove: number; readonly bustAtOrBelow: number } | null,
): StatsCenterBoomBust {
  if (summary.status === "unavailable") {
    return {
      status: "unavailable",
      games: summary.games,
      missingGames: summary.missingGames,
      booms: null,
      busts: null,
      neutral: null,
      boomRate: null,
      bustRate: null,
      averagePoints: null,
      standardDeviation: null,
      threshold,
      reason: summary.reason,
    };
  }
  return {
    status: "available",
    games: summary.games,
    missingGames: summary.missingGames,
    booms: summary.booms,
    busts: summary.busts,
    neutral: summary.neutral,
    boomRate: summary.boomRate,
    bustRate: summary.bustRate,
    averagePoints: summary.averagePoints,
    standardDeviation: summary.populationStandardDeviation,
    threshold,
    reason: null,
  };
}

function trendRecord(
  metrics: PlayerOpportunityMetrics["recentTrend"],
): Record<StatsCenterTrendMetric, StatsCenterTrend> {
  return {
    targetsPerGame: trendContract(metrics.targetsPerGame),
    carriesPerGame: trendContract(metrics.carriesPerGame),
    opportunitiesPerGame: trendContract(metrics.opportunitiesPerGame),
    targetShare: trendContract(metrics.targetShare),
    offensiveSnapShare: trendContract(metrics.offenseSnapShare),
    fantasyPoints: trendContract(metrics.fantasyPoints),
  };
}

function metricValueRecords(aggregated: {
  readonly totals: Readonly<Record<string, DerivedNumericMetric>>;
  readonly perGame: Readonly<Record<string, DerivedNumericMetric>>;
  readonly ratios: Readonly<Record<string, DerivedNumericMetric>>;
}): {
  readonly totals: Record<StatsCenterAdditiveMetric, number | null>;
  readonly perGame: Record<StatsCenterAdditiveMetric, number | null>;
  readonly ratios: Record<StatsCenterRatioMetric, number | null>;
} {
  const totals = {} as Record<StatsCenterAdditiveMetric, number | null>;
  const perGame = {} as Record<StatsCenterAdditiveMetric, number | null>;
  for (const id of STATS_CENTER_ADDITIVE_METRIC_IDS) {
    totals[id] = metricNumber(aggregated.totals[id]!);
    perGame[id] = metricNumber(aggregated.perGame[id]!);
  }
  const ratios = {} as Record<StatsCenterRatioMetric, number | null>;
  for (const id of STATS_CENTER_RATIO_METRIC_IDS) {
    ratios[id] = metricNumber(aggregated.ratios[id]!);
  }
  return { totals, perGame, ratios };
}

export interface StatsCenterPlayerRow {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string | null;
  readonly games: number;
  readonly snapGames: number;
  readonly targets: number | null;
  readonly carries: number | null;
  readonly opportunities: number | null;
  readonly targetsPerGame: number | null;
  readonly carriesPerGame: number | null;
  readonly opportunitiesPerGame: number | null;
  readonly targetShare: number | null;
  readonly offensiveSnaps: number | null;
  readonly offensiveSnapShare: number | null;
  readonly totals: Record<StatsCenterAdditiveMetric, number | null>;
  readonly perGame: Record<StatsCenterAdditiveMetric, number | null>;
  readonly ratios: Record<StatsCenterRatioMetric, number | null>;
  readonly trend: Record<StatsCenterTrendMetric, StatsCenterTrend>;
  readonly boomBust: StatsCenterBoomBust;
}

/** Everything a window of admitted rows yields, shared by the leaderboard and one player. */
export interface StatsCenterWindowResult {
  readonly statsSource: StatsCenterSource;
  readonly snapSource: StatsCenterSource;
  readonly statsState: ReturnType<typeof availability>;
  readonly snapState: ReturnType<typeof availability>;
  readonly targetShareState: ReturnType<typeof availability>;
  readonly metrics: readonly StatsCenterMetricDescriptor[];
  readonly definitions: StatsCenterResponse["definitions"];
  readonly players: readonly StatsCenterPlayerRow[];
  readonly weeklyByPlayer: ReadonlyMap<string, PlayerOpportunityMetrics>;
}

export class StatsCenterService {
  readonly #repository: StatsCenterRepository;
  readonly #now: () => Date;
  readonly #byeWeekLookup: ByeWeekLookupPort | undefined;

  constructor(
    repository: StatsCenterRepository,
    now: () => Date = () => new Date(),
    byeWeekLookup?: ByeWeekLookupPort,
  ) {
    this.#repository = repository;
    this.#now = now;
    this.#byeWeekLookup = byeWeekLookup;
  }

  #validate(query: StatsCenterQuery): void {
    if (query.position && !POSITION_PATTERN.test(query.position.toUpperCase())) {
      throw new Error("Invalid Stats Center position filter");
    }
    if (query.team && !TEAM_PATTERN.test(query.team.toUpperCase())) {
      throw new Error("Invalid Stats Center team filter");
    }
  }

  async #readSources(season: number): Promise<{
    readonly statsSourceRow: StatsCenterSourceRow | undefined;
    readonly snapSourceRow: StatsCenterSourceRow | undefined;
    readonly statsSource: StatsCenterSource;
    readonly snapSource: StatsCenterSource;
  }> {
    const statsKey = `nflverse.stats-player-week.${season}`;
    const snapsKey = `nflverse.snap-counts.${season}`;
    const [statsSourceRow, snapSourceRow] = await Promise.all([
      this.#repository.findSource(statsKey),
      this.#repository.findSource(snapsKey),
    ]);
    return {
      statsSourceRow,
      snapSourceRow,
      statsSource: sourceContract("weekly-stats", statsKey, statsSourceRow),
      snapSource: sourceContract("snap-counts", snapsKey, snapSourceRow),
    };
  }

  /**
   * Reads one window of admitted rows and derives every block from it.
   *
   * Position and name filtering deliberately happen after derivation, never in SQL: target
   * share and air-yards share divide by team-game totals, so dropping a team-mate's row
   * before aggregation would silently inflate both shares. Week and team narrowing is safe
   * because it keeps whole team-games intact.
   */
  async loadWindow(
    query: StatsCenterQuery,
    teamsOverride?: readonly string[],
  ): Promise<StatsCenterWindowResult> {
    this.#validate(query);
    const { statsSourceRow, snapSourceRow, statsSource, snapSource } = await this.#readSources(
      query.season,
    );
    const window: StatsCenterWindow = {
      season: query.season,
      weekFrom: query.weekFrom,
      weekTo: query.weekTo,
      teams: teamsOverride ?? (query.team ? [query.team.toUpperCase()] : null),
    };
    const [weeklyRows, snapRows] = await Promise.all([
      statsSource.state === "available" && statsSourceRow?.lastChecksum
        ? this.#repository.listWeeklyStats(
            statsSourceRow.id,
            statsSourceRow.lastChecksum,
            window,
            DATASET_ROW_LIMIT,
          )
        : Promise.resolve([]),
      snapSource.state === "available" && snapSourceRow?.lastChecksum
        ? this.#repository.listSnapCounts(
            snapSourceRow.id,
            snapSourceRow.lastChecksum,
            window,
            DATASET_ROW_LIMIT,
          )
        : Promise.resolve([]),
    ]);
    const statsBounded = weeklyRows.length < DATASET_ROW_LIMIT;
    const snapsBounded = snapRows.length < DATASET_ROW_LIMIT;
    const usableStats = statsBounded ? weeklyRows : [];
    const usableSnaps = snapsBounded ? snapRows : [];
    const knownPlayers = new Map<
      string,
      { readonly name: string; readonly position: string; readonly teamByWeek: Map<number, string> }
    >();
    for (const row of [...usableStats, ...usableSnaps]) {
      if (!row.playerId || !row.playerName || !row.position) continue;
      const current = knownPlayers.get(row.playerId) ?? {
        name: row.playerName,
        position: row.position,
        teamByWeek: new Map<number, string>(),
      };
      current.teamByWeek.set(row.week, row.team);
      knownPlayers.set(row.playerId, current);
    }

    const unmatchedId = (row: { externalPlayerId: string; gameId: string }) =>
      `unmatched:${row.externalPlayerId}:${row.gameId}`;
    const statInputs: WeeklyPlayerStatObservation[] = usableStats.map((row) => ({
      playerId: row.playerId ?? unmatchedId(row),
      season: row.season,
      week: row.week,
      gameId: row.gameId,
      team: row.team,
      opponentTeam: row.opponentTeam,
      position: row.position ?? "UNKNOWN",
      targets: nonnegativeIntegerComponent(row.components, "targets"),
      carries: nonnegativeIntegerComponent(row.components, "carries"),
      fantasyPoints: sourcePoints(row.sourceFantasyPoints, query.scoring),
    }));
    const snapInputs: WeeklyPlayerSnapObservation[] = usableSnaps.map((row) => ({
      playerId: row.playerId ?? unmatchedId(row),
      season: row.season,
      week: row.week,
      gameId: row.gameId,
      team: row.team,
      opponentTeam: row.opponentTeam,
      offenseSnaps: row.offenseSnaps,
      offenseSnapShare: Number(row.offenseShare),
    }));
    const rejectedStats = statsSource.quality.rowsRejected;
    const completeTeamTargets =
      statsSource.state === "available" && statsBounded && rejectedStats === 0;
    const derived = derivePlayerOpportunityMetrics({
      season: query.season,
      weeklyStats: statInputs,
      snapCounts: snapInputs,
      teamTargetTotalsComplete: completeTeamTargets,
      recentWindow: query.recentWindow,
      recentWeightDecay: query.recentWeightDecay,
      boomBustThresholdsByPosition: BOOM_BUST_THRESHOLDS[query.scoring],
    });

    const metricRowsByPlayer = new Map<string, StatsCenterMetricRow[]>();
    const allMetricRows: StatsCenterMetricRow[] = [];
    for (const row of usableStats) {
      const metricRow: StatsCenterMetricRow = {
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        team: row.team,
        components: row.components,
        advanced: row.advanced,
        sourceFantasyPoints: row.sourceFantasyPoints,
      };
      allMetricRows.push(metricRow);
      const key = row.playerId ?? unmatchedId(row);
      const existing = metricRowsByPlayer.get(key);
      if (existing) existing.push(metricRow);
      else metricRowsByPlayer.set(key, [metricRow]);
    }
    const teamAirYardsByGame = buildTeamAirYardsByGame(allMetricRows);

    const statsState = !statsBounded
      ? availability("unavailable", "The selected weekly dataset exceeded the safe query bound.")
      : statsSource.state !== "available"
        ? availability("unavailable", statsSource.reason)
        : usableStats.length === 0
          ? availability("no-data", "No regular-season weekly rows match these filters.")
          : availability("available", null);
    const snapState = !snapsBounded
      ? availability("unavailable", "The selected snap dataset exceeded the safe query bound.")
      : snapSource.state !== "available"
        ? availability("unavailable", snapSource.reason)
        : usableSnaps.length === 0
          ? availability("no-data", "No regular-season snap rows match these filters.")
          : availability("available", null);
    const targetShareState =
      statsState.state !== "available"
        ? statsState
        : completeTeamTargets
          ? availability("available", null)
          : availability(
              "unavailable",
              "Target share is withheld because complete team-game target coverage was not established for this source file.",
            );

    const metricAvailability = describeStatsCenterMetricAvailability({
      rows: allMetricRows,
      teamTotalsComplete: completeTeamTargets,
      targetShareAvailable: targetShareState.state === "available",
      datasetUnavailableReason:
        statsState.state === "available"
          ? null
          : (statsState.reason ?? "The weekly dataset is unavailable for this window."),
    });
    const metrics: StatsCenterMetricDescriptor[] = STATS_CENTER_METRIC_DESCRIPTORS.map(
      (descriptor) => ({
        id: descriptor.id,
        label: descriptor.label,
        family: descriptor.family,
        kind: descriptor.kind,
        definition: descriptor.definition,
        state: metricAvailability[descriptor.id].state,
        reason: metricAvailability[descriptor.id].reason,
      }),
    );

    const weeklyByPlayer = new Map<string, PlayerOpportunityMetrics>();
    const playerRows: StatsCenterPlayerRow[] = [];
    for (const player of derived.players) {
      const identity = knownPlayers.get(player.playerId);
      if (!identity) continue;
      weeklyByPlayer.set(player.playerId, player);
      const latestTeam = [...identity.teamByWeek.entries()].sort(
        ([left], [right]) => right - left,
      )[0]?.[1];
      const aggregated = aggregateStatsCenterMetrics({
        rows: metricRowsByPlayer.get(player.playerId) ?? [],
        teamAirYardsByGame,
        teamTotalsComplete: completeTeamTargets,
        targetShare: metricNumber(player.rates.targetShare),
      });
      const { totals, perGame, ratios } = metricValueRecords(aggregated);
      playerRows.push({
        playerId: player.playerId,
        name: identity.name,
        position: identity.position,
        team: latestTeam ?? null,
        games: player.statGames,
        snapGames: player.snapGames,
        targets: metricNumber(player.totals.targets),
        carries: metricNumber(player.totals.carries),
        opportunities: metricNumber(player.totals.opportunities),
        targetsPerGame: metricNumber(player.rates.targetsPerGame),
        carriesPerGame: metricNumber(player.rates.carriesPerGame),
        opportunitiesPerGame: metricNumber(player.rates.opportunitiesPerGame),
        targetShare: metricNumber(player.rates.targetShare),
        offensiveSnaps: metricNumber(player.totals.offenseSnaps),
        offensiveSnapShare: metricNumber(player.rates.offenseSnapShare),
        totals,
        perGame,
        ratios,
        trend: trendRecord(player.recentTrend),
        boomBust: boomBustContract(
          player.boomBust,
          BOOM_BUST_THRESHOLDS[query.scoring][identity.position.toUpperCase()] ?? null,
        ),
      });
    }

    return {
      statsSource,
      snapSource,
      statsState,
      snapState,
      targetShareState,
      metrics,
      definitions: {
        opportunities: derived.definitions.opportunities,
        targetShare: derived.definitions.targetShare,
        offensiveSnapShare: derived.definitions.snapShare,
        recentTrend: derived.definitions.recentTrend,
        boomBust: boomBustDefinition(query.scoring),
      },
      players: playerRows,
      weeklyByPlayer,
    };
  }

  async getPlayers(_userId: string, query: StatsCenterQuery): Promise<StatsCenterResponse> {
    const window = await this.loadWindow(query);
    const search = query.search.trim().toLocaleLowerCase();
    const position = query.position?.toUpperCase() ?? null;
    const matched = window.players.filter(
      (player) =>
        (!position || player.position.toUpperCase() === position) &&
        (!search || player.name.toLocaleLowerCase().includes(search)),
    );
    const sorted = [...matched].sort((left, right) => {
      const leftValue = sortValue(left, query.sort);
      const rightValue = sortValue(right, query.sort);
      if (leftValue === null && rightValue !== null) return 1;
      if (rightValue === null && leftValue !== null) return -1;
      if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
        return rightValue - leftValue;
      }
      return left.name.localeCompare(right.name);
    });

    return {
      generatedAt: this.#now().toISOString(),
      filters: {
        season: query.season,
        weekFrom: query.weekFrom,
        weekTo: query.weekTo,
        position: query.position ?? null,
        team: query.team ?? null,
        search: query.search.trim(),
        sort: query.sort,
        scoring: query.scoring,
        recentWindow: query.recentWindow,
        recentWeightDecay: query.recentWeightDecay,
        limit: query.limit,
      },
      availability: {
        targets: window.statsState,
        carries: window.statsState,
        opportunities: window.statsState,
        targetShare: window.targetShareState,
        offensiveSnapShare: window.snapState,
        redZone: availability(
          "unavailable",
          "Red-zone attempts and targets are not present in the admitted weekly datasets.",
        ),
        boomBust:
          window.statsState.state === "available"
            ? availability("available", null)
            : window.statsState,
        fantasyPointsAllowed: availability(
          "unavailable",
          "Fantasy points allowed requires authorized league scoring and complete scored-game coverage.",
        ),
      },
      metrics: [...window.metrics],
      sources: [window.statsSource, window.snapSource],
      players: sorted.slice(0, query.limit),
      totalMatched: matched.length,
      truncated: matched.length > query.limit,
      definitions: window.definitions,
    };
  }

  /**
   * One player across the window. The read is scoped to the teams he appeared for rather than
   * to his own rows, because target share and air-yards share still need every team-mate's row
   * for those same team-games.
   */
  async getPlayer(
    _userId: string,
    playerId: string,
    query: StatsCenterQuery,
  ): Promise<StatsCenterPlayerDetailResponse | undefined> {
    this.#validate(query);
    const identity = await this.#repository.findPlayer(playerId);
    if (!identity) return undefined;

    const { statsSourceRow, statsSource } = await this.#readSources(query.season);
    const teams =
      statsSource.state === "available" && statsSourceRow?.lastChecksum
        ? await this.#repository.listPlayerTeams(
            statsSourceRow.id,
            statsSourceRow.lastChecksum,
            playerId,
            {
              season: query.season,
              weekFrom: query.weekFrom,
              weekTo: query.weekTo,
              teams: null,
            },
          )
        : [];
    // With no rows for this player the window read would be the whole season for nothing, so
    // pin it to an empty team set and let the response report the absence.
    const window = await this.loadWindow(query, teams.length > 0 ? teams : []);
    const summary = window.players.find((player) => player.playerId === playerId);
    const derivedPlayer = window.weeklyByPlayer.get(playerId);
    const byeWeeks = await this.#byeWeeks(query.season);

    return {
      generatedAt: this.#now().toISOString(),
      filters: {
        season: query.season,
        weekFrom: query.weekFrom,
        weekTo: query.weekTo,
        position: query.position ?? null,
        team: query.team ?? null,
        search: query.search.trim(),
        sort: query.sort,
        scoring: query.scoring,
        recentWindow: query.recentWindow,
        recentWeightDecay: query.recentWeightDecay,
        limit: query.limit,
      },
      player: {
        playerId: identity.playerId,
        name: identity.fullName,
        position: identity.primaryPosition,
        team: identity.nflTeam,
        status: identity.status,
        rookieSeason: identity.rookieSeason,
      },
      availability: {
        targets: window.statsState,
        carries: window.statsState,
        opportunities: window.statsState,
        targetShare: window.targetShareState,
        offensiveSnapShare: window.snapState,
        redZone: availability(
          "unavailable",
          "Red-zone attempts and targets are not present in the admitted weekly datasets.",
        ),
        boomBust:
          window.statsState.state === "available"
            ? availability("available", null)
            : window.statsState,
        fantasyPointsAllowed: availability(
          "unavailable",
          "Fantasy points allowed requires authorized league scoring and complete scored-game coverage.",
        ),
      },
      metrics: [...window.metrics],
      summary: summary ?? emptyPlayerRow(identity),
      gameLog: buildGameLog(query, identity, derivedPlayer, byeWeeks),
      sources: [window.statsSource, window.snapSource],
      definitions: window.definitions,
    };
  }

  async #byeWeeks(season: number): Promise<ReadonlyMap<string, number>> {
    if (!this.#byeWeekLookup) return new Map();
    try {
      return await this.#byeWeekLookup.byeWeekLookup(season);
    } catch {
      // A bye marker is a convenience on this surface; losing it must not fail the read.
      return new Map();
    }
  }
}

/** Lets the profile mark bye weeks without the stats surface depending on schedule internals. */
export interface ByeWeekLookupPort {
  byeWeekLookup(season: number): Promise<ReadonlyMap<string, number>>;
}

function emptyTrend(reason: string): StatsCenterTrend {
  return {
    status: "unavailable",
    seasonAverage: null,
    recentWeightedAverage: null,
    absoluteChange: null,
    sampleSize: 0,
    recentSampleSize: 0,
    reason,
  };
}

const NO_ROWS_REASON = "No admitted weekly rows cover this player in the selected window.";

function emptyPlayerRow(identity: StatsCenterPlayerIdentity): StatsCenterPlayerRow {
  const totals = {} as Record<StatsCenterAdditiveMetric, number | null>;
  const perGame = {} as Record<StatsCenterAdditiveMetric, number | null>;
  for (const id of STATS_CENTER_ADDITIVE_METRIC_IDS) {
    totals[id] = null;
    perGame[id] = null;
  }
  const ratios = {} as Record<StatsCenterRatioMetric, number | null>;
  for (const id of STATS_CENTER_RATIO_METRIC_IDS) ratios[id] = null;
  const trend = {} as Record<StatsCenterTrendMetric, StatsCenterTrend>;
  for (const id of [
    "targetsPerGame",
    "carriesPerGame",
    "opportunitiesPerGame",
    "targetShare",
    "offensiveSnapShare",
    "fantasyPoints",
  ] as const) {
    trend[id] = emptyTrend(NO_ROWS_REASON);
  }
  return {
    playerId: identity.playerId,
    name: identity.fullName,
    position: identity.primaryPosition,
    team: identity.nflTeam,
    games: 0,
    snapGames: 0,
    targets: null,
    carries: null,
    opportunities: null,
    targetsPerGame: null,
    carriesPerGame: null,
    opportunitiesPerGame: null,
    targetShare: null,
    offensiveSnaps: null,
    offensiveSnapShare: null,
    totals,
    perGame,
    ratios,
    trend,
    boomBust: {
      status: "unavailable",
      games: 0,
      missingGames: 0,
      booms: null,
      busts: null,
      neutral: null,
      boomRate: null,
      bustRate: null,
      averagePoints: null,
      standardDeviation: null,
      threshold: null,
      reason: NO_ROWS_REASON,
    },
  };
}

/**
 * Played weeks come from the derivation; an affirmed bye is inserted so a gap in the log reads
 * as a bye rather than as missing data. Weeks the schedule cannot vouch for stay absent.
 */
function buildGameLog(
  query: StatsCenterQuery,
  identity: StatsCenterPlayerIdentity,
  player: PlayerOpportunityMetrics | undefined,
  byeWeeks: ReadonlyMap<string, number>,
): StatsCenterGameLogEntry[] {
  const entries: StatsCenterGameLogEntry[] = (player?.weekly ?? []).map((week) => ({
    season: query.season,
    week: week.week,
    gameId: week.gameId,
    team: week.team,
    opponentTeam: week.opponentTeam,
    targets: week.targets,
    teamTargets: week.teamTargets,
    targetShare: week.targetShare,
    carries: week.carries,
    opportunities: week.opportunities,
    offensiveSnaps: week.offenseSnaps,
    offensiveSnapShare: week.offenseSnapShare,
    points: week.fantasyPoints,
    bye: false,
  }));
  // Prefer the team the player actually appeared for, falling back to his listed team.
  const team = entries[entries.length - 1]?.team ?? identity.nflTeam;
  const byeWeek = team ? byeWeeks.get(team.toUpperCase()) : undefined;
  const withinWindow =
    byeWeek !== undefined &&
    (query.weekFrom === null || byeWeek >= query.weekFrom) &&
    (query.weekTo === null || byeWeek <= query.weekTo);
  if (withinWindow && !entries.some((entry) => entry.week === byeWeek)) {
    entries.push({
      season: query.season,
      week: byeWeek,
      gameId: null,
      team,
      opponentTeam: null,
      targets: null,
      teamTargets: null,
      targetShare: null,
      carries: null,
      opportunities: null,
      offensiveSnaps: null,
      offensiveSnapShare: null,
      points: null,
      bye: true,
    });
  }
  return entries.sort((left, right) => left.week - right.week);
}

function sourcePoints(points: Record<string, number>, scoring: StatsCenterScoring): number | null {
  const value = points[scoring];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sortValue(row: StatsCenterPlayerRow, sort: StatsCenterSort): number | null {
  if (sort === "targets") return row.targets;
  if (sort === "carries") return row.carries;
  if (sort === "opportunities") return row.opportunities;
  if (sort === "targetShare") return row.targetShare;
  if (sort === "offensiveSnapShare") return row.offensiveSnapShare;
  if (sort in row.totals) return row.totals[sort as StatsCenterAdditiveMetric];
  return row.ratios[sort as StatsCenterRatioMetric] ?? null;
}
