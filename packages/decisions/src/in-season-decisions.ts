import { createHash } from "node:crypto";

import type {
  DecisionPlayer,
  DecisionUnavailableReason,
  Freshness,
  InSeasonDecisionSnapshot,
  TradeDecisionSection,
  TradeEvaluationOutcome,
  TradeEvaluationRequest,
  TradeEvaluationResponse,
  TradeRosUnavailable,
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
import {
  evaluateTrade,
  type TradeEvaluation,
  type TradeHorizon,
  type TradePackage,
} from "@fantasy/engine-trade";
import { evaluateWaiverMoves, recommendFaabBid } from "@fantasy/engine-waiver";
import { and, asc, count, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";

import {
  currentManagedProjectionProfile,
  currentManagedProjectionProfileKey,
  type ManagedProjectionProfile,
} from "./managed-projection-profile.js";
import { projectionTimestampProvenance } from "./projection-provenance.js";
import {
  RECOMMENDATION_ALGORITHM_VERSION,
  recommendationInputChecksum,
  type RecommendationChecksumScope,
} from "./recommendation-run.js";

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
const TRADE_BUILDER_ALGORITHM_VERSION = "trade-builder-v1";

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
  /**
   * The stored league settings blob. Read only to checksum the scoring rules a recommendation was
   * computed under — the engines score nothing themselves, they consume already-scored projections.
   */
  readonly settings: Record<string, unknown>;
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

/** Which projection-set visibilities a decision read may admit. */
export type DecisionProjectionVisibility = "actor" | "league-only";

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
    /**
     * `actor` (the default, and the on-demand behavior) admits the actor's own private sets.
     * `league-only` admits league-visible sets exclusively, so a persisted league-scoped
     * `recommendation_runs` row can never carry one user's private projections into a row the whole
     * league later reads.
     */
    visibility?: DecisionProjectionVisibility,
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
  /**
   * The managed (`laces-out-first-party`) weekly projection profile for this league, so a missing
   * weekly projection set can say WHY managed sets were withheld instead of leaving that silent.
   * Optional so existing repository implementations and test doubles are unaffected by default.
   */
  findManagedProjectionProfile?(leagueSeasonId: string): Promise<ManagedProjectionProfile>;
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
        settings: leagueSeasons.settings,
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
    visibility: DecisionProjectionVisibility = "actor",
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
          visibility === "league-only"
            ? eq(projectionSets.visibility, "league")
            : or(
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

  findManagedProjectionProfile(leagueSeasonId: string): Promise<ManagedProjectionProfile> {
    return currentManagedProjectionProfile(this.#database, leagueSeasonId);
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

// Deliberately duplicated from `schedule-edge.ts` rather than shared: extracting a common checksum
// module is its own change, and a silent behavior drift between the two would be worse than a copy.
function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The scope every `InSeasonDecisionSnapshot` checksum is namespaced under. */
const DECISION_SNAPSHOT_SCOPE: RecommendationChecksumScope = "decision-snapshot";

/** The inputs an `InSeasonDecisionSnapshot`'s ADR 0003 checksum is computed over. */
export interface DecisionSnapshotChecksumInput {
  readonly season: DecisionSeasonRow | undefined;
  readonly claimedFantasyTeamId: string | null;
  readonly slotRules: readonly DecisionSlotRuleRow[];
  readonly rosterSnapshotIds: readonly string[];
  readonly projectionSetId: string | null;
  readonly availabilityAsOf: string | null;
}

/** Nothing was read yet, so nothing but the season identifies the snapshot. */
const NO_DECISION_INPUTS: Omit<DecisionSnapshotChecksumInput, "season"> = {
  claimedFantasyTeamId: null,
  slotRules: [],
  rosterSnapshotIds: [],
  projectionSetId: null,
  availabilityAsOf: null,
};

/**
 * Order-insensitive, so two reads of the same league rules produce the same digest whatever order
 * the rows arrive in. The rule's own primary key is excluded: a re-synced but identical rule set is
 * the same input, not a new one.
 */
function slotRulesChecksum(rules: readonly DecisionSlotRuleRow[]): string | null {
  if (rules.length === 0) return null;
  return hash(
    rules
      .map((rule) =>
        stableJson({
          slotCode: rule.slotCode,
          count: rule.count,
          eligiblePositions: [...rule.eligiblePositions].toSorted(),
          isStarter: rule.isStarter,
        }),
      )
      .toSorted(),
  );
}

/**
 * The ADR 0003 input checksum for a decision snapshot.
 *
 * This is `recommendation_runs.input_hash`'s own computation — `recommendationInputChecksum` from
 * `recommendation-run.ts` — called under the `decision-snapshot` scope instead of a run kind, so the
 * on-demand snapshot and the persisted run describe reproducibility with one canonicalization rather
 * than two. It covers the algorithm version, the league season and week, the claimed team, the
 * scoring-rule and slot-rule checksums, every roster-snapshot id, the projection set id, and the
 * availability observation time.
 *
 * `marketSignalAsOf` is null and honestly so: the waiver market read is scoped to candidates that
 * only exist after this provenance is assembled, so the snapshot has no market time to record. The
 * distinct scope keeps that from being read as a persisted run's hash.
 */
export function decisionSnapshotInputChecksum(input: DecisionSnapshotChecksumInput): string {
  return recommendationInputChecksum({
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    leagueSeasonId: input.season?.id ?? null,
    fantasyTeamId: input.claimedFantasyTeamId,
    kind: DECISION_SNAPSHOT_SCOPE,
    week: input.season?.currentWeek ?? null,
    scoringRulesChecksum: input.season ? hash(input.season.settings) : null,
    slotRulesChecksum: slotRulesChecksum(input.slotRules),
    rosterSnapshotIds: input.rosterSnapshotIds,
    projectionSetIds: input.projectionSetId ? [input.projectionSetId] : [],
    marketSignalAsOf: null,
    availabilityAsOf: input.availabilityAsOf,
  });
}

/**
 * The data-freshness half of a snapshot's provenance.
 *
 * `TradeEvaluationResponse` states the trade builder's own ADR 0003 pair at its top level, so
 * restating the snapshot's pair — a different algorithm over different inputs — inside the same
 * response would be two answers to one question.
 */
function freshnessProvenance(
  provenance: InSeasonDecisionSnapshot["provenance"],
): Extract<TradeEvaluationResponse, { state: "available" }>["provenance"] {
  return {
    leagueLastSyncedAt: provenance.leagueLastSyncedAt,
    rosterEffectiveAt: provenance.rosterEffectiveAt,
    projectionSet: provenance.projectionSet,
    projectionFreshness: provenance.projectionFreshness,
  };
}

/** The most recent supplemental observation the snapshot's availability filter could have used. */
function latestAvailabilityAsOf(rows: readonly DecisionAvailabilitySnapshotRow[]): string | null {
  let latest: Date | null = null;
  for (const row of rows) {
    if (!latest || row.effectiveAt.getTime() > latest.getTime()) latest = row.effectiveAt;
  }
  return latest?.toISOString() ?? null;
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

const MANAGED_PROJECTION_SET_SOURCE = "laces-out-first-party";

/**
 * Why managed (`laces-out-first-party`) weekly sets are invisible to `#findProjectionSets`'
 * compatibility filter for this league, in caller-facing prose. Distinguishes "the league's
 * scoring rules cannot be normalized/supported" from "nothing has been published under an
 * otherwise-valid profile yet" — the two causes `currentManagedProjectionProfileKey`'s bare
 * `string | null` collapses into one signal.
 */
function managedProjectionsWithheldReason(profile: ManagedProjectionProfile): string {
  if (profile.key !== null) {
    return "no managed weekly projection set has been published yet for this league's scoring profile";
  }
  if (profile.positions === null) {
    return "the league's stored scoring rules exceeded the bounded read, so they could not be checked";
  }
  return "this league's scoring rules do not normalize to a position Laces Out's managed weekly projections support";
}

function projectionsMissingMessage(
  season: DecisionSeasonRow,
  managedProfile: ManagedProjectionProfile | undefined,
): string {
  const base = `No non-synthetic projection set matches season ${season.season}${season.currentWeek ? `, week ${season.currentWeek}` : ""}.`;
  if (!managedProfile) return base;
  return `${base} Laces Out's managed weekly projections are withheld: ${managedProjectionsWithheldReason(managedProfile)}.`;
}

/**
 * Non-null only when a substitute (non-managed) set is actually in use AND no managed candidate
 * appeared anywhere in the (bounded) candidate list — i.e. a managed set was genuinely unavailable,
 * not merely outranked by a user-created one. `managedCandidatePresent` must be computed from the
 * full candidate list (`#findProjectionSets`' result), never inferred from which row was selected:
 * `#findProjectionSets`' `ORDER BY` always ranks a user-created row above a managed one, so "the
 * selected set isn't managed" does NOT imply "no managed set exists" — a real, compatible managed
 * set can lose that tiebreak while still being present.
 */
function managedProjectionsNote(
  projectionSet: DecisionProjectionSetRow | undefined,
  managedCandidatePresent: boolean,
  managedProfile: ManagedProjectionProfile | undefined,
): string | null {
  if (!projectionSet || managedCandidatePresent || !managedProfile) return null;
  return `Laces Out's managed weekly projections are withheld (${managedProjectionsWithheldReason(managedProfile)}); this week's recommendations use a different projection set instead.`;
}

/**
 * Appends the managed-projections withholding note to an "available" decision section's own
 * `notes`. A no-op for `null` (nothing to say) and for an "unavailable" section (which has no
 * `notes` field to append to — its `reasons` already carries the story).
 */
function withManagedProjectionsNote<T extends { readonly state: string }>(
  section: T,
  note: string | null,
): T {
  if (note === null || section.state !== "available") return section;
  const available = section as unknown as { readonly notes: readonly string[] };
  return { ...section, notes: [...available.notes, note] };
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
  inputs: Omit<DecisionSnapshotChecksumInput, "season">,
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
      algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
      inputChecksum: decisionSnapshotInputChecksum({ ...inputs, season }),
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

export interface TradeSideContext {
  readonly team: DecisionTeamRow;
  readonly roster: readonly Player[];
  readonly rosterRows: readonly DecisionRosterEntryRow[];
}

export interface TradeEvaluationContext {
  readonly user: TradeSideContext;
  readonly opponent: TradeSideContext;
  /** Full roster slots; its length is the roster capacity. */
  readonly slots: readonly RosterSlot[];
  readonly starterSlots: readonly RosterSlot[];
  readonly horizons: readonly TradeHorizon[];
  readonly projectionsByHorizon: Readonly<Record<string, ProjectionLookup>>;
}

/**
 * The single-package evaluation seam shared by the bounded generator and the user-built package
 * builder. It throws exactly what `evaluateTrade` throws; each caller decides how to absorb that.
 */
export function evaluateTradePackage(
  context: TradeEvaluationContext,
  tradePackage: TradePackage,
): TradeEvaluation {
  return evaluateTrade({
    teamA: {
      teamId: teamId(context.user.team.id),
      name: context.user.team.name,
      roster: context.user.roster,
      starterSlots: context.starterSlots,
      rosterSlots: context.slots,
      rosterCapacity: context.slots.length,
      protectedPlayerIds: context.user.rosterRows
        .filter((entry) => entry.locked)
        .map((entry) => playerId(entry.playerId)),
    },
    teamB: {
      teamId: teamId(context.opponent.team.id),
      name: context.opponent.team.name,
      roster: context.opponent.roster,
      starterSlots: context.starterSlots,
      rosterSlots: context.slots,
      rosterCapacity: context.slots.length,
      protectedPlayerIds: context.opponent.rosterRows
        .filter((entry) => entry.locked)
        .map((entry) => playerId(entry.playerId)),
    },
    sendsFromA: tradePackage.sendsFromA,
    sendsFromB: tradePackage.sendsFromB,
    horizons: context.horizons,
    projectionsByHorizon: context.projectionsByHorizon,
  });
}

/**
 * An admitted rest-of-season projection release for this league. It carries its own blend weight so
 * the weighting policy travels with the release that was admitted, rather than being invented here.
 */
export interface RosHorizonCandidate {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly projections: ReadonlyMap<string, ProjectionValue>;
  /** Non-null when a set exists but must not be blended; the reason is surfaced verbatim. */
  readonly unavailable: TradeRosUnavailable | null;
}

export interface ResolvedTradeHorizons {
  readonly horizons: readonly TradeHorizon[];
  readonly projectionsByHorizon: Readonly<Record<string, ProjectionLookup>>;
  readonly rosUnavailable: TradeRosUnavailable | null;
}

export const ROS_RELEASE_STATUS_UNAVAILABLE: TradeRosUnavailable = {
  code: "ROS_RELEASE_STATUS_UNAVAILABLE",
  message:
    "Rest-of-season value is not included. Laces Out publishes an ROS set only for an admitted scoring profile with complete league inputs; that status is not yet exposed to this surface.",
};

/**
 * D5 conditional valuation. Rest-of-season value is blended in only when a compatible admitted ROS
 * release is supplied; otherwise the evaluation is weekly-only and says so. A scoring-incompatible
 * or unreleased set is never substituted, and no rest-of-season value is ever fabricated.
 */
export function resolveTradeHorizons(
  weeklySet: DecisionProjectionSetRow,
  weeklyProjections: ReadonlyMap<string, ProjectionValue>,
  ros: RosHorizonCandidate | undefined,
): ResolvedTradeHorizons {
  const weekly: TradeHorizon = { id: weeklySet.id, label: weeklySet.horizon, weight: 1 };
  const weeklyOnly = {
    horizons: [weekly],
    projectionsByHorizon: { [weeklySet.id]: weeklyProjections },
  };
  if (!ros || ros.unavailable) {
    return { ...weeklyOnly, rosUnavailable: ros?.unavailable ?? ROS_RELEASE_STATUS_UNAVAILABLE };
  }
  // A duplicate horizon id or an empty projection map would make the engine throw. Both mean the
  // candidate cannot be blended, which is an unavailable ROS horizon rather than a request error.
  if (ros.id === weeklySet.id || ros.projections.size === 0 || !(ros.weight > 0)) {
    return {
      ...weeklyOnly,
      rosUnavailable: {
        code: "ROS_SET_UNAVAILABLE",
        message:
          "Rest-of-season value is not included. The available rest-of-season set could not be blended with this week's projections.",
      },
    };
  }
  return {
    horizons: [weekly, { id: ros.id, label: ros.label, weight: ros.weight }],
    projectionsByHorizon: {
      [weeklySet.id]: weeklyProjections,
      [ros.id]: ros.projections,
    },
    rosUnavailable: null,
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
    shape: `${item.tradePackage.sendsFromA.length}-for-${item.tradePackage.sendsFromB.length}`,
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

/**
 * Everything the bounded, authorized league reads produce before any engine runs. `getSnapshot` and
 * `evaluateBuiltTrade` both consume it, so the two surfaces cannot drift on membership, season,
 * slot-rule, roster, or projection admission.
 */
interface DecisionFacts {
  readonly now: Date;
  readonly membership: DecisionMembershipRow;
  readonly season: DecisionSeasonRow;
  readonly claimedTeam: DecisionTeamRow;
  readonly teamRows: readonly DecisionTeamRow[];
  readonly snapshotRows: readonly DecisionRosterSnapshotRow[];
  readonly snapshotByTeam: ReadonlyMap<string, DecisionRosterSnapshotRow>;
  readonly entriesBySnapshot: ReadonlyMap<string, readonly DecisionRosterEntryRow[]>;
  readonly claimedSnapshot: DecisionRosterSnapshotRow | undefined;
  readonly claimedRosterRows: readonly DecisionRosterEntryRow[];
  readonly boundedRosterRows: readonly DecisionRosterEntryRow[];
  readonly userRoster: readonly Player[];
  readonly rosterPlayerById: ReadonlyMap<string, Player>;
  readonly allPlayerById: ReadonlyMap<string, Player>;
  readonly preparedById: ReadonlyMap<string, PreparedProjectionPlayer>;
  readonly projectionById: ReadonlyMap<string, ProjectionValue>;
  readonly projectionSet: DecisionProjectionSetRow;
  readonly slots: readonly ExpandedSlot[];
  readonly starterSlots: readonly ExpandedSlot[];
  readonly execution: ReturnType<typeof providerExecution>;
  readonly explicitlyAvailablePlayerIds: ReadonlySet<string> | null;
  readonly base: Omit<InSeasonDecisionSnapshot, "lineup" | "waivers" | "trades">;
  /** Non-null only when managed weekly projections were withheld and a substitute set is in use. */
  readonly managedProjectionsNote: string | null;
}

type DecisionFactsResult =
  | { readonly kind: "no-membership" }
  | { readonly kind: "unavailable"; readonly snapshot: InSeasonDecisionSnapshot }
  | { readonly kind: "ready"; readonly facts: DecisionFacts };

export class InSeasonDecisionService {
  readonly #repository: InSeasonDecisionRepository;
  readonly #clock: () => Date;

  constructor(repository: InSeasonDecisionRepository, clock: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async #loadDecisionFacts(
    userId: string,
    leagueId: string,
    visibility: DecisionProjectionVisibility = "actor",
  ): Promise<DecisionFactsResult> {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return { kind: "no-membership" };
    const now = this.#clock();
    const season = await this.#repository.findLatestSeason(leagueId);
    if (!season) {
      return {
        kind: "unavailable",
        snapshot: emptySnapshot(
          membership,
          now,
          undefined,
          [reason("NO_SEASON", "Sync a league season before requesting in-season decisions.")],
          NO_DECISION_INPUTS,
        ),
      };
    }
    if (!membership.claimedFantasyTeamId) {
      return {
        kind: "unavailable",
        snapshot: emptySnapshot(
          membership,
          now,
          season,
          [reason("TEAM_UNCLAIMED", "Claim your fantasy team from the league overview first.")],
          NO_DECISION_INPUTS,
        ),
      };
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
          visibility,
        ),
        season.provider === "espn" && this.#repository.findLatestEspnAvailability
          ? this.#repository.findLatestEspnAvailability(season.id, season.currentWeek)
          : Promise.resolve([]),
      ]);
    const projectionSet = projectionSetRows.find((row) => !isSyntheticProjectionSet(row));
    // Whether a managed set was actually admitted into the (bounded) candidate list `#findProjectionSets`
    // returned — NOT whether one was *selected*. `findProjectionSets`' ORDER BY ranks any user-created
    // row above a managed one (`in-season-decisions.ts` §ORDER BY comment below), so a compatible managed
    // set can lose that tiebreak while still being present; in that case nothing was withheld and no
    // note is warranted, even though the selected `projectionSet` isn't the managed one.
    const managedCandidatePresent = projectionSetRows.some(
      (row) => row.source === MANAGED_PROJECTION_SET_SOURCE,
    );
    // Read only when it could actually change the story told below: either nothing was found at all,
    // or no managed candidate appeared among the (bounded) results at all.
    const managedProfile =
      !managedCandidatePresent && this.#repository.findManagedProjectionProfile
        ? await this.#repository.findManagedProjectionProfile(season.id)
        : undefined;
    const managedNote = managedProjectionsNote(
      projectionSet,
      managedCandidatePresent,
      managedProfile,
    );
    // Every league fact that could have shaped this read, whether or not the read gets far enough to
    // use it. An unavailable snapshot is still a recommendation-shaped output under ADR 0003.
    const checksumInputs: Omit<DecisionSnapshotChecksumInput, "season"> = {
      claimedFantasyTeamId: membership.claimedFantasyTeamId,
      slotRules: slotRuleRows,
      rosterSnapshotIds: snapshotRows.map((snapshot) => snapshot.id),
      projectionSetId: projectionSet?.id ?? null,
      availabilityAsOf: latestAvailabilityAsOf(availabilityRows),
    };

    const claimedTeam = teamRows.find((team) => team.id === membership.claimedFantasyTeamId);
    if (!claimedTeam) {
      return {
        kind: "unavailable",
        snapshot: emptySnapshot(
          membership,
          now,
          season,
          [
            reason(
              "CLAIMED_TEAM_NOT_IN_SEASON",
              "Your claimed team does not belong to the latest synced season. Claim it again.",
            ),
          ],
          checksumInputs,
        ),
      };
    }
    if (teamRows.length > MAX_TEAMS) {
      return {
        kind: "unavailable",
        snapshot: emptySnapshot(
          membership,
          now,
          season,
          [
            reason(
              "LEAGUE_SIZE_UNSUPPORTED",
              `Decision analysis is capped at ${MAX_TEAMS} teams per league.`,
            ),
          ],
          checksumInputs,
        ),
      };
    }

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
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        inputChecksum: decisionSnapshotInputChecksum({ ...checksumInputs, season }),
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
        reason("PROJECTIONS_MISSING", projectionsMissingMessage(season, managedProfile)),
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
      return {
        kind: "unavailable",
        snapshot: { ...base, lineup: sections, waivers: sections, trades: sections },
      };
    }

    return {
      kind: "ready",
      facts: {
        now,
        membership,
        season,
        claimedTeam,
        teamRows,
        snapshotRows,
        snapshotByTeam,
        entriesBySnapshot,
        claimedSnapshot,
        claimedRosterRows,
        boundedRosterRows,
        userRoster,
        rosterPlayerById,
        allPlayerById,
        preparedById,
        projectionById,
        projectionSet,
        slots,
        starterSlots,
        execution,
        explicitlyAvailablePlayerIds,
        base,
        managedProjectionsNote: managedNote,
      },
    };
  }

  async getSnapshot(
    userId: string,
    leagueId: string,
    options: { readonly visibility?: DecisionProjectionVisibility } = {},
  ): Promise<InSeasonDecisionSnapshot | undefined> {
    const loaded = await this.#loadDecisionFacts(userId, leagueId, options.visibility ?? "actor");
    if (loaded.kind === "no-membership") return undefined;
    if (loaded.kind === "unavailable") return loaded.snapshot;
    const {
      now,
      claimedTeam,
      teamRows,
      snapshotRows,
      snapshotByTeam,
      entriesBySnapshot,
      claimedRosterRows,
      boundedRosterRows,
      userRoster,
      rosterPlayerById,
      allPlayerById,
      preparedById,
      projectionById,
      projectionSet,
      slots,
      starterSlots,
      execution,
      explicitlyAvailablePlayerIds,
      base,
      managedProjectionsNote,
    } = loaded.facts;

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
        const context: TradeEvaluationContext = {
          user: { team: claimedTeam, roster: userRoster, rosterRows: claimedRosterRows },
          opponent: {
            team: candidate.opponent,
            roster: candidate.roster,
            rosterRows: candidate.rows,
          },
          slots,
          starterSlots,
          horizons: [{ id: projectionSet.id, label: projectionSet.horizon, weight: 1 }],
          projectionsByHorizon: { [projectionSet.id]: projectionById },
        };
        for (const tradePackage of packages) {
          if (evaluated.length >= MAX_TRADE_PACKAGES) break;
          try {
            const evaluation = evaluateTradePackage(context, tradePackage);
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

    return {
      ...base,
      lineup: withManagedProjectionsNote(lineup, managedProjectionsNote),
      waivers: withManagedProjectionsNote(waivers, managedProjectionsNote),
      trades: withManagedProjectionsNote(trades, managedProjectionsNote),
    };
  }

  /**
   * Evaluates a package the user constructed, through the same engine, the same league facts, and
   * the same package presentation the bounded generator uses. Client-supplied IDs are untrusted:
   * every send must sit on the caller's own claimed roster and every receive on the named partner's,
   * and both failures share one rejection code so the route cannot be used to probe roster contents.
   */
  async evaluateBuiltTrade(
    userId: string,
    leagueId: string,
    request: TradeEvaluationRequest,
  ): Promise<TradeEvaluationOutcome> {
    const loaded = await this.#loadDecisionFacts(userId, leagueId);
    if (loaded.kind === "no-membership") return { outcome: "not-found" };
    const unavailableOutcome = (
      reasons: readonly DecisionUnavailableReason[],
    ): TradeEvaluationOutcome => ({
      outcome: "evaluated",
      response: {
        state: "unavailable",
        reasons:
          reasons.length > 0
            ? [...reasons]
            : [reason("ENGINE_INFEASIBLE", "League decision inputs are unavailable.")],
      },
    });
    if (loaded.kind === "unavailable") {
      const trades = loaded.snapshot.trades;
      return unavailableOutcome(trades.state === "unavailable" ? trades.reasons : []);
    }

    const facts = loaded.facts;
    if (request.opponentTeamId === facts.claimedTeam.id) {
      return { outcome: "rejected", code: "OPPONENT_NOT_IN_LEAGUE" };
    }
    const opponentTeam = facts.teamRows.find((team) => team.id === request.opponentTeamId);
    if (!opponentTeam) return { outcome: "rejected", code: "OPPONENT_NOT_IN_LEAGUE" };
    const opponentSnapshot = facts.snapshotByTeam.get(opponentTeam.id);
    if (!opponentSnapshot) return { outcome: "rejected", code: "OPPONENT_NOT_IN_LEAGUE" };

    const opponentRows = facts.entriesBySnapshot.get(opponentSnapshot.id) ?? [];
    const opponentRoster = opponentRows.flatMap((entry) => {
      const player = facts.rosterPlayerById.get(entry.playerId);
      return player ? [player] : [];
    });
    const userRosterIds = new Set<string>(facts.userRoster.map((player) => player.id));
    const opponentRosterIds = new Set<string>(opponentRoster.map((player) => player.id));
    if (
      !request.sendsPlayerIds.every((id) => userRosterIds.has(id)) ||
      !request.receivesPlayerIds.every((id) => opponentRosterIds.has(id))
    ) {
      return { outcome: "rejected", code: "PLAYER_NOT_ON_ROSTER" };
    }

    // The same admission gate the generator applies to a candidate opponent.
    if (
      opponentRoster.length === 0 ||
      !opponentRoster.every((player) => facts.projectionById.has(player.id)) ||
      !facts.userRoster.every((player) => facts.projectionById.has(player.id))
    ) {
      return unavailableOutcome([
        reason(
          "OPPONENT_DATA_MISSING",
          "The selected trade partner does not have both a latest roster snapshot and complete compatible projections.",
        ),
      ]);
    }

    // WP9 will supply an admitted rest-of-season release here. No compatible published set can be
    // selected today, so this resolves weekly-only with a stated reason instead of inventing one.
    const rosCandidate: RosHorizonCandidate | undefined = undefined;
    const { horizons, projectionsByHorizon, rosUnavailable } = resolveTradeHorizons(
      facts.projectionSet,
      facts.projectionById,
      rosCandidate,
    );

    const involvedPlayerIds = [...new Set([...userRosterIds, ...opponentRosterIds])].sort();
    const inputChecksum = hash({
      algorithmVersion: TRADE_BUILDER_ALGORITHM_VERSION,
      leagueSeasonId: facts.season.id,
      projectionSetId: facts.projectionSet.id,
      userTeamId: facts.claimedTeam.id,
      opponentTeamId: opponentTeam.id,
      sends: [...request.sendsPlayerIds].sort(),
      receives: [...request.receivesPlayerIds].sort(),
      slotIds: facts.slots.map((slot) => slot.id),
      horizons: horizons.map(({ id, weight }) => ({ id, weight })),
      rosterEffectiveAt: [facts.claimedSnapshot?.effectiveAt ?? null, opponentSnapshot.effectiveAt],
      // Only the two involved rosters, so unrelated league churn cannot move the checksum while a
      // change to any traded or droppable player's value still does.
      projections: involvedPlayerIds.map((id) => {
        const value = facts.projectionById.get(id);
        return [id, value?.mean ?? null, value?.floor ?? null, value?.ceiling ?? null];
      }),
    });

    const tradePackage: TradePackage = {
      sendsFromA: request.sendsPlayerIds.map((id) => playerId(id)),
      sendsFromB: request.receivesPlayerIds.map((id) => playerId(id)),
    };
    let evaluation: TradeEvaluation;
    try {
      evaluation = evaluateTradePackage(
        {
          user: {
            team: facts.claimedTeam,
            roster: facts.userRoster,
            rosterRows: facts.claimedRosterRows,
          },
          opponent: { team: opponentTeam, roster: opponentRoster, rosterRows: opponentRows },
          slots: facts.slots,
          starterSlots: facts.starterSlots,
          horizons,
          projectionsByHorizon,
        },
        tradePackage,
      );
    } catch {
      return unavailableOutcome([
        reason(
          "ENGINE_INFEASIBLE",
          "The trade engine could not evaluate this package under the stored roster rules and projections.",
        ),
      ]);
    }

    const legal = evaluation.legal && evaluation.teamA !== null && evaluation.teamB !== null;
    const response: TradeEvaluationResponse = {
      state: "available",
      generatedAt: facts.base.generatedAt,
      league: { id: facts.membership.leagueId, name: facts.membership.leagueName },
      algorithmVersion: TRADE_BUILDER_ALGORITHM_VERSION,
      inputChecksum,
      legal,
      package: legal
        ? {
            ...mapTradePackage(
              { opponent: opponentTeam, tradePackage, evaluation },
              facts.allPlayerById,
              facts.projectionById,
            ),
            id: `${opponentTeam.id}:built:${inputChecksum}`,
          }
        : null,
      diagnostics: evaluation.diagnostics.slice(0, 16).map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        teamId: diagnostic.teamId ?? null,
        playerId: diagnostic.playerId ?? null,
      })),
      horizons: horizons.map((horizon) => ({
        id: horizon.id,
        label: horizon.label,
        weight: horizon.weight,
      })),
      rosUnavailable,
      provenance: freshnessProvenance(facts.base.provenance),
      execution: facts.execution,
      notes: [
        "Only league-shared team, roster, slot, and projection inputs are exposed; member account data is never included.",
        "Roster legality and forced drops are enforced on the server; the submitted package cannot bypass them.",
      ],
    };
    return { outcome: "evaluated", response };
  }
}
