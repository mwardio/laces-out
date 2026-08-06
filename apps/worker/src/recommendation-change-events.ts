import {
  changeEventDeduplicationKey,
  emitChangeEvents,
  type ChangeEventDraft,
} from "@laces-out/change-events";
import { CHANGE_EVENT_PAYLOAD_VERSION, type RecommendationRunKind } from "@laces-out/contracts";
import type { LeagueRecomputeResult } from "@laces-out/decisions";
import { canonicalJson } from "@laces-out/rankings";
import {
  fantasyTeams,
  leagueMemberships,
  leagueSeasons,
  recommendationRuns,
  recommendations,
  type Database,
} from "@laces-out/db";
import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";

/**
 * The recommendation-delta producer and first reader of persisted recommendation runs.
 *
 * New recommendations are compared with the prior run. `recommendation_runs` has a real producer
 * and a stable replay identity
 * — `(league_season_id, fantasy_team_id, kind, algorithm_version, input_hash)` — so the prior run is
 * a stored, replayable artifact rather than something re-derived. This module therefore reads the
 * *previous persisted run* for the same identity and diffs its `recommendations` rows against the
 * newest one. It never re-runs an engine, and nothing here executes in an API request path.
 *
 * Two early returns make "emit on every write" impossible:
 *
 * 1. a run the recompute resolved to an existing row (`inserted: false`) is a replay — identical
 *    inputs produced the identical stored run, so there is nothing to announce;
 * 2. a team with no prior run is a baseline, exactly like a first-ever roster snapshot.
 *
 * The event is `private` and reaches only the member who claimed the team, because a recommendation
 * is that member's board and nobody else's.
 */

/** One league season's fan-out is bounded by the recompute's own `MAX_CLAIMED_TEAMS`. */
const MAX_DELTA_TEAMS = 32;
const MAX_RUN_ACTIONS = 64;

export interface RecommendationDeltaTeam {
  readonly fantasyTeamId: string;
  readonly teamName: string;
  readonly leagueId: string;
  readonly userId: string;
}

export interface RecommendationRunSummary {
  readonly runId: string;
  readonly inputHash: string;
  readonly week: number | null;
}

export interface RecommendationDeltaRepository {
  describeClaimedTeams(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly RecommendationDeltaTeam[]>;
  /** Newest first. Index 0 is the run just written; index 1 is the prior run to diff against. */
  listRecentRuns(
    leagueSeasonId: string,
    fantasyTeamId: string,
    kind: RecommendationRunKind,
    algorithmVersion: string,
  ): Promise<readonly RecommendationRunSummary[]>;
  listRunActions(runId: string, limit: number): Promise<readonly Record<string, unknown>[]>;
}

/**
 * Strips every number from a recommendation action before hashing.
 *
 * A 0.01-point projection drift is not a user-relevant change, and including it would make the
 * fingerprint churn on every projection refresh — turning the feed into noise and defeating the
 * deduplication it depends on. What survives is the material identity of the move: which players,
 * which slots, which direction.
 */
export function materialAction(action: unknown): unknown {
  if (typeof action === "number") return null;
  if (Array.isArray(action)) return action.map(materialAction);
  if (action !== null && typeof action === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(action as Record<string, unknown>)) {
      if (key === "explanation") continue;
      const material = materialAction(value);
      if (material !== null) result[key] = material;
    }
    return result;
  }
  return action ?? null;
}

/**
 * Order-insensitive over equivalent rows, so a reordered but identical recommendation set is not a
 * change (§12, Determinism).
 */
export function decisionFingerprint(
  sections: Readonly<Partial<Record<RecommendationRunKind, readonly Record<string, unknown>[]>>>,
): string {
  const canonical = Object.entries(sections)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([kind, actions]) => [
      kind,
      (actions ?? []).map((action) => canonicalJson(materialAction(action))).toSorted(),
    ]);
  return createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex");
}

export interface RecommendationDeltaInput {
  readonly leagueSeasonId: string;
  readonly result: LeagueRecomputeResult;
  readonly occurredAt: Date;
}

export class DrizzleRecommendationDeltaRepository implements RecommendationDeltaRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async describeClaimedTeams(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly RecommendationDeltaTeam[]> {
    return this.#database
      .select({
        fantasyTeamId: fantasyTeams.id,
        teamName: fantasyTeams.name,
        leagueId: leagueMemberships.leagueId,
        userId: leagueMemberships.userId,
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
      .limit(limit);
  }

  async listRecentRuns(
    leagueSeasonId: string,
    fantasyTeamId: string,
    kind: RecommendationRunKind,
    algorithmVersion: string,
  ): Promise<readonly RecommendationRunSummary[]> {
    const rows = await this.#database
      .select({
        runId: recommendationRuns.id,
        inputHash: recommendationRuns.inputHash,
        inputs: recommendationRuns.inputs,
      })
      .from(recommendationRuns)
      .where(
        and(
          eq(recommendationRuns.leagueSeasonId, leagueSeasonId),
          eq(recommendationRuns.fantasyTeamId, fantasyTeamId),
          eq(recommendationRuns.kind, kind),
          eq(recommendationRuns.algorithmVersion, algorithmVersion),
        ),
      )
      .orderBy(desc(recommendationRuns.startedAt), desc(recommendationRuns.id))
      .limit(2);
    return rows.map((row) => {
      const week = row.inputs["week"];
      return {
        runId: row.runId,
        inputHash: row.inputHash,
        week: typeof week === "number" ? week : null,
      };
    });
  }

  async listRunActions(runId: string, limit: number): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.#database
      .select({ action: recommendations.action })
      .from(recommendations)
      .where(eq(recommendations.runId, runId))
      .orderBy(asc(recommendations.rank))
      .limit(limit);
    return rows.map((row) => row.action);
  }
}

export interface RecommendationDeltaDependencies {
  readonly repository: RecommendationDeltaRepository;
  readonly emit: (drafts: readonly ChangeEventDraft[], now: Date) => Promise<unknown>;
  readonly algorithmVersion: string;
}

export async function emitRecommendationChangeEvents(
  dependencies: RecommendationDeltaDependencies,
  input: RecommendationDeltaInput,
): Promise<void> {
  // Only runs the recompute actually wrote. A resolved-to-existing run is a replay of identical
  // inputs and, by construction, identical output.
  const written = input.result.runs.filter((run) => run.inserted);
  if (written.length === 0) return;

  const teams = await dependencies.repository.describeClaimedTeams(
    input.leagueSeasonId,
    MAX_DELTA_TEAMS,
  );
  const teamsById = new Map(teams.map((team) => [team.fantasyTeamId, team] as const));

  const drafts: ChangeEventDraft[] = [];
  const byTeam = new Map<string, typeof written>();
  for (const run of written) {
    byTeam.set(run.fantasyTeamId, [...(byTeam.get(run.fantasyTeamId) ?? []), run]);
  }

  for (const [fantasyTeamId, teamRuns] of byTeam) {
    const team = teamsById.get(fantasyTeamId);
    // A team nobody claims has no private recipient, so there is nobody the event could reach.
    if (!team) continue;

    const nextSections: Partial<Record<RecommendationRunKind, readonly Record<string, unknown>[]>> =
      {};
    const priorSections: Partial<
      Record<RecommendationRunKind, readonly Record<string, unknown>[]>
    > = {};
    const changedKinds: RecommendationRunKind[] = [];
    const identityParts: string[] = [];
    let week: number | null = null;
    let hasPrior = false;

    for (const run of teamRuns.toSorted((left, right) => (left.kind < right.kind ? -1 : 1))) {
      const history = await dependencies.repository.listRecentRuns(
        input.leagueSeasonId,
        fantasyTeamId,
        run.kind,
        dependencies.algorithmVersion,
      );
      const next = history[0];
      const prior = history[1];
      if (!next) continue;
      week = next.week ?? week;
      identityParts.push(`${run.kind}:${next.inputHash}`);
      nextSections[run.kind] = await dependencies.repository.listRunActions(
        next.runId,
        MAX_RUN_ACTIONS,
      );
      if (!prior) continue;
      hasPrior = true;
      priorSections[run.kind] = await dependencies.repository.listRunActions(
        prior.runId,
        MAX_RUN_ACTIONS,
      );
      changedKinds.push(run.kind);
    }

    // A team's first-ever run is a baseline, not a change.
    if (!hasPrior || changedKinds.length === 0) continue;

    const nextFingerprint = decisionFingerprint(nextSections);
    const priorFingerprint = decisionFingerprint(priorSections);
    if (nextFingerprint === priorFingerprint) continue;

    const inputChecksum = createHash("sha256")
      .update(canonicalJson(identityParts.toSorted()), "utf8")
      .digest("hex");

    drafts.push({
      source: "decision-delta",
      eventType: "recommendation.changed",
      deduplicationKey: changeEventDeduplicationKey({
        kind: "recommendation.changed",
        leagueSeasonId: input.leagueSeasonId,
        fantasyTeamId,
        userId: team.userId,
        priorFingerprint,
        nextFingerprint,
        inputChecksum,
      }),
      aggregateType: "league-season-team",
      aggregateId: `${input.leagueSeasonId}:${fantasyTeamId}`,
      leagueId: team.leagueId,
      actorUserId: null,
      visibility: "private",
      severity: "action",
      payload: {
        v: CHANGE_EVENT_PAYLOAD_VERSION,
        leagueSeasonId: input.leagueSeasonId,
        fantasyTeamId,
        teamName: team.teamName,
        week,
        kinds: changedKinds,
        fingerprint: nextFingerprint,
        // ADR 0003 provenance, copied from the persisted run this delta was read from.
        algorithmVersion: dependencies.algorithmVersion,
        inputChecksum,
      },
      occurredAt: input.occurredAt,
      // Exactly one recipient. Another member of the same league is never one.
      recipientUserIds: [team.userId],
    });
  }

  if (drafts.length === 0) return;
  await dependencies.emit(drafts, input.occurredAt);
}

export function drizzleRecommendationDelta(
  database: Database,
  algorithmVersion: string,
): RecommendationDeltaDependencies {
  return {
    repository: new DrizzleRecommendationDeltaRepository(database),
    emit: (drafts, now) => emitChangeEvents(database, drafts, now),
    algorithmVersion,
  };
}
