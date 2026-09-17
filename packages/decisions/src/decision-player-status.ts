import {
  dataSources,
  nflScheduleObservations,
  playerExternalIds,
  playerInjuryReportObservations,
  playerSourceObservations,
  players,
  type Database,
} from "@laces-out/db";
import { canonicalNflTeamCode, type PlayerStatus } from "@laces-out/domain";
import { and, eq, inArray } from "drizzle-orm";
import {
  reconcileRosterIdentityAliases,
  type ProjectionRosterIdentity,
} from "./projection-roster-aliases.js";

const MAX_PLAYERS = 1_024;
const MAX_CATALOG = 4_096;
const DAY = 86_400_000;

export interface DecisionStatusSource {
  readonly enabled: boolean;
  readonly lastChecksum: string | null;
  readonly lastSuccessfulAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly consecutiveFailures: number;
  readonly checkIntervalMinutes: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Mirrors current (not archived) projection-source admission, also rejecting future timestamps. */
export function decisionStatusSourceIsCurrent(source: DecisionStatusSource, now: Date): boolean {
  const maximumAge = (source.checkIntervalMinutes * 3 + 30) * 60_000;
  return (
    source.enabled &&
    source.lastChecksum !== null &&
    source.consecutiveFailures === 0 &&
    source.metadata.publishable !== false &&
    source.metadata.refreshClaimedAt === undefined &&
    (source.metadata.availability === undefined || source.metadata.availability === "available") &&
    [source.lastCheckedAt, source.lastSuccessfulAt].every(
      (at) =>
        at !== null &&
        Number.isFinite(at.getTime()) &&
        now.getTime() >= at.getTime() &&
        now.getTime() - at.getTime() <= maximumAge,
    )
  );
}

export function normalizedDecisionStatus(value: string | null | undefined): PlayerStatus | null {
  const normalized = value
    ?.trim()
    .toUpperCase()
    .replaceAll(/[\s_/-]/gu, "");
  if (["ACTIVE", "ACT", "HEALTHY"].includes(normalized ?? "")) return "ACTIVE";
  if (["QUESTIONABLE", "Q"].includes(normalized ?? "")) return "QUESTIONABLE";
  if (["DOUBTFUL", "D"].includes(normalized ?? "")) return "DOUBTFUL";
  if (["OUT", "O"].includes(normalized ?? "")) return "OUT";
  if (["IR", "INJUREDRESERVE", "RESERVEINJURED"].includes(normalized ?? "")) return "IR";
  if (["PUP", "RESERVEPUP"].includes(normalized ?? "")) return "PUP";
  if (["SUSPENDED", "SUSP", "SUS", "RESERVESUSPENDED"].includes(normalized ?? ""))
    return "SUSPENDED";
  if (
    [
      "INACTIVE",
      "INA",
      "RES",
      "RESERVE",
      "DEV",
      "EXE",
      "CUT",
      "NWT",
      "RET",
      "TRC",
      "TRD",
      "TRT",
      "NA",
    ].includes(normalized ?? "")
  )
    return "NA";
  return null;
}

const severity: Readonly<Record<PlayerStatus, number>> = {
  UNKNOWN: 0,
  ACTIVE: 1,
  QUESTIONABLE: 2,
  DOUBTFUL: 3,
  OUT: 4,
  NA: 5,
  SUSPENDED: 6,
  PUP: 7,
  IR: 8,
};

export interface DecisionHealthSignal {
  readonly status: PlayerStatus;
  readonly observedAt: Date;
}

/** A fresh explicit feed recovery can clear older injury evidence; catalog ACT is never a signal. */
export function resolveDecisionHealthStatus(
  signals: readonly DecisionHealthSignal[],
  kickoffAt: Date | null,
  now: Date,
): PlayerStatus {
  if (kickoffAt === null || !Number.isFinite(kickoffAt.getTime())) return "UNKNOWN";
  const candidates = signals.filter(
    (signal) => Number.isFinite(signal.observedAt.getTime()) && signal.observedAt <= now,
  );
  const latestHealthy = Math.max(
    -Infinity,
    ...candidates
      .filter((signal) => signal.status === "ACTIVE")
      .map((signal) => signal.observedAt.getTime()),
  );
  const current =
    candidates
      .filter((signal) => signal.observedAt.getTime() >= latestHealthy)
      .toSorted((a, b) => severity[b.status] - severity[a.status])[0]?.status ?? "UNKNOWN";
  const daysUntilKickoff = (kickoffAt.getTime() - now.getTime()) / DAY;
  if (daysUntilKickoff <= 7) return current;
  if (daysUntilKickoff <= 28 && (current === "IR" || current === "PUP")) return current;
  return "UNKNOWN";
}

function feedStatus(values: readonly (string | null | undefined)[]): PlayerStatus | null {
  return (
    values
      .map(normalizedDecisionStatus)
      .filter((status): status is PlayerStatus => status !== null)
      .toSorted((a, b) => severity[b] - severity[a])[0] ?? null
  );
}

export interface DecisionPlayerStatusRequest {
  readonly playerIds: readonly string[];
  readonly leagueSeasonId: string;
  readonly season: number;
  readonly week: number;
  readonly now: Date;
}

/** Bounded, batched, repeatable-read health evidence; no provider fetches or catalog mutations. */
export async function loadDecisionPlayerStatuses(
  database: Database,
  request: DecisionPlayerStatusRequest,
): Promise<ReadonlyMap<string, PlayerStatus>> {
  const ids = [...new Set(request.playerIds)].slice(0, MAX_PLAYERS);
  const unknown = () => new Map(ids.map((id) => [id, "UNKNOWN" as const]));
  if (ids.length === 0) return unknown();
  return database.transaction(
    async (db) => {
      const sources = await db
        .select()
        .from(dataSources)
        .where(
          inArray(dataSources.key, [
            "sleeper.players",
            `nflverse.injuries.${request.season}`,
            `nflverse.schedules.${request.season}`,
          ]),
        );
      const current = new Map(
        sources
          .filter((source) => decisionStatusSourceIsCurrent(source, request.now))
          .map((source) => [source.key, source]),
      );
      const sleeper = current.get("sleeper.players");
      const schedule = current.get(`nflverse.schedules.${request.season}`);
      const injury = current.get(`nflverse.injuries.${request.season}`);
      if (!schedule || (!sleeper?.lastChangedAt && !injury)) return unknown();
      const identityColumns = {
        playerId: players.id,
        gsisId: players.gsisId,
        name: players.fullName,
        primaryPosition: players.primaryPosition,
        eligiblePositions: players.eligiblePositions,
        nflTeam: players.nflTeam,
        status: players.status,
      };
      const roster = await db.select(identityColumns).from(players).where(inArray(players.id, ids));
      const teams = [
        ...new Set(
          roster.flatMap((row) => (row.nflTeam ? [canonicalNflTeamCode(row.nflTeam)] : [])),
        ),
      ];
      if (!teams.length) return unknown();
      const [catalog, games] = await Promise.all([
        sleeper?.lastChangedAt
          ? db
              .select({
                ...identityColumns,
                observedAt: playerSourceObservations.observedAt,
                feedStatus: playerSourceObservations.status,
                injuryStatus: playerSourceObservations.injuryStatus,
                practice: playerSourceObservations.practiceParticipation,
              })
              .from(playerSourceObservations)
              .innerJoin(players, eq(players.id, playerSourceObservations.playerId))
              .where(
                and(
                  eq(playerSourceObservations.sourceId, sleeper.id),
                  eq(playerSourceObservations.observedAt, sleeper.lastChangedAt),
                  inArray(playerSourceObservations.nflTeam, teams),
                ),
              )
              .limit(MAX_CATALOG + 1)
          : Promise.resolve([]),
        db
          .select({
            homeTeam: nflScheduleObservations.homeTeam,
            awayTeam: nflScheduleObservations.awayTeam,
            kickoffAt: nflScheduleObservations.kickoffAt,
            week: nflScheduleObservations.week,
            status: nflScheduleObservations.status,
            homeScore: nflScheduleObservations.homeScore,
            awayScore: nflScheduleObservations.awayScore,
          })
          .from(nflScheduleObservations)
          .where(
            and(
              eq(nflScheduleObservations.sourceId, schedule.id),
              eq(nflScheduleObservations.inputChecksum, schedule.lastChecksum!),
              eq(nflScheduleObservations.season, request.season),
              eq(nflScheduleObservations.seasonType, "REG"),
            ),
          )
          .limit(301),
      ]);
      if (catalog.length > MAX_CATALOG || games.length > 300) return unknown();
      const currentWeek = games
        .filter(
          (game) =>
            game.week <= 18 &&
            game.status !== "cancelled" &&
            game.status !== "postponed" &&
            (game.status !== "final" ||
              game.homeScore === null ||
              game.awayScore === null ||
              (game.kickoffAt !== null &&
                request.now.getTime() - game.kickoffAt.getTime() < 4 * 60 * 60_000)),
        )
        .reduce((first, game) => Math.min(first, game.week), Infinity);
      if (currentWeek !== request.week) return unknown();
      const identityIds = [...new Set([...ids, ...catalog.map((row) => row.playerId)])];
      const externalIds = await db
        .select({
          playerId: playerExternalIds.playerId,
          source: playerExternalIds.source,
          externalId: playerExternalIds.externalId,
        })
        .from(playerExternalIds)
        .where(
          and(
            inArray(playerExternalIds.playerId, identityIds),
            inArray(playerExternalIds.source, [
              "espn",
              "yahoo",
              "sleeper-espn",
              "sleeper-yahoo",
              "espn-self-asserted",
            ]),
          ),
        )
        .limit(20_481);
      if (externalIds.length > 20_480) return unknown();
      const canonicalById = new Map(catalog.map((row) => [row.playerId, row]));
      const catalogCounts = new Map<string, number>();
      for (const row of catalog)
        catalogCounts.set(row.playerId, (catalogCounts.get(row.playerId) ?? 0) + 1);
      const aliases = reconcileRosterIdentityAliases({
        leagueSeasonId: request.leagueSeasonId,
        rosterPlayers: roster,
        projections: [...canonicalById.values()].filter(
          (row) => catalogCounts.get(row.playerId) === 1,
        ),
        externalIds,
      });
      const aliasById = new Map(aliases.map((row) => [row.playerId, row.projectionPlayerId]));
      const healthIds = [...new Set(ids.map((id) => aliasById.get(id) ?? id))];
      const injuries = injury
        ? await db
            .select({
              playerId: playerInjuryReportObservations.playerId,
              reportStatus: playerInjuryReportObservations.reportStatus,
              practice: playerInjuryReportObservations.practiceStatus,
              observedAt: playerInjuryReportObservations.sourceModifiedAt,
              fetchedAt: playerInjuryReportObservations.fetchedAt,
            })
            .from(playerInjuryReportObservations)
            .where(
              and(
                eq(playerInjuryReportObservations.sourceId, injury.id),
                eq(playerInjuryReportObservations.inputChecksum, injury.lastChecksum!),
                eq(playerInjuryReportObservations.season, request.season),
                eq(playerInjuryReportObservations.week, request.week),
                eq(playerInjuryReportObservations.seasonType, "REG"),
                inArray(playerInjuryReportObservations.playerId, healthIds),
              ),
            )
            .limit(MAX_PLAYERS * 4 + 1)
        : [];
      if (injuries.length > MAX_PLAYERS * 4) return unknown();
      const gameByTeam = new Map(
        games
          .filter(
            (game) =>
              game.week === request.week &&
              game.status !== "cancelled" &&
              game.status !== "postponed",
          )
          .flatMap((game) =>
            [game.homeTeam, game.awayTeam].map(
              (team) => [canonicalNflTeamCode(team), game.kickoffAt] as const,
            ),
          ),
      );
      const rosterById = new Map<string, ProjectionRosterIdentity>(
        roster.map((row) => [row.playerId, row]),
      );
      const injuriesByPlayer = new Map<string, DecisionHealthSignal[]>();
      for (const row of injuries) {
        if (!row.playerId) continue;
        const status = feedStatus([row.reportStatus, row.practice]);
        if (!status) continue;
        const entries = injuriesByPlayer.get(row.playerId) ?? [];
        entries.push({ status, observedAt: row.observedAt ?? row.fetchedAt });
        injuriesByPlayer.set(row.playerId, entries);
      }
      return new Map(
        ids.map((id) => {
          const canonicalId = aliasById.get(id) ?? id;
          const catalogRow =
            catalogCounts.get(canonicalId) === 1 ? canonicalById.get(canonicalId) : undefined;
          const signals: DecisionHealthSignal[] = [...(injuriesByPlayer.get(canonicalId) ?? [])];
          if (catalogRow) {
            // The selected feed row's explicit empty injury field can clear an earlier designation.
            // players.status ACT alone cannot, because it describes roster eligibility, not health.
            const status = feedStatus([
              catalogRow.feedStatus,
              catalogRow.injuryStatus,
              catalogRow.practice,
            ]);
            if (status) signals.push({ status, observedAt: catalogRow.observedAt });
          }
          const team = rosterById.get(id)?.nflTeam;
          return [
            id,
            resolveDecisionHealthStatus(
              signals,
              team ? (gameByTeam.get(canonicalNflTeamCode(team)) ?? null) : null,
              request.now,
            ),
          ] as const;
        }),
      );
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
