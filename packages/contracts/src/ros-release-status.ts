import { z } from "zod";

/**
 * Wire contract for rest-of-season release observability.
 *
 * Six independent facts decide whether a league sees a rest-of-season forecast, and they fail for
 * unrelated reasons. Collapsing them into one red/green word already produced a wrong conclusion —
 * that all ROS publication was disabled — while an admitted, release-capable artifact existed. Each
 * fact therefore gets its own field here, and `RosReleaseStatus` deliberately carries no overall
 * verdict for a caller to read instead:
 *
 * 1. `admittedArtifacts` — which immutable champion artifacts have been admitted.
 * 2. `scoringProfiles`   — which scoring profiles that evidence actually covers.
 * 3. `leagueReadiness`   — whether the caller's own league inputs are complete.
 * 4. `cellGates`         — what the live per-position/horizon gate decided most recently.
 * 5. `publishedSets`     — what each league actually holds, including a retained last-good set.
 * 6. `shadowAudit`       — the independent audit rail, which is never evidence about 1–5.
 *
 * Kept in its own module so `index.ts` remains a re-export barrel.
 */

/**
 * Structured reasons a league's rest-of-season set is withheld. Order is fixed and load bearing:
 * producers emit in this order so a rendered reason list is stable between requests.
 */
export const ROS_WITHHOLDING_REASONS = [
  "scoring-rules-unsupported",
  "no-admitted-scoring-profile",
  "incomplete-schedule",
  "missing-roster-snapshot",
  "insufficient-candidate-inputs",
  "non-converged-cell",
  "stale-source",
  "no-league-synced",
] as const;

export const rosWithholdingReasonSchema = z.enum(ROS_WITHHOLDING_REASONS);
export type RosWithholdingReason = z.infer<typeof rosWithholdingReasonSchema>;

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * A scoring profile's identity. `scoringProfileKey` is the canonical semantic key admission and
 * publication compare byte for byte; `digest` is its sha256, carried only because the key itself
 * runs to well over a thousand characters and is unreadable in a UI.
 */
export const rosScoringProfileIdentitySchema = z
  .object({
    profileId: z.string().min(1).max(128),
    label: z.string().min(1).max(64),
    scoringProfileKey: z.string().min(1).max(8192),
    digest: z.string().regex(SHA256),
  })
  .strict();
export type RosScoringProfileIdentity = z.infer<typeof rosScoringProfileIdentitySchema>;

/** 1. Admitted artifact state. One artifact per admitted scoring profile. */
export const rosAdmittedArtifactSchema = z
  .object({
    scoringProfile: rosScoringProfileIdentitySchema,
    season: z.number().int().min(1999).max(2200),
    modelVersion: z.string().min(1).max(200),
    policyVersion: z.string().min(1).max(200),
    calibrationVersion: z.string().min(1).max(200),
    evidenceThroughSeason: z.number().int().min(1999).max(2200),
    artifactChecksum: z.string().regex(SHA256),
    admittedAt: z.iso.datetime(),
    sourceChecksumCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();
export type RosAdmittedArtifact = z.infer<typeof rosAdmittedArtifactSchema>;

export const rosAdmittedArtifactStateSchema = z
  .object({
    state: z.enum(["admitted", "none"]),
    artifacts: z.array(rosAdmittedArtifactSchema).max(8),
  })
  .strict();
export type RosAdmittedArtifactState = z.infer<typeof rosAdmittedArtifactStateSchema>;

/**
 * 2. Supported scoring-profile identity. A profile that failed validation stays here with its
 * blockers and the report they came from — a failure is evidence, not an omission.
 */
export const rosUnsupportedScoringProfileSchema = z
  .object({
    profile: rosScoringProfileIdentitySchema,
    blockers: z.array(z.string().min(1).max(200)).max(64),
    evidenceReport: z.string().min(1).max(300).nullable(),
  })
  .strict();
export type RosUnsupportedScoringProfile = z.infer<typeof rosUnsupportedScoringProfileSchema>;

export const rosScoringProfileCoverageSchema = z
  .object({
    // `deriveScoringProfileCoverage` (apps/api) iterates the whole `rosScoringProfileCatalog()`
    // uncapped and splits every entry into `supported` or `unsupported` — the two arrays together
    // always equal the catalog size, never a request-scoped or evidence-scoped count. The catalog
    // is a small, hand-curated list of scoring-rule shapes (5 entries as of this session, started
    // at 3) but grows over time; capping here would silently blank real catalog profiles out of
    // the response rather than truncate noisy evidence, so the bound stays generous headroom
    // rather than tracking the current catalog size.
    supported: z.array(rosScoringProfileIdentitySchema).max(64),
    unsupported: z.array(rosUnsupportedScoringProfileSchema).max(64),
  })
  .strict();
export type RosScoringProfileCoverage = z.infer<typeof rosScoringProfileCoverageSchema>;

/**
 * Position-scoped readiness within one league, mirroring `RosCellGateDecision`'s vocabulary.
 * `reasons` distinguishes two causes: `position-unsupported` is followed by the normalization
 * messages that made this position unscoreable; `scoring-profile-position-mismatch` means the
 * position normalizes fine but its scoped rules do not equal any admitted artifact's scoped rules.
 * Reported for all six positions on every league, `DST` included: this field states normalization
 * and catalog-match truth for a position, not whether the ROS rail currently ships that position's
 * forecasts (today only QB/RB/WR/TE/K).
 */
export const rosLeaguePositionReadinessSchema = z
  .object({
    position: z.enum(["QB", "RB", "WR", "TE", "K", "DST"]),
    decision: z.enum(["ready", "withheld"]),
    reasons: z.array(z.string().min(1).max(400)).max(32),
  })
  .strict();
export type RosLeaguePositionReadiness = z.infer<typeof rosLeaguePositionReadinessSchema>;

/** 3. League input readiness. `leagueSeasonId` is null only for the no-league-synced case. */
export const rosLeagueReadinessSchema = z
  .object({
    leagueSeasonId: z.string().min(1).max(64).nullable(),
    /** The league's own name, so a reader can recognize their league without decoding an id. */
    leagueName: z.string().min(1).max(200).nullable(),
    state: z.enum(["ready", "withheld"]),
    reasons: z.array(rosWithholdingReasonSchema).max(8),
    scoringProfile: rosScoringProfileIdentitySchema.nullable(),
    positions: z.array(rosLeaguePositionReadinessSchema).max(6),
  })
  .strict();
export type RosLeagueReadiness = z.infer<typeof rosLeagueReadinessSchema>;

/** 4. Live per-cell gate decisions from the most recent release evaluation. */
export const rosCellGateDecisionSchema = z
  .object({
    position: z.enum(["QB", "RB", "WR", "TE", "K", "DST"]),
    bucket: z.enum(["one-to-four", "five-to-eight", "nine-plus"]),
    decision: z.enum(["released", "withheld"]),
    reasons: z.array(z.string().min(1).max(120)).max(16),
  })
  .strict();
export type RosCellGateDecision = z.infer<typeof rosCellGateDecisionSchema>;

export const rosCellGateStateSchema = z
  .object({
    state: z.enum(["evaluated", "none"]),
    evaluatedAt: z.iso.datetime().nullable(),
    cells: z.array(rosCellGateDecisionSchema).max(18),
  })
  .strict();
export type RosCellGateState = z.infer<typeof rosCellGateStateSchema>;

/**
 * 5. Latest published league set. `retainedFromEarlierRun` is true when the newest evaluation
 * withheld and this set is the last good one being preserved, so the UI can say so rather than
 * implying the set is fresh.
 */
export const rosPublishedLeagueSetSchema = z
  .object({
    projectionSetId: z.string().min(1).max(64),
    leagueSeasonId: z.string().min(1).max(64),
    leagueName: z.string().min(1).max(200).nullable(),
    scoringProfile: rosScoringProfileIdentitySchema.nullable(),
    season: z.number().int().min(1999).max(2200),
    playerCount: z.number().int().nonnegative().max(10_000),
    windowStartWeek: z.number().int().min(0).max(25),
    windowEndWeek: z.number().int().min(0).max(25),
    asOfWeek: z.number().int().min(-1).max(25),
    fetchedAt: z.iso.datetime(),
    inputChecksum: z.string().min(1).max(128),
    championArtifactChecksum: z.string().min(1).max(128).nullable(),
    retainedFromEarlierRun: z.boolean(),
  })
  .strict();
export type RosPublishedLeagueSet = z.infer<typeof rosPublishedLeagueSetSchema>;

/**
 * 6. The independent shadow audit. It records deliberately degraded diagnostics for audit history
 * and is never an input to any field above; a degraded audit says nothing about whether an admitted
 * artifact is release capable.
 */
export const rosShadowAuditRunSchema = z
  .object({
    sourceSyncRunId: z.string().min(1).max(64),
    mode: z.string().min(1).max(32),
    qualityState: z.string().min(1).max(32),
    createdAt: z.iso.datetime(),
    reasons: z.array(z.string().min(1).max(120)).max(32),
  })
  .strict();
export type RosShadowAuditRun = z.infer<typeof rosShadowAuditRunSchema>;

export const rosShadowAuditStateSchema = z
  .object({
    state: z.enum(["recorded", "none"]),
    latestRun: rosShadowAuditRunSchema.nullable(),
  })
  .strict();
export type RosShadowAuditState = z.infer<typeof rosShadowAuditStateSchema>;

/**
 * The complete status. There is intentionally no top-level verdict field; a caller that needs one
 * must decide which of the six facts it actually cares about.
 */
export const rosReleaseStatusSchema = z
  .object({
    season: z.number().int().min(1999).max(2200),
    modelVersion: z.string().min(1).max(200),
    admittedArtifacts: rosAdmittedArtifactStateSchema,
    scoringProfiles: rosScoringProfileCoverageSchema,
    leagueReadiness: z.array(rosLeagueReadinessSchema).max(64),
    cellGates: rosCellGateStateSchema,
    publishedSets: z.array(rosPublishedLeagueSetSchema).max(64),
    shadowAudit: rosShadowAuditStateSchema,
  })
  .strict();
export type RosReleaseStatus = z.infer<typeof rosReleaseStatusSchema>;

/** Parses an untrusted payload. Returns null rather than throwing so callers can render an error. */
export function parseRosReleaseStatus(value: unknown): RosReleaseStatus | null {
  const result = rosReleaseStatusSchema.safeParse(value);
  return result.success ? result.data : null;
}
