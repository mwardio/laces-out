import { createHash } from "node:crypto";

import type { InSeasonDecisionSnapshot } from "@laces-out/contracts";
import type { InSeasonDecisionService } from "@laces-out/decisions";
import {
  RECOMMENDATION_ALGORITHM_VERSION,
  recomputeLeagueRecommendations,
  type LeagueRecomputeInput,
  type LeagueRecomputeResult,
  type RecommendationEntry,
  type RecommendationRunInsert,
  type RecommendationRunWriter,
  type RecommendationSnapshot,
  type RecommendationSnapshotRequest,
} from "@laces-out/decisions";
import {
  fantasyTeams,
  leagueMemberships,
  leagueSeasons,
  leagueSupplementalSnapshots,
  playerMarketObservations,
  recommendationRuns,
  recommendations,
  rosterSlotRules,
  rosterSnapshots,
  type Database,
} from "@laces-out/db";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

import {
  drizzleRecommendationDelta,
  emitRecommendationChangeEvents,
} from "./recommendation-change-events.js";
import type {
  RecommendationJob,
  RecommendationRecomputeService as RecommendationRecomputeServicePort,
  WorkerJobContext,
} from "./jobs.js";

/**
 * Executes a queued `recommendation-recompute` job.
 *
 * Thin on purpose: it checks cancellation, resolves which teams the league season actually has a
 * claimant for, and delegates to `@laces-out/decisions`. Every engine decision and every identity rule
 * lives in the package so the API and the worker cannot diverge on what a run means (ADR 0001).
 */

/** The limits below bound each read the same way the on-demand decision path bounds its own. */
const MAX_CLAIMED_TEAMS = 32;
const MAX_SLOT_RULES = 64;
const MAX_ROSTER_SNAPSHOTS = 32;

export interface ClaimedTeam {
  readonly fantasyTeamId: string;
  readonly userId: string;
  readonly leagueId: string;
}

/** What this process decides; the engine ports are supplied once, at wiring time. */
export type LeagueRecomputeRequest = Omit<LeagueRecomputeInput, "buildSnapshot" | "writer">;

export interface RecommendationRecomputeDependencies {
  readonly listClaimedTeamIds: (leagueSeasonId: string) => Promise<readonly string[]>;
  readonly recompute: (input: LeagueRecomputeRequest) => Promise<LeagueRecomputeResult>;
  /**
   * The change-event producer. Runs after the runs are persisted and never inside their
   * transaction: a change-event failure must not undo a recorded recommendation run.
   */
  readonly onRecomputed?: (input: {
    readonly leagueSeasonId: string;
    readonly result: LeagueRecomputeResult;
  }) => Promise<void>;
  readonly onChangeEventError?: (error: unknown) => void;
}

export class RecommendationRecomputeService implements RecommendationRecomputeServicePort {
  readonly #listClaimedTeamIds: RecommendationRecomputeDependencies["listClaimedTeamIds"];
  readonly #recompute: RecommendationRecomputeDependencies["recompute"];
  readonly #onRecomputed: RecommendationRecomputeDependencies["onRecomputed"];
  readonly #onChangeEventError: (error: unknown) => void;

  constructor(dependencies: RecommendationRecomputeDependencies) {
    this.#listClaimedTeamIds = dependencies.listClaimedTeamIds;
    this.#recompute = dependencies.recompute;
    this.#onRecomputed = dependencies.onRecomputed;
    this.#onChangeEventError = dependencies.onChangeEventError ?? (() => undefined);
  }

  async recomputeRecommendations(job: RecommendationJob, context: WorkerJobContext): Promise<void> {
    if (context.signal.aborted) {
      throw new Error("Recommendation recompute was aborted during shutdown");
    }
    const claimedTeamIds = await this.#listClaimedTeamIds(job.leagueSeasonId);
    // A league season nobody has claimed a team in has no decisions to compute. That is a stated
    // no-op, not a fault: dead-lettering it would fill the queue with permanently impossible jobs.
    if (claimedTeamIds.length === 0) return;
    const result = await this.#recompute({
      leagueSeasonId: job.leagueSeasonId,
      kinds: job.kinds,
      claimedTeamIds,
      signal: context.signal,
    });
    if (!this.#onRecomputed) return;
    try {
      await this.#onRecomputed({ leagueSeasonId: job.leagueSeasonId, result });
    } catch (error) {
      this.#onChangeEventError(error);
    }
  }
}

/** Lists the fantasy teams a member of this league season has actually claimed. */
export class DrizzleClaimedTeamReader {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listClaimedTeams(leagueSeasonId: string): Promise<readonly ClaimedTeam[]> {
    return this.#database
      .select({
        fantasyTeamId: fantasyTeams.id,
        userId: leagueMemberships.userId,
        leagueId: leagueMemberships.leagueId,
      })
      .from(fantasyTeams)
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, fantasyTeams.leagueSeasonId))
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
          eq(leagueMemberships.claimedFantasyTeamId, fantasyTeams.id),
        ),
      )
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(asc(fantasyTeams.id))
      .limit(MAX_CLAIMED_TEAMS);
  }
}

function checksum(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null", "utf8")
    .digest("hex");
}

function entriesFrom(section: unknown): readonly RecommendationEntry[] {
  if (section === null || typeof section !== "object") return [];
  const state: unknown = (section as { state?: unknown }).state;
  if (state !== "available") return [];
  const moves: unknown = (section as { moves?: unknown }).moves;
  const items = Array.isArray(moves) ? moves : [];
  return items.slice(0, 64).map((move, index) => ({
    rank: index + 1,
    action: move as Record<string, unknown>,
    explanation:
      typeof (move as { explanation?: unknown }).explanation === "string"
        ? (move as { explanation: string }).explanation
        : "Deterministic engine recommendation",
  }));
}

/**
 * Builds the run-identity inputs and the engine sections for one claimed team.
 *
 * The settings blob and the slot rules are the "exact settings" ADR 0003 asks a run to retain; the
 * roster snapshot ids and the projection set id are the roster and projection versions. They are
 * hashed rather than stored verbatim so the persisted row stays small and comparable.
 */
export class DecisionRecommendationSnapshotSource {
  readonly #database: Database;
  readonly #decisions: InSeasonDecisionService;
  readonly #teamsByLeagueSeason = new Map<string, readonly ClaimedTeam[]>();
  readonly #claimedTeams: DrizzleClaimedTeamReader;

  constructor(input: {
    readonly database: Database;
    readonly decisions: InSeasonDecisionService;
    readonly claimedTeams: DrizzleClaimedTeamReader;
  }) {
    this.#database = input.database;
    this.#decisions = input.decisions;
    this.#claimedTeams = input.claimedTeams;
  }

  async #teams(leagueSeasonId: string): Promise<readonly ClaimedTeam[]> {
    const cached = this.#teamsByLeagueSeason.get(leagueSeasonId);
    if (cached) return cached;
    const teams = await this.#claimedTeams.listClaimedTeams(leagueSeasonId);
    this.#teamsByLeagueSeason.set(leagueSeasonId, teams);
    return teams;
  }

  buildSnapshot = async (
    request: RecommendationSnapshotRequest,
  ): Promise<RecommendationSnapshot | null> => {
    const teams = await this.#teams(request.leagueSeasonId);
    const team = teams.find((candidate) => candidate.fantasyTeamId === request.fantasyTeamId);
    if (!team) return null;

    // `league-only` is not optional here: a league-scoped run must never be computed from one
    // user's private projection set.
    const snapshot = await this.#decisions.getSnapshot(team.userId, team.leagueId, {
      visibility: request.visibility,
    });
    if (!snapshot) return null;

    const [seasonRow] = await this.#database
      .select({ settings: leagueSeasons.settings })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.id, request.leagueSeasonId))
      .limit(1);
    const slotRuleRows = await this.#database
      .select({
        slotCode: rosterSlotRules.slotCode,
        count: rosterSlotRules.count,
        eligiblePositions: rosterSlotRules.eligiblePositions,
        isStarter: rosterSlotRules.isStarter,
      })
      .from(rosterSlotRules)
      .where(eq(rosterSlotRules.leagueSeasonId, request.leagueSeasonId))
      .orderBy(asc(rosterSlotRules.slotCode))
      .limit(MAX_SLOT_RULES);
    const rosterSnapshotRows = await this.#database
      .select({ id: rosterSnapshots.id })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(fantasyTeams.id, rosterSnapshots.teamId))
      .where(eq(fantasyTeams.leagueSeasonId, request.leagueSeasonId))
      .orderBy(desc(rosterSnapshots.effectiveAt))
      .limit(MAX_ROSTER_SNAPSHOTS);
    const [marketRow] = await this.#database
      .select({ observedAt: playerMarketObservations.observedAt })
      .from(playerMarketObservations)
      .where(isNotNull(playerMarketObservations.playerId))
      .orderBy(desc(playerMarketObservations.observedAt))
      .limit(1);
    const [availabilityRow] = await this.#database
      .select({ effectiveAt: leagueSupplementalSnapshots.effectiveAt })
      .from(leagueSupplementalSnapshots)
      .where(eq(leagueSupplementalSnapshots.leagueSeasonId, request.leagueSeasonId))
      .orderBy(desc(leagueSupplementalSnapshots.effectiveAt))
      .limit(1);

    const provenance: InSeasonDecisionSnapshot["provenance"] = snapshot.provenance;
    const projectionSetIds = provenance.projectionSet ? [provenance.projectionSet.id] : [];
    return {
      week: snapshot.league.week,
      scoringRulesChecksum: checksum(seasonRow?.settings ?? null),
      slotRulesChecksum: checksum(slotRuleRows),
      rosterSnapshotIds: rosterSnapshotRows.map((row) => row.id),
      projectionSetIds,
      marketSignalAsOf: marketRow?.observedAt.toISOString() ?? null,
      availabilityAsOf: availabilityRow?.effectiveAt.toISOString() ?? null,
      leagueLastSyncedAt: provenance.leagueLastSyncedAt,
      rosterEffectiveAt: provenance.rosterEffectiveAt,
      projectionFreshness: provenance.projectionFreshness,
      warnings: [],
      sections: {
        lineup: entriesFrom(snapshot.lineup),
        waiver: entriesFrom(snapshot.waivers),
        trade: entriesFrom(snapshot.trades),
      },
    };
  };
}

/** Persists a run and its recommendations in one transaction. */
export class DrizzleRecommendationRunWriter implements RecommendationRunWriter {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findRun(identity: {
    readonly leagueSeasonId: string;
    readonly fantasyTeamId: string;
    readonly kind: string;
    readonly algorithmVersion: string;
    readonly inputChecksum: string;
  }): Promise<{ readonly runId: string } | undefined> {
    const [row] = await this.#database
      .select({ runId: recommendationRuns.id })
      .from(recommendationRuns)
      .where(
        and(
          eq(recommendationRuns.leagueSeasonId, identity.leagueSeasonId),
          eq(recommendationRuns.fantasyTeamId, identity.fantasyTeamId),
          eq(recommendationRuns.kind, identity.kind),
          eq(recommendationRuns.algorithmVersion, identity.algorithmVersion),
          eq(recommendationRuns.inputHash, identity.inputChecksum),
        ),
      )
      .limit(1);
    return row ? { runId: row.runId } : undefined;
  }

  async insertRun(
    input: RecommendationRunInsert,
  ): Promise<{ readonly runId: string; readonly inserted: boolean }> {
    return this.#database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(recommendationRuns)
        .values({
          leagueSeasonId: input.identity.leagueSeasonId,
          fantasyTeamId: input.identity.fantasyTeamId,
          kind: input.identity.kind,
          algorithmVersion: input.provenance.algorithmVersion,
          inputHash: input.provenance.inputChecksum,
          randomSeed: input.provenance.randomSeed,
          inputs: input.provenance.inputs,
          finishedAt: new Date(),
        })
        // The unique index is the second line of defense against a concurrent duplicate. A losing
        // writer resolves to the winner's run rather than failing the job.
        .onConflictDoNothing({
          target: [
            recommendationRuns.leagueSeasonId,
            recommendationRuns.fantasyTeamId,
            recommendationRuns.kind,
            recommendationRuns.algorithmVersion,
            recommendationRuns.inputHash,
          ],
        })
        .returning({ runId: recommendationRuns.id });
      const runId = inserted[0]?.runId;
      if (!runId) {
        const [existing] = await transaction
          .select({ runId: recommendationRuns.id })
          .from(recommendationRuns)
          .where(
            and(
              eq(recommendationRuns.leagueSeasonId, input.identity.leagueSeasonId),
              eq(recommendationRuns.fantasyTeamId, input.identity.fantasyTeamId),
              eq(recommendationRuns.kind, input.identity.kind),
              eq(recommendationRuns.algorithmVersion, input.provenance.algorithmVersion),
              eq(recommendationRuns.inputHash, input.provenance.inputChecksum),
            ),
          )
          .limit(1);
        return { runId: existing?.runId ?? "", inserted: false };
      }
      if (input.entries.length > 0) {
        await transaction.insert(recommendations).values(
          input.entries.map((entry) => ({
            runId,
            rank: entry.rank,
            action: entry.action,
            explanation: entry.explanation,
            // Every recommendation carries the run's warnings, including the visibility restriction.
            warnings: [...input.provenance.warnings],
          })),
        );
      }
      return { runId, inserted: true };
    });
  }
}

/** Wires the real ports for the worker process. */
export function createRecommendationRecomputeService(input: {
  readonly database: Database;
  readonly decisions: InSeasonDecisionService;
  readonly onChangeEventError?: (error: unknown) => void;
}): RecommendationRecomputeService {
  const claimedTeams = new DrizzleClaimedTeamReader(input.database);
  const snapshots = new DecisionRecommendationSnapshotSource({
    database: input.database,
    decisions: input.decisions,
    claimedTeams,
  });
  const writer = new DrizzleRecommendationRunWriter(input.database);
  const delta = drizzleRecommendationDelta(input.database, RECOMMENDATION_ALGORITHM_VERSION);
  return new RecommendationRecomputeService({
    listClaimedTeamIds: async (leagueSeasonId) =>
      (await claimedTeams.listClaimedTeams(leagueSeasonId)).map((team) => team.fantasyTeamId),
    recompute: (recomputeInput) =>
      recomputeLeagueRecommendations({
        ...recomputeInput,
        buildSnapshot: snapshots.buildSnapshot,
        writer,
      }),
    // Persist the run first, then compare it with the prior run and announce only a material change.
    onRecomputed: ({ leagueSeasonId, result }) =>
      emitRecommendationChangeEvents(delta, { leagueSeasonId, result, occurredAt: new Date() }),
    ...(input.onChangeEventError ? { onChangeEventError: input.onChangeEventError } : {}),
  });
}
