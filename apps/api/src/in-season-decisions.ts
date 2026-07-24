import type {
  DecisionPlayer,
  DecisionUnavailableReason,
  Freshness,
  InSeasonDecisionSnapshot,
  TradeDecisionSection,
} from "@fantasy/contracts";
import {
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  leagueSupplementalSnapshots,
  dataSources,
  playerMarketObservations,
  playerExternalIds,
  playerProjections,
  players,
  projectionSets,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  type Database,
  type LeagueMembershipRole,
  type ProviderName,
} from "@fantasy/db";
import {
  NFL_POSITIONS,
  NFL_TEAMS,
  PLAYER_STATUSES,
  isPlayerEligibleForSlot,
  playerId,
  projectionFor,
  rosterSlotId,
  teamId,
  type NflTeam,
  type Player,
  type PlayerId,
  type PlayerStatus,
  type Position,
  type ProjectionLookup,
  type ProjectionValue,
  type RosterSlot,
  type RosterSlotKind,
  type RosterSlotType,
} from "@fantasy/domain";
import { optimizeLineup, type LineupLock } from "@fantasy/engine-lineup";
import { evaluateTrade, type TradeEvaluation, type TradePackage } from "@fantasy/engine-trade";
import { evaluateWaiverMoves, recommendFaabBid } from "@fantasy/engine-waiver";
import { and, asc, count, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";

import { currentManagedProjectionProfileKey } from "./managed-projection-profile.js";
import { projectionTimestampProvenance } from "./projection-provenance.js";

const MAX_TEAMS = 32;
const MAX_SLOT_RULES = 64;
const MAX_ROSTER_ENTRIES = 1_024;
const MAX_PROJECTION_ROWS = 512;
const MAX_PROJECTION_SET_CANDIDATES = 12;
const MAX_WAIVER_CANDIDATES = 24;
const MAX_TRADE_PACKAGES = 320;
const MAX_TRADE_PACKAGES_PER_OPPONENT = 48;
const MAX_TRADE_POOL_PER_TEAM = 6;
const MAX_ENGINE_STARTERS = 16;

export interface DecisionMembershipRow {
  readonly leagueId: string;
  readonly leagueName: string;
  readonly role: LeagueMembershipRole;
  readonly claimedFantasyTeamId: string | null;
}

export interface DecisionSeasonRow {
  readonly id: string;
  readonly provider: ProviderName;
  readonly externalKey: string;
  readonly season: number;
  readonly currentWeek: number | null;
  readonly waiverType: string | null;
  readonly lastSyncedAt: Date | null;
}

export interface DecisionTeamRow {
  readonly id: string;
  readonly name: string;
  readonly faabRemaining: number | null;
}

export interface DecisionSlotRuleRow {
  readonly id: string;
  readonly slotCode: string;
  readonly count: number;
  readonly eligiblePositions: string[];
  readonly isStarter: boolean;
}

export interface DecisionRosterSnapshotRow {
  readonly id: string;
  readonly teamId: string;
  readonly effectiveAt: Date;
}

export interface DecisionRosterEntryRow {
  readonly snapshotId: string;
  readonly playerId: string;
  readonly name: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: string[];
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly slotCode: string;
  readonly isStarter: boolean;
  readonly locked: boolean;
}

export interface DecisionProjectionSetRow {
  readonly id: string;
  readonly source: string;
  readonly version: string;
  readonly season: number;
  readonly week: number | null;
  readonly horizon: string;
  readonly fetchedAt: Date;
  readonly createdAt: Date;
  readonly metadata: Record<string, unknown>;
}

export interface DecisionProjectionPlayerRow {
  readonly playerId: string;
  readonly name: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: string[];
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly meanPoints: string;
  readonly floorPoints: string | null;
  readonly ceilingPoints: string | null;
}

export interface DecisionMarketSignalRow {
  readonly playerId: string | null;
  readonly signal: "add" | "drop";
  readonly count: number;
  readonly rank: number;
  readonly lookbackHours: number;
  readonly observedAt: Date;
}

export interface DecisionAvailabilitySnapshotRow {
  readonly availability: "free-agent" | "waivers" | null;
  readonly asOfWeek: number | null;
  readonly effectiveAt: Date;
  readonly artifact: Record<string, unknown>;
}

export interface DecisionEspnPlayerIdentityRow {
  readonly playerId: string;
  readonly source: string;
  readonly externalId: string;
}

export interface InSeasonDecisionRepository {
  findMembership(userId: string, leagueId: string): Promise<DecisionMembershipRow | undefined>;
  findLatestSeason(leagueId: string): Promise<DecisionSeasonRow | undefined>;
  listTeams(leagueSeasonId: string, limit: number): Promise<readonly DecisionTeamRow[]>;
  listSlotRules(leagueSeasonId: string, limit: number): Promise<readonly DecisionSlotRuleRow[]>;
  listLatestRosterSnapshots(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly DecisionRosterSnapshotRow[]>;
  listRosterEntries(
    snapshotIds: readonly string[],
    limit: number,
  ): Promise<readonly DecisionRosterEntryRow[]>;
  findProjectionSets(
    actorUserId: string,
    leagueSeasonId: string,
    season: number,
    week: number | null,
    limit: number,
  ): Promise<readonly DecisionProjectionSetRow[]>;
  countProjectionPlayers(projectionSetId: string): Promise<number>;
  listTopProjectionPlayers(
    projectionSetId: string,
    limit: number,
  ): Promise<readonly DecisionProjectionPlayerRow[]>;
  listProjectionPlayersByIds(
    projectionSetId: string,
    playerIds: readonly string[],
  ): Promise<readonly DecisionProjectionPlayerRow[]>;
  listLatestMarketSignals(
    playerIds: readonly string[],
    limit: number,
  ): Promise<readonly DecisionMarketSignalRow[]>;
  findLatestEspnAvailability?(
    leagueSeasonId: string,
    week: number | null,
  ): Promise<readonly DecisionAvailabilitySnapshotRow[]>;
  listEspnPlayerIdentities?(
    leagueSeasonId: string,
    playerIds: readonly string[],
  ): Promise<readonly DecisionEspnPlayerIdentityRow[]>;
}

export class DrizzleInSeasonDecisionRepository implements InSeasonDecisionRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findMembership(
    userId: string,
    leagueId: string,
  ): Promise<DecisionMembershipRow | undefined> {
    const [row] = await this.#database
      .select({
        leagueId: leagues.id,
        leagueName: leagues.name,
        role: leagueMemberships.role,
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
      })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagueMemberships.leagueId, leagues.id))
      .where(and(eq(leagueMemberships.userId, userId), eq(leagues.id, leagueId)))
      .limit(1);
    return row;
  }

  async findLatestSeason(leagueId: string): Promise<DecisionSeasonRow | undefined> {
    const [row] = await this.#database
      .select({
        id: leagueSeasons.id,
        provider: leagueSeasons.provider,
        externalKey: leagueSeasons.externalKey,
        season: leagueSeasons.season,
        currentWeek: leagueSeasons.currentWeek,
        waiverType: leagueSeasons.waiverType,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
      })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.leagueId, leagueId))
      .orderBy(desc(leagueSeasons.season), desc(leagueSeasons.updatedAt))
      .limit(1);
    return row;
  }

  listTeams(leagueSeasonId: string, limit: number): Promise<readonly DecisionTeamRow[]> {
    return this.#database
      .select({
        id: fantasyTeams.id,
        name: fantasyTeams.name,
        faabRemaining: fantasyTeams.faabRemaining,
      })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(asc(fantasyTeams.name), asc(fantasyTeams.id))
      .limit(limit);
  }

  listSlotRules(leagueSeasonId: string, limit: number): Promise<readonly DecisionSlotRuleRow[]> {
    return this.#database
      .select({
        id: rosterSlotRules.id,
        slotCode: rosterSlotRules.slotCode,
        count: rosterSlotRules.count,
        eligiblePositions: rosterSlotRules.eligiblePositions,
        isStarter: rosterSlotRules.isStarter,
      })
      .from(rosterSlotRules)
      .where(eq(rosterSlotRules.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(rosterSlotRules.isStarter), asc(rosterSlotRules.slotCode))
      .limit(limit);
  }

  listLatestRosterSnapshots(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly DecisionRosterSnapshotRow[]> {
    return this.#database
      .selectDistinctOn([rosterSnapshots.teamId], {
        id: rosterSnapshots.id,
        teamId: rosterSnapshots.teamId,
        effectiveAt: rosterSnapshots.effectiveAt,
      })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(rosterSnapshots.teamId, desc(rosterSnapshots.effectiveAt), desc(rosterSnapshots.id))
      .limit(limit);
  }

  listRosterEntries(
    snapshotIds: readonly string[],
    limit: number,
  ): Promise<readonly DecisionRosterEntryRow[]> {
    if (snapshotIds.length === 0) return Promise.resolve([]);
    return this.#database
      .select({
        snapshotId: rosterEntries.snapshotId,
        playerId: players.id,
        name: players.fullName,
        primaryPosition: players.primaryPosition,
        eligiblePositions: players.eligiblePositions,
        nflTeam: players.nflTeam,
        status: players.status,
        slotCode: rosterEntries.slotCode,
        isStarter: rosterEntries.isStarter,
        locked: rosterEntries.locked,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(rosterEntries.playerId, players.id))
      .where(inArray(rosterEntries.snapshotId, [...snapshotIds]))
      .orderBy(asc(rosterEntries.snapshotId), desc(rosterEntries.isStarter), asc(players.fullName))
      .limit(limit);
  }

  async findProjectionSets(
    actorUserId: string,
    leagueSeasonId: string,
    season: number,
    week: number | null,
    limit: number,
  ): Promise<readonly DecisionProjectionSetRow[]> {
    if (week === null) return [];
    const managedProfileKey = await currentManagedProjectionProfileKey(
      this.#database,
      leagueSeasonId,
    );
    const compatibleManagedSet = managedProfileKey
      ? or(
          ne(projectionSets.source, "laces-out-first-party"),
          sql`${projectionSets.metadata}->>'scoringProfileKey' = ${managedProfileKey}`,
        )
      : ne(projectionSets.source, "laces-out-first-party");
    return this.#database
      .select({
        id: projectionSets.id,
        source: projectionSets.source,
        version: projectionSets.version,
        season: projectionSets.season,
        week: projectionSets.week,
        horizon: projectionSets.horizon,
        fetchedAt: projectionSets.fetchedAt,
        createdAt: projectionSets.createdAt,
        metadata: projectionSets.metadata,
      })
      .from(projectionSets)
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, projectionSets.leagueSeasonId))
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
          eq(leagueMemberships.userId, actorUserId),
        ),
      )
      .where(
        and(
          eq(projectionSets.leagueSeasonId, leagueSeasonId),
          eq(projectionSets.season, season),
          eq(projectionSets.week, week),
          eq(projectionSets.horizon, "week"),
          compatibleManagedSet,
          or(
            eq(projectionSets.visibility, "league"),
            and(
              eq(projectionSets.visibility, "private"),
              eq(projectionSets.createdByUserId, actorUserId),
            ),
          ),
        ),
      )
      .orderBy(
        sql`case
          when ${projectionSets.visibility} = 'private' and ${projectionSets.createdByUserId} = ${actorUserId} then 0
          when ${projectionSets.createdByUserId} is not null then 1
          else 2
        end`,
        desc(projectionSets.fetchedAt),
        desc(projectionSets.createdAt),
      )
      .limit(limit);
  }

  async countProjectionPlayers(projectionSetId: string): Promise<number> {
    const [row] = await this.#database
      .select({ value: count() })
      .from(playerProjections)
      .where(eq(playerProjections.projectionSetId, projectionSetId));
    return row?.value ?? 0;
  }

  listTopProjectionPlayers(
    projectionSetId: string,
    limit: number,
  ): Promise<readonly DecisionProjectionPlayerRow[]> {
    return this.#projectionPlayerQuery()
      .where(eq(playerProjections.projectionSetId, projectionSetId))
      .orderBy(desc(playerProjections.meanPoints), asc(players.fullName), asc(players.id))
      .limit(limit);
  }

  listProjectionPlayersByIds(
    projectionSetId: string,
    ids: readonly string[],
  ): Promise<readonly DecisionProjectionPlayerRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.#projectionPlayerQuery()
      .where(
        and(
          eq(playerProjections.projectionSetId, projectionSetId),
          inArray(playerProjections.playerId, [...ids]),
        ),
      )
      .orderBy(asc(players.id))
      .limit(MAX_ROSTER_ENTRIES);
  }

  listLatestMarketSignals(
    ids: readonly string[],
    limit: number,
  ): Promise<readonly DecisionMarketSignalRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.#database
      .selectDistinctOn([playerMarketObservations.playerId, playerMarketObservations.signal], {
        playerId: playerMarketObservations.playerId,
        signal: playerMarketObservations.signal,
        count: playerMarketObservations.count,
        rank: playerMarketObservations.rank,
        lookbackHours: playerMarketObservations.lookbackHours,
        observedAt: playerMarketObservations.observedAt,
      })
      .from(playerMarketObservations)
      .innerJoin(dataSources, eq(playerMarketObservations.sourceId, dataSources.id))
      .where(
        and(
          eq(dataSources.key, "sleeper.trends"),
          inArray(playerMarketObservations.playerId, [...ids]),
        ),
      )
      .orderBy(
        playerMarketObservations.playerId,
        playerMarketObservations.signal,
        desc(playerMarketObservations.observedAt),
      )
      .limit(limit);
  }

  findLatestEspnAvailability(
    leagueSeasonId: string,
    week: number | null,
  ): Promise<readonly DecisionAvailabilitySnapshotRow[]> {
    return this.#database
      .selectDistinctOn([leagueSupplementalSnapshots.availability], {
        availability: leagueSupplementalSnapshots.availability,
        asOfWeek: leagueSupplementalSnapshots.asOfWeek,
        effectiveAt: leagueSupplementalSnapshots.effectiveAt,
        artifact: leagueSupplementalSnapshots.artifact,
      })
      .from(leagueSupplementalSnapshots)
      .where(
        and(
          eq(leagueSupplementalSnapshots.leagueSeasonId, leagueSeasonId),
          eq(leagueSupplementalSnapshots.kind, "available-players"),
          ...(week === null ? [] : [eq(leagueSupplementalSnapshots.asOfWeek, week)]),
        ),
      )
      .orderBy(
        leagueSupplementalSnapshots.availability,
        desc(leagueSupplementalSnapshots.effectiveAt),
        desc(leagueSupplementalSnapshots.id),
      )
      .limit(2);
  }

  listEspnPlayerIdentities(
    leagueSeasonId: string,
    ids: readonly string[],
  ): Promise<readonly DecisionEspnPlayerIdentityRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.#database
      .select({
        playerId: playerExternalIds.playerId,
        source: playerExternalIds.source,
        externalId: playerExternalIds.externalId,
      })
      .from(playerExternalIds)
      .where(
        and(
          inArray(playerExternalIds.playerId, [...ids]),
          or(
            eq(playerExternalIds.source, "espn"),
            and(
              eq(playerExternalIds.source, "espn-self-asserted"),
              like(playerExternalIds.externalId, `${leagueSeasonId}:%`),
            ),
          ),
        ),
      )
      .limit(MAX_PROJECTION_ROWS * 2);
  }

  #projectionPlayerQuery() {
    return this.#database
      .select({
        playerId: players.id,
        name: players.fullName,
        primaryPosition: players.primaryPosition,
        eligiblePositions: players.eligiblePositions,
        nflTeam: players.nflTeam,
        status: players.status,
        meanPoints: playerProjections.meanPoints,
        floorPoints: playerProjections.floorPoints,
        ceilingPoints: playerProjections.ceilingPoints,
      })
      .from(playerProjections)
      .innerJoin(players, eq(playerProjections.playerId, players.id));
  }
}

interface ExpandedSlot extends RosterSlot {
  readonly sourceCode: string;
}

interface PreparedProjectionPlayer {
  readonly player: Player;
  readonly value: ProjectionValue;
}

interface EvaluatedTradePackage {
  readonly opponent: DecisionTeamRow;
  readonly tradePackage: TradePackage;
  readonly evaluation: TradeEvaluation;
}

type TradePackageDecision = Extract<
  TradeDecisionSection,
  { state: "available" }
>["bestForMe"][number];

const positionSet = new Set<string>(NFL_POSITIONS);
const nflTeamSet = new Set<string>(NFL_TEAMS);
const playerStatusSet = new Set<string>(PLAYER_STATUSES);

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freshAvailableProviderIds(
  rows: readonly DecisionAvailabilitySnapshotRow[],
  now: Date,
): ReadonlySet<string> | null {
  if (rows.length === 0) return null;
  const ids = new Set<string>();
  let usableRows = 0;
  for (const row of rows) {
    const ageHours = (now.getTime() - row.effectiveAt.getTime()) / 3_600_000;
    if (ageHours < 0 || ageHours > 24 || !isPlainRecord(row.artifact)) continue;
    if (row.artifact.kind !== "available-players" || !Array.isArray(row.artifact.players)) continue;
    usableRows += 1;
    for (const player of row.artifact.players) {
      if (
        isPlainRecord(player) &&
        typeof player.providerPlayerId === "string" &&
        /^-?\d{1,20}$/u.test(player.providerPlayerId)
      ) {
        ids.add(player.providerPlayerId);
      }
    }
  }
  return usableRows > 0 ? ids : null;
}

function finiteDecimal(value: string | null, fallback?: number): number | undefined {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedCode(code: string): string {
  return code.trim().toUpperCase().replaceAll(" ", "");
}

function toPositions(primary: string, eligible: readonly string[]): readonly Position[] {
  const values = [...eligible, primary]
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is Position => positionSet.has(value));
  return [...new Set(values)];
}

function toPlayer(input: {
  readonly playerId: string;
  readonly name: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: readonly string[];
  readonly nflTeam: string | null;
  readonly status: string | null;
}): Player | undefined {
  const positions = toPositions(input.primaryPosition, input.eligiblePositions);
  if (positions.length === 0) return undefined;
  const nflTeam = input.nflTeam?.trim().toUpperCase();
  const status = input.status?.trim().toUpperCase();
  return {
    id: playerId(input.playerId),
    name: input.name,
    positions,
    ...(nflTeam && nflTeamSet.has(nflTeam) ? { nflTeam: nflTeam as NflTeam } : {}),
    ...(status && playerStatusSet.has(status) ? { status: status as PlayerStatus } : {}),
  };
}

function prepareProjection(row: DecisionProjectionPlayerRow): PreparedProjectionPlayer | undefined {
  const player = toPlayer(row);
  const mean = finiteDecimal(row.meanPoints);
  if (!player || mean === undefined) return undefined;
  const floor = finiteDecimal(row.floorPoints, mean);
  const ceiling = finiteDecimal(row.ceilingPoints, mean);
  if (floor === undefined || ceiling === undefined) return undefined;
  return {
    player,
    value: {
      mean,
      floor: Math.min(floor, mean),
      ceiling: Math.max(ceiling, mean),
    },
  };
}

function decisionPlayer(player: Player, projections: ProjectionLookup): DecisionPlayer {
  const value = projectionFor(projections, player.id);
  return {
    id: player.id,
    name: player.name,
    positions: [...player.positions],
    nflTeam: player.nflTeam ?? null,
    status: player.status ?? null,
    projectedPoints: rounded(value?.mean ?? 0),
  };
}

function reason(
  code: DecisionUnavailableReason["code"],
  message: string,
): DecisionUnavailableReason {
  return { code, message };
}

function unavailable(reasons: readonly DecisionUnavailableReason[]) {
  return { state: "unavailable" as const, reasons: [...reasons] };
}

function freshness(
  observedAt: Date | null,
  now: Date,
  missingLabel = "No projection set",
): Freshness {
  if (!observedAt) return { state: "missing", observedAt: null, label: missingLabel };
  const ageHours = Math.max(0, (now.getTime() - observedAt.getTime()) / 3_600_000);
  const state = ageHours <= 24 ? "fresh" : ageHours <= 72 ? "aging" : "stale";
  const label =
    ageHours < 1
      ? "Updated within the hour"
      : ageHours < 48
        ? `Updated ${Math.floor(ageHours)}h ago`
        : `Updated ${Math.floor(ageHours / 24)}d ago`;
  return { state, observedAt: observedAt.toISOString(), label };
}

function providerExecution(season: DecisionSeasonRow) {
  if (season.provider === "espn") {
    const leagueUrl = /^\d{1,20}$/u.test(season.externalKey)
      ? `https://fantasy.espn.com/football/league?leagueId=${season.externalKey}`
      : "https://fantasy.espn.com/football/";
    return {
      mode: "provider-required" as const,
      provider: "espn" as const,
      label: "Open ESPN to verify and apply manually",
      url: leagueUrl,
    };
  }
  if (season.provider === "yahoo") {
    const match = /^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.(\d{1,20})$/u.exec(season.externalKey);
    return {
      mode: "provider-required" as const,
      provider: "yahoo" as const,
      label: "Open Yahoo to verify and apply manually",
      url: match?.[1]
        ? `https://football.fantasysports.yahoo.com/f1/${match[1]}`
        : "https://football.fantasysports.yahoo.com/",
    };
  }
  return {
    mode: "provider-required" as const,
    provider: "manual" as const,
    label: "Verify and apply manually in your league host",
    url: null,
  };
}

function providerVerification(
  provider: DecisionSeasonRow["provider"] | null,
  storedLockedPlayerCount: number,
): InSeasonDecisionSnapshot["providerVerification"] {
  const host = provider === "yahoo" ? "Yahoo" : provider === "espn" ? "ESPN" : "your league host";
  return {
    lockCoverage: "unavailable",
    storedTrueLocksHonored: true,
    storedFalseMeansUnlocked: false,
    storedLockedPlayerCount,
    actionWarning: `${host} does not provide Laces Out with verified complete game-lock and transaction-constraint coverage. Stored true locks are honored, but recheck lineup locks, player availability, waiver rules, and trade deadline, veto, and keeper constraints on ${host} before acting. Laces Out cannot execute these transactions.`,
  };
}

function isSyntheticProjectionSet(row: DecisionProjectionSetRow): boolean {
  const sourceLooksSynthetic = /(^|[-_.:/])(demo|sample|synthetic|fixture|test)([-_.:/]|$)/iu.test(
    row.source,
  );
  return (
    sourceLooksSynthetic ||
    row.metadata.demo === true ||
    row.metadata.sample === true ||
    row.metadata.synthetic === true ||
    row.metadata.fixture === true
  );
}

function slotType(
  row: DecisionSlotRuleRow,
  positions: readonly Position[],
): RosterSlotType | undefined {
  const code = normalizedCode(row.slotCode);
  if (!row.isStarter) {
    if (["IR", "IR+", "IL", "IL+", "RES", "RESERVE"].includes(code)) return "IR";
    if (["TAXI", "TS"].includes(code)) return "TAXI";
    return "BENCH";
  }
  const direct: Readonly<Record<string, RosterSlotType>> = {
    QB: "QB",
    RB: "RB",
    WR: "WR",
    TE: "TE",
    FLEX: "FLEX",
    "W/R/T": "FLEX",
    "RB/WR/TE": "FLEX",
    "RB/WR": "FLEX",
    "WR/RB": "FLEX",
    REC_FLEX: "REC_FLEX",
    "W/T": "REC_FLEX",
    "WR/TE": "REC_FLEX",
    SUPER_FLEX: "SUPER_FLEX",
    SUPERFLEX: "SUPER_FLEX",
    "Q/W/R/T": "SUPER_FLEX",
    OP: "OP",
    K: "K",
    PK: "K",
    DST: "DST",
    DEF: "DST",
    "D/ST": "DST",
    DL: "DL",
    LB: "LB",
    DB: "DB",
    IDP: "IDP_FLEX",
    DP: "IDP_FLEX",
    IDP_FLEX: "IDP_FLEX",
  };
  if (direct[code]) return direct[code];
  const signature = [...positions].sort().join("|");
  if (signature === "RB|TE|WR") return "FLEX";
  if (signature === "TE|WR") return "REC_FLEX";
  if (signature === "QB|RB|TE|WR") return "SUPER_FLEX";
  if (signature === "DB|DL|IDP|LB" || signature === "DB|DL|LB") return "IDP_FLEX";
  if (positions.length === 1 && positionSet.has(positions[0]!)) {
    const only = positions[0]!;
    return only === "IDP" ? "IDP_FLEX" : only;
  }
  return undefined;
}

function slotKind(type: RosterSlotType): RosterSlotKind {
  if (type === "BENCH") return "BENCH";
  if (type === "IR") return "INJURED_RESERVE";
  if (type === "TAXI") return "TAXI";
  return "STARTER";
}

function expandSlots(rows: readonly DecisionSlotRuleRow[]): readonly ExpandedSlot[] | undefined {
  const slots: ExpandedSlot[] = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) return undefined;
    const positions = toPositions("", row.eligiblePositions);
    const type = slotType(row, positions);
    if (!type || positions.length === 0) return undefined;
    for (let index = 1; index <= row.count; index += 1) {
      slots.push({
        id: rosterSlotId(`${row.id}:${index}`),
        type,
        label: row.count === 1 ? row.slotCode : `${row.slotCode} ${index}`,
        kind: slotKind(type),
        eligiblePositions: positions,
        sourceCode: normalizedCode(row.slotCode),
      });
    }
  }
  return slots;
}

function currentAssignments(
  entries: readonly DecisionRosterEntryRow[],
  playerById: ReadonlyMap<string, Player>,
  starterSlots: readonly ExpandedSlot[],
) {
  const used = new Set<string>();
  const assignments: { playerId: PlayerId; slotId: RosterSlot["id"] }[] = [];
  for (const entry of entries
    .filter((item) => item.isStarter)
    .sort(
      (left, right) =>
        left.slotCode.localeCompare(right.slotCode) || left.playerId.localeCompare(right.playerId),
    )) {
    const player = playerById.get(entry.playerId);
    if (!player) continue;
    const code = normalizedCode(entry.slotCode);
    const exact = starterSlots.find(
      (slot) =>
        !used.has(slot.id) && slot.sourceCode === code && isPlayerEligibleForSlot(player, slot),
    );
    const fallback = starterSlots.find(
      (slot) => !used.has(slot.id) && isPlayerEligibleForSlot(player, slot),
    );
    const slot = exact ?? fallback;
    if (!slot) continue;
    used.add(slot.id);
    assignments.push({ playerId: player.id, slotId: slot.id });
  }
  return assignments;
}

function combinations<T>(values: readonly T[], countToChoose: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let left = 0; left < values.length; left += 1) {
    if (countToChoose === 1) {
      result.push([values[left]!]);
      continue;
    }
    for (let right = left + 1; right < values.length; right += 1) {
      result.push([values[left]!, values[right]!]);
    }
  }
  return result;
}

function tradePackages(
  userPlayers: readonly Player[],
  opponentPlayers: readonly Player[],
  projectionById: ReadonlyMap<string, ProjectionValue>,
  budget: number,
): readonly TradePackage[] {
  const score = (playersToScore: readonly Player[]) =>
    playersToScore.reduce((sum, player) => sum + (projectionById.get(player.id)?.mean ?? 0), 0);
  const orderedUser = [...userPlayers]
    .sort(
      (left, right) =>
        (projectionById.get(right.id)?.mean ?? 0) - (projectionById.get(left.id)?.mean ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, MAX_TRADE_POOL_PER_TEAM);
  const orderedOpponent = [...opponentPlayers]
    .sort(
      (left, right) =>
        (projectionById.get(right.id)?.mean ?? 0) - (projectionById.get(left.id)?.mean ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, MAX_TRADE_POOL_PER_TEAM);
  const singles: TradePackage[] = orderedUser.flatMap((send) =>
    orderedOpponent.map((receive) => ({
      sendsFromA: [send.id],
      sendsFromB: [receive.id],
    })),
  );
  if (singles.length >= budget) return singles.slice(0, budget);

  const userPairs = combinations(orderedUser, 2);
  const opponentPairs = combinations(orderedOpponent, 2);
  const multi = [
    ...userPairs.flatMap((send) =>
      orderedOpponent.map((receive) => ({
        package: { sendsFromA: send.map((player) => player.id), sendsFromB: [receive.id] },
        gap: Math.abs(score(send) - score([receive])),
      })),
    ),
    ...orderedUser.flatMap((send) =>
      opponentPairs.map((receive) => ({
        package: { sendsFromA: [send.id], sendsFromB: receive.map((player) => player.id) },
        gap: Math.abs(score([send]) - score(receive)),
      })),
    ),
  ].sort(
    (left, right) =>
      left.gap - right.gap ||
      [...left.package.sendsFromA, ...left.package.sendsFromB]
        .join(":")
        .localeCompare([...right.package.sendsFromA, ...right.package.sendsFromB].join(":")),
  );
  return [...singles, ...multi.map((item) => item.package)].slice(0, budget);
}

function emptySnapshot(
  membership: DecisionMembershipRow,
  now: Date,
  season: DecisionSeasonRow | undefined,
  reasons: readonly DecisionUnavailableReason[],
): InSeasonDecisionSnapshot {
  return {
    generatedAt: now.toISOString(),
    league: {
      id: membership.leagueId,
      name: membership.leagueName,
      season: season?.season ?? null,
      week: season?.currentWeek ?? null,
      provider: season?.provider ?? null,
    },
    team: null,
    provenance: {
      leagueLastSyncedAt: season?.lastSyncedAt?.toISOString() ?? null,
      rosterEffectiveAt: null,
      projectionSet: null,
      projectionFreshness: freshness(null, now),
    },
    providerVerification: providerVerification(season?.provider ?? null, 0),
    coverage: {
      leagueTeams: 0,
      teamsWithRosters: 0,
      leagueRosteredPlayers: 0,
      claimedRosterPlayers: 0,
      claimedRosterProjected: 0,
      claimedRosterProjectionRatio: 0,
      projectionSetPlayers: 0,
      projectionQueryLimited: false,
    },
    lineup: unavailable(reasons),
    waivers: unavailable(reasons),
    trades: unavailable(reasons),
  };
}

function mapTradePackage(
  item: EvaluatedTradePackage,
  playerById: ReadonlyMap<string, Player>,
  projections: ProjectionLookup,
): TradePackageDecision {
  const user = item.evaluation.teamA!;
  const partner = item.evaluation.teamB!;
  const lookup = (ids: readonly PlayerId[]) =>
    ids.flatMap((id) => {
      const player = playerById.get(id);
      return player ? [decisionPlayer(player, projections)] : [];
    });
  return {
    id: `${item.opponent.id}:${item.tradePackage.sendsFromA.join("+")}:${item.tradePackage.sendsFromB.join("+")}`,
    partner: { id: item.opponent.id, name: item.opponent.name },
    shape: `${item.tradePackage.sendsFromA.length}-for-${item.tradePackage.sendsFromB.length}` as
      "1-for-1" | "2-for-1" | "1-for-2",
    send: lookup(item.tradePackage.sendsFromA),
    receive: lookup(item.tradePackage.sendsFromB),
    forcedDropsForUser: lookup(user.forcedDropPlayerIds),
    forcedDropsForPartner: lookup(partner.forcedDropPlayerIds),
    userGain: rounded(user.weightedDelta),
    partnerGain: rounded(partner.weightedDelta),
    totalGain: rounded(item.evaluation.totalWeightedDelta),
    fairnessGap: rounded(item.evaluation.fairnessGap),
    mutuallyBeneficial: item.evaluation.mutuallyBeneficial,
  };
}

export class InSeasonDecisionService {
  readonly #repository: InSeasonDecisionRepository;
  readonly #clock: () => Date;

  constructor(repository: InSeasonDecisionRepository, clock: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async getSnapshot(
    userId: string,
    leagueId: string,
  ): Promise<InSeasonDecisionSnapshot | undefined> {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return undefined;
    const now = this.#clock();
    const season = await this.#repository.findLatestSeason(leagueId);
    if (!season) {
      return emptySnapshot(membership, now, undefined, [
        reason("NO_SEASON", "Sync a league season before requesting in-season decisions."),
      ]);
    }
    if (!membership.claimedFantasyTeamId) {
      return emptySnapshot(membership, now, season, [
        reason("TEAM_UNCLAIMED", "Claim your fantasy team from the league overview first."),
      ]);
    }

    const [teamRows, slotRuleRows, snapshotRows, projectionSetRows, availabilityRows] =
      await Promise.all([
        this.#repository.listTeams(season.id, MAX_TEAMS + 1),
        this.#repository.listSlotRules(season.id, MAX_SLOT_RULES + 1),
        this.#repository.listLatestRosterSnapshots(season.id, MAX_TEAMS + 1),
        this.#repository.findProjectionSets(
          userId,
          season.id,
          season.season,
          season.currentWeek,
          MAX_PROJECTION_SET_CANDIDATES,
        ),
        season.provider === "espn" && this.#repository.findLatestEspnAvailability
          ? this.#repository.findLatestEspnAvailability(season.id, season.currentWeek)
          : Promise.resolve([]),
      ]);
    const claimedTeam = teamRows.find((team) => team.id === membership.claimedFantasyTeamId);
    if (!claimedTeam) {
      return emptySnapshot(membership, now, season, [
        reason(
          "CLAIMED_TEAM_NOT_IN_SEASON",
          "Your claimed team does not belong to the latest synced season. Claim it again.",
        ),
      ]);
    }
    if (teamRows.length > MAX_TEAMS) {
      return emptySnapshot(membership, now, season, [
        reason(
          "LEAGUE_SIZE_UNSUPPORTED",
          `Decision analysis is capped at ${MAX_TEAMS} teams per league.`,
        ),
      ]);
    }

    const projectionSet = projectionSetRows.find((row) => !isSyntheticProjectionSet(row));
    const projectionTimestamps = projectionSet
      ? projectionTimestampProvenance(projectionSet)
      : null;
    const execution = providerExecution(season);
    const snapshotByTeam = new Map(snapshotRows.map((snapshot) => [snapshot.teamId, snapshot]));
    const claimedSnapshot = snapshotByTeam.get(claimedTeam.id);
    const rosterRows = await this.#repository.listRosterEntries(
      snapshotRows.map((snapshot) => snapshot.id),
      MAX_ROSTER_ENTRIES + 1,
    );
    const boundedRosterRows = rosterRows.slice(0, MAX_ROSTER_ENTRIES);
    const entriesBySnapshot = new Map<string, DecisionRosterEntryRow[]>();
    for (const entry of boundedRosterRows) {
      const current = entriesBySnapshot.get(entry.snapshotId) ?? [];
      current.push(entry);
      entriesBySnapshot.set(entry.snapshotId, current);
    }
    const claimedRosterRows = claimedSnapshot
      ? (entriesBySnapshot.get(claimedSnapshot.id) ?? [])
      : [];
    const rosterPlayerIds = [...new Set(boundedRosterRows.map((entry) => entry.playerId))];

    let totalProjectionPlayers = 0;
    let topProjectionRows: readonly DecisionProjectionPlayerRow[] = [];
    let rosterProjectionRows: readonly DecisionProjectionPlayerRow[] = [];
    if (projectionSet) {
      [totalProjectionPlayers, topProjectionRows, rosterProjectionRows] = await Promise.all([
        this.#repository.countProjectionPlayers(projectionSet.id),
        this.#repository.listTopProjectionPlayers(projectionSet.id, MAX_PROJECTION_ROWS + 1),
        this.#repository.listProjectionPlayersByIds(projectionSet.id, rosterPlayerIds),
      ]);
    }
    const projectionQueryLimited = topProjectionRows.length > MAX_PROJECTION_ROWS;
    const mergedProjectionRows = new Map<string, DecisionProjectionPlayerRow>();
    for (const row of [
      ...topProjectionRows.slice(0, MAX_PROJECTION_ROWS),
      ...rosterProjectionRows,
    ]) {
      mergedProjectionRows.set(row.playerId, row);
    }
    const preparedById = new Map<string, PreparedProjectionPlayer>();
    for (const row of mergedProjectionRows.values()) {
      const prepared = prepareProjection(row);
      if (prepared) preparedById.set(row.playerId, prepared);
    }
    const projectionById = new Map<string, ProjectionValue>(
      [...preparedById].map(([id, prepared]) => [id, prepared.value]),
    );
    const rosterPlayerById = new Map<string, Player>();
    for (const row of boundedRosterRows) {
      const player = toPlayer(row);
      if (player) rosterPlayerById.set(row.playerId, player);
    }
    const allPlayerById = new Map<string, Player>(rosterPlayerById);
    for (const [id, prepared] of preparedById) allPlayerById.set(id, prepared.player);
    const availableProviderIds = freshAvailableProviderIds(availabilityRows, now);
    let explicitlyAvailablePlayerIds: ReadonlySet<string> | null = null;
    if (availableProviderIds && this.#repository.listEspnPlayerIdentities) {
      const identities = await this.#repository.listEspnPlayerIdentities(season.id, [
        ...preparedById.keys(),
      ]);
      const prefix = `${season.id}:`;
      explicitlyAvailablePlayerIds = new Set(
        identities.flatMap((identity) => {
          const providerPlayerId =
            identity.source === "espn"
              ? identity.externalId
              : identity.externalId.startsWith(prefix)
                ? identity.externalId.slice(prefix.length)
                : "";
          return availableProviderIds.has(providerPlayerId) ? [identity.playerId] : [];
        }),
      );
    }

    const userRoster = claimedRosterRows.flatMap((entry) => {
      const player = rosterPlayerById.get(entry.playerId);
      return player ? [player] : [];
    });
    const claimedRosterProjected = userRoster.filter((player) =>
      projectionById.has(player.id),
    ).length;
    const ratio = userRoster.length === 0 ? 0 : claimedRosterProjected / userRoster.length;
    const base: Omit<InSeasonDecisionSnapshot, "lineup" | "waivers" | "trades"> = {
      generatedAt: now.toISOString(),
      league: {
        id: membership.leagueId,
        name: membership.leagueName,
        season: season.season,
        week: season.currentWeek,
        provider: season.provider,
      },
      team: {
        id: claimedTeam.id,
        name: claimedTeam.name,
        faabRemaining: claimedTeam.faabRemaining,
      },
      provenance: {
        leagueLastSyncedAt: season.lastSyncedAt?.toISOString() ?? null,
        rosterEffectiveAt: claimedSnapshot?.effectiveAt.toISOString() ?? null,
        projectionSet: projectionSet
          ? {
              id: projectionSet.id,
              source:
                typeof projectionSet.metadata.sourceLabel === "string"
                  ? projectionSet.metadata.sourceLabel
                  : projectionSet.source,
              version: projectionSet.version,
              horizon: projectionSet.horizon,
              sourceObservedAt: projectionTimestamps?.sourceObservedAt?.toISOString() ?? null,
              sourceObservedAtStatus: projectionTimestamps?.sourceObservedAtStatus ?? "unverified",
              importedAt:
                projectionTimestamps?.importedAt.toISOString() ??
                projectionSet.createdAt.toISOString(),
            }
          : null,
        projectionFreshness: freshness(
          projectionTimestamps?.sourceObservedAt ?? null,
          now,
          projectionSet ? "Projection source time missing / unverified" : "No projection set",
        ),
      },
      providerVerification: providerVerification(
        season.provider,
        boundedRosterRows.filter((entry) => entry.locked).length,
      ),
      coverage: {
        leagueTeams: teamRows.length,
        teamsWithRosters: snapshotRows.length,
        leagueRosteredPlayers: boundedRosterRows.length,
        claimedRosterPlayers: userRoster.length,
        claimedRosterProjected,
        claimedRosterProjectionRatio: rounded(ratio),
        projectionSetPlayers: totalProjectionPlayers,
        projectionQueryLimited,
      },
    };

    const sharedReasons: DecisionUnavailableReason[] = [];
    if (!claimedSnapshot || userRoster.length === 0) {
      sharedReasons.push(
        reason("ROSTER_MISSING", "The claimed team has no stored roster snapshot."),
      );
    }
    if (rosterRows.length > MAX_ROSTER_ENTRIES) {
      sharedReasons.push(
        reason(
          "LEAGUE_SIZE_UNSUPPORTED",
          `League roster analysis is capped at ${MAX_ROSTER_ENTRIES} stored entries.`,
        ),
      );
    }
    if (slotRuleRows.length === 0) {
      sharedReasons.push(
        reason("SLOT_RULES_MISSING", "The synced season does not include roster slot rules."),
      );
    }
    const slots =
      slotRuleRows.length > 0 && slotRuleRows.length <= MAX_SLOT_RULES
        ? expandSlots(slotRuleRows)
        : undefined;
    const starterSlots = slots?.filter((slot) => slot.kind === "STARTER") ?? [];
    if (
      slotRuleRows.length > MAX_SLOT_RULES ||
      !slots ||
      slots.length === 0 ||
      slots.length > MAX_SLOT_RULES ||
      starterSlots.length === 0 ||
      starterSlots.length > MAX_ENGINE_STARTERS
    ) {
      sharedReasons.push(
        reason(
          "SLOT_RULES_UNSUPPORTED",
          `Roster rules could not be mapped safely (maximum ${MAX_ENGINE_STARTERS} starter slots).`,
        ),
      );
    }
    if (!projectionSet) {
      sharedReasons.push(
        reason(
          "PROJECTIONS_MISSING",
          `No non-synthetic projection set matches season ${season.season}${season.currentWeek ? `, week ${season.currentWeek}` : ""}.`,
        ),
      );
    } else if (claimedRosterProjected !== userRoster.length) {
      sharedReasons.push(
        reason(
          "PROJECTION_COVERAGE_INCOMPLETE",
          `Only ${claimedRosterProjected} of ${userRoster.length} claimed-roster players have compatible projections.`,
        ),
      );
    }

    if (sharedReasons.length > 0 || !slots || !projectionSet) {
      const sections = unavailable(sharedReasons);
      return { ...base, lineup: sections, waivers: sections, trades: sections };
    }

    const mappedCurrentAssignments = currentAssignments(
      claimedRosterRows,
      rosterPlayerById,
      starterSlots,
    );
    const currentStarters = claimedRosterRows.filter((entry) => entry.isStarter);
    const unmappedLockedStarter = currentStarters.some(
      (entry) =>
        entry.locked &&
        !mappedCurrentAssignments.some((assignment) => assignment.playerId === entry.playerId),
    );
    let lineup: InSeasonDecisionSnapshot["lineup"];
    if (mappedCurrentAssignments.length !== currentStarters.length || unmappedLockedStarter) {
      lineup = unavailable([
        reason(
          "SLOT_RULES_UNSUPPORTED",
          "The stored starting lineup could not be mapped one-to-one onto its roster slot rules.",
        ),
      ]);
    } else {
      const assignmentByPlayer = new Map(
        mappedCurrentAssignments.map((assignment) => [assignment.playerId, assignment]),
      );
      const locks: LineupLock[] = [];
      for (const entry of claimedRosterRows) {
        if (!entry.locked) continue;
        const player = rosterPlayerById.get(entry.playerId);
        if (!player) continue;
        const assignment = assignmentByPlayer.get(player.id);
        locks.push(
          assignment
            ? { playerId: player.id, kind: "STARTER", slotId: assignment.slotId }
            : { playerId: player.id, kind: "BENCH" },
        );
      }
      const result = optimizeLineup({
        players: userRoster,
        slots: starterSlots,
        projections: projectionById,
        metric: "mean",
        currentAssignments: mappedCurrentAssignments,
        locks,
      });
      if (!result.feasible) {
        lineup = unavailable([
          reason(
            "ENGINE_INFEASIBLE",
            "No complete lineup satisfies the stored roster rules, position eligibility, and recorded true-lock constraints.",
          ),
        ]);
      } else {
        const slotById = new Map(starterSlots.map((slot) => [slot.id, slot]));
        const currentProjectedPoints = currentStarters.reduce(
          (sum, entry) => sum + (projectionById.get(entry.playerId)?.mean ?? 0),
          0,
        );
        lineup = {
          state: "available",
          metric: "mean",
          feasible: true,
          currentProjectedPoints: rounded(currentProjectedPoints),
          optimalProjectedPoints: rounded(result.projectedPoints),
          projectedGain: rounded(result.projectedPoints - currentProjectedPoints),
          assignments: result.assignments.map((assignment) => ({
            slotId: assignment.slotId,
            slotLabel: slotById.get(assignment.slotId)?.label ?? assignment.slotId,
            player: decisionPlayer(allPlayerById.get(assignment.playerId)!, projectionById),
            locked: assignment.locked,
          })),
          changes: result.changes.map((change) => ({
            slotId: change.slotId,
            slotLabel: slotById.get(change.slotId)?.label ?? change.slotId,
            remove: change.removePlayerId
              ? decisionPlayer(allPlayerById.get(change.removePlayerId)!, projectionById)
              : null,
            add: change.addPlayerId
              ? decisionPlayer(allPlayerById.get(change.addPlayerId)!, projectionById)
              : null,
            projectedPointDelta: rounded(change.projectedPointDelta),
          })),
          execution,
          notes: [
            locks.length > 0
              ? `${locks.length} stored true lock${locks.length === 1 ? " was" : "s were"} preserved; complete provider lock coverage remains unavailable.`
              : "No stored true locks were present; that does not verify that every player is unlocked at the provider.",
          ],
        };
      }
    }

    let waivers: InSeasonDecisionSnapshot["waivers"];
    if (snapshotRows.length !== teamRows.length) {
      waivers = unavailable([
        reason(
          "ROSTER_INCOMPLETE",
          `Only ${snapshotRows.length} of ${teamRows.length} teams have roster snapshots, so free-agent status is not reliable.`,
        ),
      ]);
    } else {
      const rosteredIds = new Set(boundedRosterRows.map((entry) => entry.playerId));
      const candidates = [...preparedById.values()]
        .filter(
          (prepared) =>
            !rosteredIds.has(prepared.player.id) &&
            (explicitlyAvailablePlayerIds === null ||
              explicitlyAvailablePlayerIds.has(prepared.player.id)),
        )
        .sort(
          (left, right) =>
            right.value.mean - left.value.mean || left.player.id.localeCompare(right.player.id),
        )
        .slice(0, MAX_WAIVER_CANDIDATES)
        .map((prepared) => prepared.player);
      if (candidates.length === 0) {
        waivers = unavailable([
          reason(
            "CANDIDATE_POOL_EMPTY",
            "No projected unrostered players were found in the bounded candidate pool.",
          ),
        ]);
      } else {
        try {
          const marketRows = (
            await this.#repository.listLatestMarketSignals(
              candidates.map((candidate) => candidate.id),
              MAX_WAIVER_CANDIDATES * 2,
            )
          ).filter((signal) => {
            const ageHours = (now.getTime() - signal.observedAt.getTime()) / 3_600_000;
            return ageHours >= 0 && ageHours <= 6;
          });
          const marketByPlayer = new Map<
            string,
            Partial<Record<"add" | "drop", DecisionMarketSignalRow>>
          >();
          for (const signal of marketRows) {
            if (!signal.playerId) continue;
            const current = marketByPlayer.get(signal.playerId) ?? {};
            current[signal.signal] = signal;
            marketByPlayer.set(signal.playerId, current);
          }
          const peakAddCount = Math.max(
            1,
            ...marketRows.filter((signal) => signal.signal === "add").map((signal) => signal.count),
          );
          const result = evaluateWaiverMoves({
            roster: userRoster,
            candidates,
            starterSlots,
            rosterCapacity: slots.length,
            rosterSlots: slots,
            horizons: [{ id: projectionSet.id, label: projectionSet.horizon, weight: 1 }],
            projectionsByHorizon: { [projectionSet.id]: projectionById },
            protectedPlayerIds: claimedRosterRows
              .filter((entry) => entry.locked)
              .map((entry) => playerId(entry.playerId)),
          });
          const recommendations = result.recommendations
            .filter((move) => move.improvesRoster)
            .slice(0, 8)
            .map((move, index) => {
              const add = allPlayerById.get(move.addPlayerId)!;
              const drop = move.dropPlayerId ? allPlayerById.get(move.dropPlayerId) : undefined;
              const positionPeers = candidates.filter((candidate) =>
                candidate.positions.some((position) => add.positions.includes(position)),
              ).length;
              const marketSignals = marketByPlayer.get(add.id);
              const addSignal = marketSignals?.add;
              const dropSignal = marketSignals?.drop;
              const baselineCompetition = Math.min(0.9, 0.35 + teamRows.length / 40 + index / 100);
              const marketCompetition = addSignal
                ? Math.min(0.95, 0.25 + 0.7 * Math.sqrt(addSignal.count / peakAddCount))
                : 0;
              const bid =
                claimedTeam.faabRemaining === null
                  ? null
                  : recommendFaabBid({
                      weightedDelta: move.weightedDelta,
                      remainingBudget: claimedTeam.faabRemaining,
                      urgency: Math.min(1, Math.max(0, move.weightedDelta / 10)),
                      scarcity: Math.max(0, 1 - positionPeers / MAX_WAIVER_CANDIDATES),
                      competition: Math.max(baselineCompetition, marketCompetition),
                    });
              return {
                add: decisionPlayer(add, projectionById),
                drop: drop ? decisionPlayer(drop, projectionById) : null,
                weightedGain: rounded(move.weightedDelta),
                lineupGain: rounded(move.horizonDeltas[0]?.lineupDelta ?? 0),
                faab: bid
                  ? { low: bid.lowBid, recommended: bid.recommendedBid, high: bid.highBid }
                  : null,
                market:
                  addSignal || dropSignal
                    ? {
                        addCount: addSignal?.count ?? 0,
                        dropCount: dropSignal?.count ?? 0,
                        lookbackHours: addSignal?.lookbackHours ?? dropSignal!.lookbackHours,
                        observedAt: (addSignal?.observedAt ?? dropSignal!.observedAt).toISOString(),
                      }
                    : null,
                rationale: move.explanation,
              };
            });
          waivers = {
            state: "available",
            candidateCount: candidates.length,
            evaluatedMoveCount: result.allEvaluations.length,
            recommendations,
            execution,
            notes: [
              explicitlyAvailablePlayerIds === null
                ? `Evaluated the top ${candidates.length} projected players not rostered in any latest team snapshot.`
                : `Evaluated ${candidates.length} projected players confirmed in ESPN's latest available-player feeds.`,
              recommendations.length === 0
                ? "No bounded add/drop pairing improved projected roster value."
                : "FAAB ranges are heuristic budget guidance, not bid guarantees.",
              marketRows.length > 0
                ? "Sleeper add/drop momentum informs likely waiver competition, never whether a player clears the roster-value bar."
                : "No current cross-platform waiver momentum was available, so bid competition uses league-size heuristics only.",
            ],
          };
        } catch {
          waivers = unavailable([
            reason(
              "ENGINE_INFEASIBLE",
              "The waiver engine could not produce a roster-rule-valid result under the stored constraints.",
            ),
          ]);
        }
      }
    }

    const opponentsWithRoster = teamRows.filter(
      (team) => team.id !== claimedTeam.id && snapshotByTeam.has(team.id),
    );
    const validOpponents = opponentsWithRoster.flatMap((opponent) => {
      const snapshot = snapshotByTeam.get(opponent.id)!;
      const rows = entriesBySnapshot.get(snapshot.id) ?? [];
      const roster = rows.flatMap((entry) => {
        const player = rosterPlayerById.get(entry.playerId);
        return player ? [player] : [];
      });
      return roster.length > 0 && roster.every((player) => projectionById.has(player.id))
        ? [{ opponent, rows, roster }]
        : [];
    });
    let trades: InSeasonDecisionSnapshot["trades"];
    if (validOpponents.length === 0) {
      trades = unavailable([
        reason(
          "OPPONENT_DATA_MISSING",
          "No opponent has both a latest roster snapshot and complete compatible projections.",
        ),
      ]);
    } else {
      const evaluated: EvaluatedTradePackage[] = [];
      const perOpponentBudget = Math.min(
        MAX_TRADE_PACKAGES_PER_OPPONENT,
        Math.max(1, Math.floor(MAX_TRADE_PACKAGES / validOpponents.length)),
      );
      for (const candidate of validOpponents) {
        const packages = tradePackages(
          userRoster,
          candidate.roster,
          projectionById,
          perOpponentBudget,
        );
        for (const tradePackage of packages) {
          if (evaluated.length >= MAX_TRADE_PACKAGES) break;
          try {
            const evaluation = evaluateTrade({
              teamA: {
                teamId: teamId(claimedTeam.id),
                name: claimedTeam.name,
                roster: userRoster,
                starterSlots,
                rosterSlots: slots,
                rosterCapacity: slots.length,
                protectedPlayerIds: claimedRosterRows
                  .filter((entry) => entry.locked)
                  .map((entry) => playerId(entry.playerId)),
              },
              teamB: {
                teamId: teamId(candidate.opponent.id),
                name: candidate.opponent.name,
                roster: candidate.roster,
                starterSlots,
                rosterSlots: slots,
                rosterCapacity: slots.length,
                protectedPlayerIds: candidate.rows
                  .filter((entry) => entry.locked)
                  .map((entry) => playerId(entry.playerId)),
              },
              sendsFromA: tradePackage.sendsFromA,
              sendsFromB: tradePackage.sendsFromB,
              horizons: [{ id: projectionSet.id, label: projectionSet.horizon, weight: 1 }],
              projectionsByHorizon: { [projectionSet.id]: projectionById },
            });
            if (evaluation.legal && evaluation.teamA && evaluation.teamB) {
              evaluated.push({ opponent: candidate.opponent, tradePackage, evaluation });
            }
          } catch {
            // A single malformed package is discarded; the bounded search continues.
          }
        }
      }
      const bestForMe = [...evaluated]
        .filter(
          (item) =>
            item.evaluation.teamA!.weightedDelta > 0 && item.evaluation.teamB!.weightedDelta >= -1,
        )
        .sort(
          (left, right) =>
            right.evaluation.teamA!.weightedDelta - left.evaluation.teamA!.weightedDelta ||
            right.evaluation.teamB!.weightedDelta - left.evaluation.teamB!.weightedDelta ||
            left.opponent.id.localeCompare(right.opponent.id),
        )
        .slice(0, 6)
        .map((item) => mapTradePackage(item, allPlayerById, projectionById));
      const fairest = [...evaluated]
        .filter(
          (item) =>
            item.evaluation.totalWeightedDelta > 0 &&
            item.evaluation.teamA!.weightedDelta >= -1 &&
            item.evaluation.teamB!.weightedDelta >= -1,
        )
        .sort(
          (left, right) =>
            Number(right.evaluation.mutuallyBeneficial) -
              Number(left.evaluation.mutuallyBeneficial) ||
            left.evaluation.fairnessGap - right.evaluation.fairnessGap ||
            right.evaluation.totalWeightedDelta - left.evaluation.totalWeightedDelta ||
            left.opponent.id.localeCompare(right.opponent.id),
        )
        .slice(0, 6)
        .map((item) => mapTradePackage(item, allPlayerById, projectionById));
      trades = {
        state: "available",
        evaluatedPackageCount: evaluated.length,
        eligibleOpponentCount: validOpponents.length,
        bestForMe,
        fairest,
        execution,
        notes: [
          `Evaluated at most ${MAX_TRADE_PACKAGES} deterministic 1-for-1, 2-for-1, and 1-for-2 packages.`,
          `${opponentsWithRoster.length - validOpponents.length} opponent roster${opponentsWithRoster.length - validOpponents.length === 1 ? " was" : "s were"} skipped for incomplete projection coverage.`,
          "Only league-shared team, roster, slot, and projection inputs are exposed; member account data is never included.",
        ],
      };
    }

    return { ...base, lineup, waivers, trades };
  }
}
