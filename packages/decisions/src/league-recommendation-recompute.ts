import type { Freshness, RecommendationRunKind } from "@fantasy/contracts";
import { recommendationKinds, type RecommendationKind } from "@fantasy/jobs";

import {
  RECOMMENDATION_ALGORITHM_VERSION,
  recommendationInputChecksum,
  recommendationRunProvenance,
  type RecommendationRunChecksumInput,
  type RecommendationRunIdentity,
} from "./recommendation-run.js";
import type { RecommendationRunProvenance } from "@fantasy/contracts";

/**
 * Provider-neutral recomputation of a league season's stored recommendation runs.
 *
 * Recommendations are computed on demand and never stored today: `GET /v1/leagues/:id/decisions`
 * calls the engines per request, every response carries `cache-control: no-store`, and
 * `recommendation_runs`/`recommendations` have had zero readers and zero writers since migration
 * 0000. So "invalidate a cache" is not available here — there is nothing to invalidate. This is the
 * producer that ADR 0003's persisted provenance and the prior-run comparison both require, and it
 * is what the change-event feed reads.
 *
 * Ports are injected so the whole thing is unit-testable without a database (the
 * `MemoryNotificationRepository` precedent in `apps/worker/src/push-notifications.test.ts`).
 */

/**
 * Every persisted run is computed from league-visible projection sets only, and says so.
 *
 * The on-demand repository admits `visibility = 'private'` sets belonging to the calling actor. A
 * `recommendation_runs` row is league-scoped, so computing one from a private set would leak that
 * user's projections into a row later surfaced to the whole league. Forcing league visibility is
 * the fix; recording the restriction is what keeps the difference from the on-demand view honest
 * rather than invisible.
 */
export const PRIVATE_PROJECTION_SETS_EXCLUDED = "PRIVATE_PROJECTION_SETS_EXCLUDED";

/**
 * Explicit producer map over every `recommendationKinds` value. `draft` maps to null: nothing
 * enqueues it for an in-season recompute today, and a silent no-op would hide a real wiring bug.
 */
const inSeasonProducers: Readonly<Record<RecommendationKind, RecommendationRunKind | null>> = {
  draft: null,
  lineup: "lineup",
  waiver: "waiver",
  trade: "trade",
};

export interface RecommendationSnapshotRequest {
  readonly leagueSeasonId: string;
  readonly fantasyTeamId: string;
  /** Never `all`: a persisted league-scoped run must not be computed from a private set. */
  readonly visibility: "league-only";
  readonly signal: AbortSignal;
}

/** The inputs a run is identified by, plus the sections it persists. */
export interface RecommendationSnapshot {
  readonly week: number | null;
  readonly scoringRulesChecksum: string | null;
  readonly slotRulesChecksum: string | null;
  readonly rosterSnapshotIds: readonly string[];
  readonly projectionSetIds: readonly string[];
  readonly marketSignalAsOf: string | null;
  readonly availabilityAsOf: string | null;
  readonly leagueLastSyncedAt: string | null;
  readonly rosterEffectiveAt: string | null;
  readonly projectionFreshness: Freshness;
  readonly warnings: readonly string[];
  readonly sections: Readonly<Record<RecommendationRunKind, readonly RecommendationEntry[]>>;
}

export interface RecommendationEntry {
  readonly rank: number;
  readonly action: Record<string, unknown>;
  readonly explanation: string;
  readonly expectedValueDelta?: number | null;
  readonly confidence?: number | null;
}

export interface RecommendationRunInsert {
  readonly identity: RecommendationRunIdentity;
  readonly provenance: RecommendationRunProvenance;
  readonly entries: readonly RecommendationEntry[];
}

export interface RecommendationRunWriter {
  findRun(identity: RecommendationRunIdentity): Promise<{ readonly runId: string } | undefined>;
  insertRun(
    input: RecommendationRunInsert,
  ): Promise<{ readonly runId: string; readonly inserted: boolean }>;
}

export interface LeagueRecomputeInput {
  readonly leagueSeasonId: string;
  readonly kinds: readonly RecommendationKind[];
  readonly claimedTeamIds: readonly string[];
  readonly buildSnapshot: (
    request: RecommendationSnapshotRequest,
  ) => Promise<RecommendationSnapshot | null>;
  readonly writer: RecommendationRunWriter;
  readonly signal: AbortSignal;
  readonly algorithmVersion?: string;
}

export interface LeagueRecomputeResult {
  readonly leagueSeasonId: string;
  readonly runs: readonly {
    readonly kind: RecommendationRunKind;
    readonly fantasyTeamId: string;
    readonly runId: string;
    readonly inserted: boolean;
  }[];
  readonly skipped: readonly { readonly fantasyTeamId: string; readonly reason: string }[];
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Recommendation recompute was aborted during shutdown");
}

/**
 * Resolves the requested job kinds to their in-season producers, rejecting by name rather than
 * quietly dropping one. `recommendationKinds` is iterated so a new kind added to the queue contract
 * without a producer here fails a type check rather than a production job.
 */
function resolveKinds(kinds: readonly RecommendationKind[]): readonly RecommendationRunKind[] {
  const resolved: RecommendationRunKind[] = [];
  for (const kind of [...new Set(kinds)].toSorted()) {
    if (!(recommendationKinds as readonly string[]).includes(kind)) {
      throw new Error(`Unsupported recommendation kind: ${kind}`);
    }
    const producer = inSeasonProducers[kind];
    if (!producer) throw new Error(`Unsupported recommendation kind: ${kind}`);
    resolved.push(producer);
  }
  return resolved;
}

export async function recomputeLeagueRecommendations(
  input: LeagueRecomputeInput,
): Promise<LeagueRecomputeResult> {
  const kinds = resolveKinds(input.kinds);
  const algorithmVersion = input.algorithmVersion ?? RECOMMENDATION_ALGORITHM_VERSION;
  const runs: {
    kind: RecommendationRunKind;
    fantasyTeamId: string;
    runId: string;
    inserted: boolean;
  }[] = [];
  const skipped: { fantasyTeamId: string; reason: string }[] = [];

  for (const fantasyTeamId of input.claimedTeamIds) {
    // Checked per team so a shutdown stops between teams rather than mid-league, leaving the
    // already-written runs valid and the remainder to the next job.
    assertNotAborted(input.signal);
    const snapshot = await input.buildSnapshot({
      leagueSeasonId: input.leagueSeasonId,
      fantasyTeamId,
      visibility: "league-only",
      signal: input.signal,
    });
    if (!snapshot) {
      skipped.push({ fantasyTeamId, reason: "SNAPSHOT_UNAVAILABLE" });
      continue;
    }

    for (const kind of kinds) {
      const checksumInput: RecommendationRunChecksumInput = {
        algorithmVersion,
        leagueSeasonId: input.leagueSeasonId,
        fantasyTeamId,
        kind,
        week: snapshot.week,
        scoringRulesChecksum: snapshot.scoringRulesChecksum,
        slotRulesChecksum: snapshot.slotRulesChecksum,
        rosterSnapshotIds: snapshot.rosterSnapshotIds,
        projectionSetIds: snapshot.projectionSetIds,
        marketSignalAsOf: snapshot.marketSignalAsOf,
        availabilityAsOf: snapshot.availabilityAsOf,
      };
      const identity: RecommendationRunIdentity = {
        leagueSeasonId: input.leagueSeasonId,
        fantasyTeamId,
        kind,
        algorithmVersion,
        inputChecksum: recommendationInputChecksum(checksumInput),
      };

      // Ask first. `recommendation_runs_identity_unique` is the second line of defense against a
      // concurrent duplicate, not the mechanism by which an ordinary replay stays idempotent.
      const existing = await input.writer.findRun(identity);
      if (existing) {
        runs.push({ kind, fantasyTeamId, runId: existing.runId, inserted: false });
        continue;
      }

      const provenance = recommendationRunProvenance({
        checksumInput,
        leagueLastSyncedAt: snapshot.leagueLastSyncedAt,
        rosterEffectiveAt: snapshot.rosterEffectiveAt,
        projectionFreshness: snapshot.projectionFreshness,
        warnings: [
          PRIVATE_PROJECTION_SETS_EXCLUDED,
          ...snapshot.warnings.filter((warning) => warning !== PRIVATE_PROJECTION_SETS_EXCLUDED),
        ],
      });
      const written = await input.writer.insertRun({
        identity,
        provenance,
        entries: snapshot.sections[kind],
      });
      runs.push({ kind, fantasyTeamId, runId: written.runId, inserted: written.inserted });
    }
  }

  return { leagueSeasonId: input.leagueSeasonId, runs, skipped };
}
