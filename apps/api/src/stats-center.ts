import type { StatsCenterMetric, StatsCenterResponse, StatsCenterSource } from "@fantasy/contracts";
import {
  dataSources,
  playerSnapCountObservations,
  playerWeeklyStatObservations,
  players,
  type Database,
  type JsonPrimitive,
} from "@fantasy/db";
import {
  derivePlayerOpportunityMetrics,
  type WeeklyPlayerSnapObservation,
  type WeeklyPlayerStatObservation,
} from "@fantasy/league-analytics";
import { and, asc, eq } from "drizzle-orm";

const DATASET_ROW_LIMIT = 60_001;
const POSITION_PATTERN = /^[A-Z0-9/+.-]{1,20}$/u;

export interface StatsCenterQuery {
  readonly season: number;
  readonly week: number | null;
  readonly position: string | null;
  readonly search: string;
  readonly sort: StatsCenterMetric;
  readonly limit: number;
}

export interface StatsCenterSourceRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly attribution: string | null;
  readonly attributionUrl: string | null;
  readonly lastSuccessfulAt: Date | null;
  readonly lastChecksum: string | null;
  readonly metadata: Record<string, JsonPrimitive>;
}

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

export interface StatsCenterRepository {
  findSource(key: string): Promise<StatsCenterSourceRow | undefined>;
  listWeeklyStats(
    sourceId: string,
    checksum: string,
    season: number,
    week: number | null,
    limit: number,
  ): Promise<readonly StatsCenterWeeklyRow[]>;
  listSnapCounts(
    sourceId: string,
    checksum: string,
    season: number,
    week: number | null,
    limit: number,
  ): Promise<readonly StatsCenterSnapRow[]>;
}

export class DrizzleStatsCenterRepository implements StatsCenterRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findSource(key: string): Promise<StatsCenterSourceRow | undefined> {
    const [row] = await this.#database
      .select({
        id: dataSources.id,
        key: dataSources.key,
        name: dataSources.name,
        attribution: dataSources.attribution,
        attributionUrl: dataSources.attributionUrl,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        lastChecksum: dataSources.lastChecksum,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(and(eq(dataSources.key, key), eq(dataSources.enabled, true)))
      .limit(1);
    return row;
  }

  async listWeeklyStats(
    sourceId: string,
    checksum: string,
    season: number,
    week: number | null,
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
      })
      .from(playerWeeklyStatObservations)
      .leftJoin(players, eq(playerWeeklyStatObservations.playerId, players.id))
      .where(
        and(
          eq(playerWeeklyStatObservations.sourceId, sourceId),
          eq(playerWeeklyStatObservations.inputChecksum, checksum),
          eq(playerWeeklyStatObservations.season, season),
          eq(playerWeeklyStatObservations.seasonType, "REG"),
          ...(week === null ? [] : [eq(playerWeeklyStatObservations.week, week)]),
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
    season: number,
    week: number | null,
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
          eq(playerSnapCountObservations.season, season),
          eq(playerSnapCountObservations.seasonType, "REG"),
          ...(week === null ? [] : [eq(playerSnapCountObservations.week, week)]),
        ),
      )
      .orderBy(
        asc(playerSnapCountObservations.week),
        asc(playerSnapCountObservations.gameId),
        asc(playerSnapCountObservations.externalPlayerId),
      )
      .limit(limit);
  }
}

function metadataInteger(metadata: Record<string, JsonPrimitive>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function metadataRate(metadata: Record<string, JsonPrimitive>): number | null {
  const value = metadata.matchRate;
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

function coveredWeeks(metadata: Record<string, JsonPrimitive>): number[] {
  const raw = metadata.coveredWeeks;
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 25),
    ),
  ].sort((left, right) => left - right);
}

function sourceContract(
  dataset: StatsCenterSource["dataset"],
  key: string,
  source: StatsCenterSourceRow | undefined,
): StatsCenterSource {
  const rowsRead = source ? metadataInteger(source.metadata, "rowsRead") : null;
  const rowsRejected = source ? metadataInteger(source.metadata, "rowsRejected") : null;
  const rowsUnmatched = source ? metadataInteger(source.metadata, "rowsUnmatched") : null;
  const admitted = source?.metadata.publishable === true;
  const ready = admitted && source.lastChecksum !== null && source.lastSuccessfulAt !== null;
  return {
    dataset,
    state: !source ? "unavailable" : ready ? "available" : "quarantined",
    key: source?.key ?? key,
    name: source?.name ?? (dataset === "weekly-stats" ? "Weekly player stats" : "Snap counts"),
    attribution: source?.attribution ?? null,
    attributionUrl: source?.attributionUrl ?? null,
    fetchedAt: source?.lastSuccessfulAt?.toISOString() ?? null,
    checksumSha256: ready ? source.lastChecksum : null,
    coveredWeeks: source ? coveredWeeks(source.metadata) : [],
    quality: {
      rowsRead,
      rowsRejected,
      rowsUnmatched,
      matchRate: source ? metadataRate(source.metadata) : null,
    },
    reason: !source
      ? "This dataset has not completed its first refresh for the selected season."
      : ready
        ? null
        : "The latest dataset has not cleared admission and identity-quality checks.",
  };
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

export class StatsCenterService {
  readonly #repository: StatsCenterRepository;
  readonly #now: () => Date;

  constructor(repository: StatsCenterRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async getPlayers(_userId: string, query: StatsCenterQuery): Promise<StatsCenterResponse> {
    const statsKey = `nflverse.stats-player-week.${query.season}`;
    const snapsKey = `nflverse.snap-counts.${query.season}`;
    const [statsSourceRow, snapSourceRow] = await Promise.all([
      this.#repository.findSource(statsKey),
      this.#repository.findSource(snapsKey),
    ]);
    const statsSource = sourceContract("weekly-stats", statsKey, statsSourceRow);
    const snapSource = sourceContract("snap-counts", snapsKey, snapSourceRow);
    const [weeklyRows, snapRows] = await Promise.all([
      statsSource.state === "available" && statsSourceRow?.lastChecksum
        ? this.#repository.listWeeklyStats(
            statsSourceRow.id,
            statsSourceRow.lastChecksum,
            query.season,
            query.week,
            DATASET_ROW_LIMIT,
          )
        : Promise.resolve([]),
      snapSource.state === "available" && snapSourceRow?.lastChecksum
        ? this.#repository.listSnapCounts(
            snapSourceRow.id,
            snapSourceRow.lastChecksum,
            query.season,
            query.week,
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

    const statInputs: WeeklyPlayerStatObservation[] = usableStats.map((row) => ({
      playerId: row.playerId ?? `unmatched:${row.externalPlayerId}:${row.gameId}`,
      season: row.season,
      week: row.week,
      gameId: row.gameId,
      team: row.team,
      opponentTeam: row.opponentTeam,
      position: row.position ?? "UNKNOWN",
      targets: nonnegativeIntegerComponent(row.components, "targets"),
      carries: nonnegativeIntegerComponent(row.components, "carries"),
    }));
    const snapInputs: WeeklyPlayerSnapObservation[] = usableSnaps.map((row) => ({
      playerId: row.playerId ?? `unmatched:${row.externalPlayerId}:${row.gameId}`,
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
    });
    const search = query.search.trim().toLocaleLowerCase();
    const position = query.position?.toUpperCase() ?? null;
    if (position && !POSITION_PATTERN.test(position)) {
      throw new Error("Invalid Stats Center position filter");
    }
    const allPlayers = derived.players.flatMap((player) => {
      const identity = knownPlayers.get(player.playerId);
      if (!identity) return [];
      if (position && identity.position.toUpperCase() !== position) return [];
      if (search && !identity.name.toLocaleLowerCase().includes(search)) return [];
      const latestTeam = [...identity.teamByWeek.entries()].sort(
        ([left], [right]) => right - left,
      )[0]?.[1];
      return [
        {
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
        },
      ];
    });
    const sortValue = (row: (typeof allPlayers)[number]): number | null => {
      if (query.sort === "targets") return row.targets;
      if (query.sort === "carries") return row.carries;
      if (query.sort === "opportunities") return row.opportunities;
      if (query.sort === "targetShare") return row.targetShare;
      return row.offensiveSnapShare;
    };
    allPlayers.sort((left, right) => {
      const leftValue = sortValue(left);
      const rightValue = sortValue(right);
      if (leftValue === null && rightValue !== null) return 1;
      if (rightValue === null && leftValue !== null) return -1;
      if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
        return rightValue - leftValue;
      }
      return left.name.localeCompare(right.name);
    });

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

    return {
      generatedAt: this.#now().toISOString(),
      filters: query,
      availability: {
        targets: statsState,
        carries: statsState,
        opportunities: statsState,
        targetShare: targetShareState,
        offensiveSnapShare: snapState,
        redZone: availability(
          "unavailable",
          "Red-zone attempts and targets are not present in the admitted weekly datasets.",
        ),
        boomBust: availability(
          "unavailable",
          "Boom and bust rates require verified league scoring and complete scored-game coverage.",
        ),
        fantasyPointsAllowed: availability(
          "unavailable",
          "Fantasy points allowed requires authorized league scoring and complete scored-game coverage.",
        ),
      },
      sources: [statsSource, snapSource],
      players: allPlayers.slice(0, query.limit),
      totalMatched: allPlayers.length,
      truncated: allPlayers.length > query.limit,
      definitions: {
        opportunities: derived.definitions.opportunities,
        targetShare: derived.definitions.targetShare,
        offensiveSnapShare: derived.definitions.snapShare,
      },
    };
  }
}
