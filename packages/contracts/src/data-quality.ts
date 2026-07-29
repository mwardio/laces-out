import { z } from "zod";

/**
 * Wire contracts for source identity quality.
 *
 * `ENHANCEMENT_PLAN.md` §2.3 requires that ambiguous matches are quarantined rather than guessed,
 * that every ingestion reports rows read, rejected, and unmatched, and that a source-specific
 * match-rate threshold gates derived analysis. These schemas are the read side of that: the summary
 * every authenticated member may see, and the redacted unresolved sample only an administrator may
 * see.
 *
 * Kept in its own module so `index.ts` remains a re-export barrel.
 */

export const dataQualityAvailabilitySchema = z
  .object({
    state: z.enum(["available", "partial", "unavailable"]),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type DataQualityAvailability = z.infer<typeof dataQualityAvailabilitySchema>;

export const dataQualityDatasetSchema = z.enum([
  "weekly-stats",
  "weekly-rosters",
  "snap-counts",
  "injuries",
  "team-weekly-stats",
  "schedules",
  "adp",
  "other",
]);
export type DataQualityDataset = z.infer<typeof dataQualityDatasetSchema>;

export const dataQualitySourceSchema = z
  .object({
    key: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    dataset: dataQualityDatasetSchema,
    season: z.number().int().min(1999).max(2200).nullable(),
    admission: z.enum(["available", "unavailable", "quarantined"]),
    matchRate: z.number().min(0).max(1).nullable(),
    minimumMatchRate: z.number().min(0).max(1),
    thresholdRationale: z.string().min(1).max(300),
    meetsThreshold: z.boolean(),
    rowsRead: z.number().int().nonnegative().nullable(),
    rowsRejected: z.number().int().nonnegative().nullable(),
    rowsUnmatched: z.number().int().nonnegative().nullable(),
    lastSuccessfulAt: z.iso.datetime().nullable(),
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    /** Withheld derived surfaces, named so a member sees impact rather than a blank panel. */
    affectedAnalysis: z.array(z.string().min(1).max(120)).max(12),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type DataQualitySource = z.infer<typeof dataQualitySourceSchema>;

export const dataQualityResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    algorithmVersion: z.literal("data-quality-v1"),
    availability: dataQualityAvailabilitySchema,
    sources: z.array(dataQualitySourceSchema).max(64),
    degradedSourceKeys: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict();
export type DataQualityResponse = z.infer<typeof dataQualityResponseSchema>;

export const unresolvedIdentityWeekSchema = z
  .object({
    season: z.number().int().min(1999).max(2200),
    week: z.number().int().min(1).max(25),
    unresolvedRows: z.number().int().nonnegative(),
  })
  .strict();
export type UnresolvedIdentityWeek = z.infer<typeof unresolvedIdentityWeekSchema>;

/**
 * Redacted by construction: no free-text status, injury, or practice field is carried. `.strict()`
 * means a future addition fails parsing rather than leaking silently.
 */
export const unresolvedIdentitySampleSchema = z
  .object({
    season: z.number().int().min(1999).max(2200),
    week: z.number().int().min(1).max(25),
    externalPlayerId: z.string().min(1).max(64),
    team: z.string().min(2).max(4),
    position: z.string().min(1).max(16).nullable(),
  })
  .strict();
export type UnresolvedIdentitySample = z.infer<typeof unresolvedIdentitySampleSchema>;

const unresolvedIdentityWeeksSchema = dataQualityAvailabilitySchema.extend({
  rows: z.array(unresolvedIdentityWeekSchema).max(500),
});

const unresolvedIdentitySampleSectionSchema = dataQualityAvailabilitySchema.extend({
  rows: z.array(unresolvedIdentitySampleSchema).max(50),
});

export const unresolvedIdentityResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    algorithmVersion: z.literal("data-quality-v1"),
    source: dataQualitySourceSchema,
    weeks: unresolvedIdentityWeeksSchema,
    sample: unresolvedIdentitySampleSectionSchema,
  })
  .strict();
export type UnresolvedIdentityResponse = z.infer<typeof unresolvedIdentityResponseSchema>;
