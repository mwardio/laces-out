import { z } from "zod";

import { freshnessSchema } from "./decision-primitives.js";

/**
 * The persisted shape of a `recommendation_runs` row's provenance.
 *
 * ADR 0003 requires every recommendation to retain the settings, input versions, algorithm version,
 * input hash, and seed it was computed from. `schedule-edge`, `draft-analysis`, and
 * `trade-evaluation` already express the response side of that as `algorithmVersion` plus a 64-hex
 * `inputChecksum` beside data-freshness provenance; this module is the same quartet for the *stored*
 * side, so a run written by the worker and a report returned by the API describe reproducibility the
 * same way.
 *
 * WP4 writes these rows; WP5's change-event feed is the reader. There is deliberately no read route
 * yet — a persisted run computed league-wide legitimately differs from what a user holding a private
 * projection set sees on demand, and that difference needs a designed explanation before it is
 * exposed.
 */

/** The recommendation kinds an in-season recompute can produce. `draft` has no in-season producer. */
export const recommendationRunKindSchema = z.enum(["lineup", "waiver", "trade"]);
export type RecommendationRunKind = z.infer<typeof recommendationRunKindSchema>;

const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const idListSchema = z.array(z.string().min(1)).max(64);

/**
 * The jsonb bundle stored in `recommendation_runs.inputs`. Every field here is also covered by the
 * input checksum, so a stored run can be re-derived and compared rather than merely trusted.
 */
export const recommendationRunInputsSchema = z
  .object({
    week: z.number().int().min(0).max(25).nullable(),
    scoringRulesChecksum: z.string().min(1).max(120).nullable(),
    slotRulesChecksum: z.string().min(1).max(120).nullable(),
    rosterSnapshotIds: idListSchema,
    projectionSetIds: idListSchema,
    marketSignalAsOf: z.iso.datetime().nullable(),
    availabilityAsOf: z.iso.datetime().nullable(),
    leagueLastSyncedAt: z.iso.datetime().nullable(),
    rosterEffectiveAt: z.iso.datetime().nullable(),
    freshness: freshnessSchema,
  })
  .strict();
export type RecommendationRunInputs = z.infer<typeof recommendationRunInputsSchema>;

export const recommendationRunProvenanceSchema = z
  .object({
    /** ADR 0003: every recommendation-shaped output retains its algorithm version… */
    algorithmVersion: z.string().min(1).max(120),
    /** …and the checksum of the inputs it was computed from. */
    inputChecksum: checksumSchema,
    /** Null and honestly so: the lineup, waiver, and trade engines are deterministic. */
    randomSeed: z.string().min(1).max(120).nullable(),
    inputs: recommendationRunInputsSchema,
    warnings: z.array(z.string().min(1).max(200)).max(32),
  })
  .strict();
export type RecommendationRunProvenance = z.infer<typeof recommendationRunProvenanceSchema>;
