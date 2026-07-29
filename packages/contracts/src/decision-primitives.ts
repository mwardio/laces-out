import { z } from "zod";

/**
 * Primitives shared by the in-season decision snapshot and the trade builder.
 *
 * These live in a leaf module rather than in `index.ts` because `index.ts` re-exports the builder
 * contract, and ES module import hoisting evaluates a child module before its parent — a
 * `trade-evaluation.ts` that imported these from `./index.js` would read them in their temporal
 * dead zone. Nothing here imports another contract module.
 */

// Mirrored rather than imported so the browser contract bundle keeps no runtime dependency on the
// domain package. Response parsing fails closed if service vocabulary ever drifts from these lists.
const NFL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST", "DL", "LB", "DB", "IDP"] as const;
const NFL_TEAMS = [
  "ARI",
  "ATL",
  "BAL",
  "BUF",
  "CAR",
  "CHI",
  "CIN",
  "CLE",
  "DAL",
  "DEN",
  "DET",
  "GB",
  "HOU",
  "IND",
  "JAX",
  "KC",
  "LV",
  "LAC",
  "LAR",
  "MIA",
  "MIN",
  "NE",
  "NO",
  "NYG",
  "NYJ",
  "PHI",
  "PIT",
  "SEA",
  "SF",
  "TB",
  "TEN",
  "WAS",
] as const;
const PLAYER_STATUSES = [
  "ACTIVE",
  "QUESTIONABLE",
  "DOUBTFUL",
  "OUT",
  "IR",
  "PUP",
  "SUSPENDED",
  "NA",
  "UNKNOWN",
] as const;

export const providerSchema = z.enum(["yahoo", "espn", "manual"]);
export type Provider = z.infer<typeof providerSchema>;

export const freshnessSchema = z.object({
  state: z.enum(["fresh", "aging", "stale", "missing"]),
  observedAt: z.iso.datetime().nullable(),
  label: z.string(),
});
export type Freshness = z.infer<typeof freshnessSchema>;

export const projectionSourceObservedAtStatusSchema = z.enum(["verified", "unverified"]);
export type ProjectionSourceObservedAtStatus = z.infer<
  typeof projectionSourceObservedAtStatusSchema
>;

export const decisionUnavailableCodeSchema = z.enum([
  "NO_SEASON",
  "TEAM_UNCLAIMED",
  "CLAIMED_TEAM_NOT_IN_SEASON",
  "ROSTER_MISSING",
  "ROSTER_INCOMPLETE",
  "SLOT_RULES_MISSING",
  "SLOT_RULES_UNSUPPORTED",
  "PROJECTIONS_MISSING",
  "PROJECTION_COVERAGE_INCOMPLETE",
  "OPPONENT_DATA_MISSING",
  "CANDIDATE_POOL_EMPTY",
  "LEAGUE_SIZE_UNSUPPORTED",
  "ENGINE_INFEASIBLE",
]);
export type DecisionUnavailableCode = z.infer<typeof decisionUnavailableCodeSchema>;

export const decisionUnavailableReasonSchema = z
  .object({
    code: decisionUnavailableCodeSchema,
    message: z.string().min(1),
  })
  .strict();
export type DecisionUnavailableReason = z.infer<typeof decisionUnavailableReasonSchema>;

export const decisionPlayerSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    positions: z.array(z.enum(NFL_POSITIONS)).min(1),
    nflTeam: z.enum(NFL_TEAMS).nullable(),
    status: z.enum(PLAYER_STATUSES).nullable(),
    projectedPoints: z.number().finite(),
  })
  .strict();
export type DecisionPlayer = z.infer<typeof decisionPlayerSchema>;

export const unavailableDecisionSectionSchema = z
  .object({
    state: z.literal("unavailable"),
    reasons: z.array(decisionUnavailableReasonSchema).min(1),
  })
  .strict();

export const decisionExecutionSchema = z
  .object({
    mode: z.literal("provider-required"),
    provider: providerSchema,
    label: z.string().min(1),
    url: z.url().nullable(),
  })
  .strict();

/**
 * Widened to four players per side for the trade builder. Generation still only produces the three
 * legacy shapes; a regression test in `apps/api` proves the wider schema did not widen the
 * generator.
 */
export const tradePackageDecisionSchema = z
  .object({
    id: z.string().min(1),
    partner: z.object({ id: z.string().uuid(), name: z.string().min(1) }).strict(),
    shape: z.string().regex(/^[1-4]-for-[1-4]$/u),
    send: z.array(decisionPlayerSchema).min(1).max(4),
    receive: z.array(decisionPlayerSchema).min(1).max(4),
    forcedDropsForUser: z.array(decisionPlayerSchema).max(4),
    forcedDropsForPartner: z.array(decisionPlayerSchema).max(4),
    userGain: z.number().finite(),
    partnerGain: z.number().finite(),
    totalGain: z.number().finite(),
    fairnessGap: z.number().finite().nonnegative(),
    mutuallyBeneficial: z.boolean(),
  })
  .strict();
