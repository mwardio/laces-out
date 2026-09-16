import { createHash } from "node:crypto";

import {
  recommendationRunProvenanceSchema,
  type Freshness,
  type RecommendationRunInputs,
  type RecommendationRunKind,
  type RecommendationRunProvenance,
} from "@laces-out/contracts";

/**
 * Replay identity and ADR 0003 provenance for a persisted recommendation run.
 *
 * The identity has to be strong enough that "the same inputs" can never write a second row and
 * "different inputs" can never collide onto an existing one, because
 * `recommendation_runs_identity_unique` and WP5's prior-run comparison both rest on it.
 */

/**
 * Bumping this invalidates every stored run without deleting one: the checksum includes the version,
 * so an upgraded algorithm cannot replay a stale row and cannot be mistaken for the old one when
 * WP5 diffs consecutive runs.
 */
export const RECOMMENDATION_ALGORITHM_VERSION = "in-season-decisions-v7";

/**
 * What a digest is computed *for*.
 *
 * A persisted run is one of the three run kinds. `decision-snapshot` is the on-demand
 * `InSeasonDecisionSnapshot`, which answers all three at once from one set of inputs. Naming it here
 * rather than borrowing a run kind keeps the two digests namespaced apart: a snapshot checksum can
 * never collide with — or be mistaken for — a stored `recommendation_runs.input_hash`.
 */
export type RecommendationChecksumScope = RecommendationRunKind | "decision-snapshot";

export interface RecommendationChecksumInput {
  readonly algorithmVersion: string;
  /** Null only before a league season is synced, which no persisted run can be. */
  readonly leagueSeasonId: string | null;
  /** Null only before the member claims a team, which no persisted run can be. */
  readonly fantasyTeamId: string | null;
  readonly kind: RecommendationChecksumScope;
  readonly week: number | null;
  readonly scoringRulesChecksum: string | null;
  readonly slotRulesChecksum: string | null;
  readonly rosterSnapshotIds: readonly string[];
  readonly projectionSetIds: readonly string[];
  readonly marketSignalAsOf: string | null;
  readonly availabilityAsOf: string | null;
  /** Additional exact input identities used by Decision Desk's richer on-demand computation. */
  readonly scoringProfileChecksum?: string | null;
  readonly marketSignalsChecksum?: string | null;
  readonly availabilityChecksum?: string | null;
  readonly modeledFactsChecksum?: string | null;
  /** The authoritative Decision Desk input identity from which a persisted run was materialized. */
  readonly sourceSnapshotChecksum?: string | null;
}

/** The narrower input a persisted `recommendation_runs` row is identified by. */
export interface RecommendationRunChecksumInput extends RecommendationChecksumInput {
  readonly leagueSeasonId: string;
  readonly fantasyTeamId: string;
  readonly kind: RecommendationRunKind;
}

export interface RecommendationRunIdentity {
  readonly leagueSeasonId: string;
  readonly fantasyTeamId: string;
  readonly kind: RecommendationRunKind;
  readonly algorithmVersion: string;
  readonly inputChecksum: string;
}

/**
 * Length-prefix every component. A plain join lets a field boundary move without changing the
 * digest — `["a","b"] + ["c"]` and `["a"] + ["b","c"]` would hash identically — which would silently
 * suppress a legitimate recompute.
 */
function field(value: string | number | null): string {
  if (value === null) return "\0null:";
  const text = typeof value === "number" ? `n${value}` : `s${value}`;
  return `${text.length}:${text}`;
}

function idField(values: readonly string[]): string {
  // Sorted, so an equivalent set in a different query order is the same run rather than a new one.
  const sorted = [...values].toSorted();
  return `${sorted.length}#${sorted.map((value) => field(value)).join("")}`;
}

/** Deterministic, order-insensitive over id lists, and sensitive to every material input. */
export function recommendationInputChecksum(input: RecommendationChecksumInput): string {
  const canonical = [
    field(input.algorithmVersion),
    field(input.leagueSeasonId),
    field(input.fantasyTeamId),
    field(input.kind),
    field(input.week),
    field(input.scoringRulesChecksum),
    field(input.slotRulesChecksum),
    idField(input.rosterSnapshotIds),
    idField(input.projectionSetIds),
    field(input.marketSignalAsOf),
    field(input.availabilityAsOf),
    field(input.scoringProfileChecksum ?? null),
    field(input.marketSignalsChecksum ?? null),
    field(input.availabilityChecksum ?? null),
    field(input.modeledFactsChecksum ?? null),
    field(input.sourceSnapshotChecksum ?? null),
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function recommendationRunIdentity(
  input: RecommendationRunChecksumInput,
): RecommendationRunIdentity {
  return {
    leagueSeasonId: input.leagueSeasonId,
    fantasyTeamId: input.fantasyTeamId,
    kind: input.kind,
    algorithmVersion: input.algorithmVersion,
    inputChecksum: recommendationInputChecksum(input),
  };
}

export interface RecommendationRunProvenanceInput {
  readonly checksumInput: RecommendationRunChecksumInput;
  readonly leagueLastSyncedAt: string | null;
  readonly rosterEffectiveAt: string | null;
  readonly projectionFreshness: Freshness;
  readonly warnings: readonly string[];
}

/**
 * Assembles the ADR 0003 quartet — algorithm version, input checksum, data freshness, warnings —
 * in the same shape `schedule-edge`, `draft-analysis`, and `trade-evaluation` already use, and
 * validates it, so a malformed bundle fails at the write rather than at WP5's read.
 */
export function recommendationRunProvenance(
  input: RecommendationRunProvenanceInput,
): RecommendationRunProvenance {
  const checksumInput = input.checksumInput;
  const inputs: RecommendationRunInputs = {
    week: checksumInput.week,
    scoringRulesChecksum: checksumInput.scoringRulesChecksum,
    slotRulesChecksum: checksumInput.slotRulesChecksum,
    rosterSnapshotIds: [...checksumInput.rosterSnapshotIds].toSorted(),
    projectionSetIds: [...checksumInput.projectionSetIds].toSorted(),
    marketSignalAsOf: checksumInput.marketSignalAsOf,
    availabilityAsOf: checksumInput.availabilityAsOf,
    sourceSnapshotChecksum: checksumInput.sourceSnapshotChecksum ?? null,
    leagueLastSyncedAt: input.leagueLastSyncedAt,
    rosterEffectiveAt: input.rosterEffectiveAt,
    freshness: input.projectionFreshness,
  };
  return recommendationRunProvenanceSchema.parse({
    algorithmVersion: checksumInput.algorithmVersion,
    inputChecksum: recommendationInputChecksum(checksumInput),
    // The engines are deterministic. ADR 0003 requires a seed only for stochastic algorithms, and an
    // invented one here would be misleading provenance rather than reproducibility.
    randomSeed: null,
    inputs,
    warnings: [...input.warnings],
  } satisfies RecommendationRunProvenance);
}
