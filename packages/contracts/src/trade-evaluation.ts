import { z } from "zod";

import {
  decisionExecutionSchema,
  freshnessSchema,
  projectionSourceObservedAtStatusSchema,
  tradePackageDecisionSchema,
  unavailableDecisionSectionSchema,
} from "./decision-primitives.js";

/**
 * Wire contract for `POST /v1/leagues/:leagueId/trade-evaluations` — the evaluation of a package the
 * user constructed, as opposed to one the bounded generator proposed.
 *
 * Its own module because `index.ts` is a re-export barrel, and because importing the shared decision
 * primitives from that barrel would read them in their temporal dead zone.
 */

/** Hard server-side bound; the client cannot widen it. */
export const MAX_TRADE_BUILDER_PLAYERS_PER_SIDE = 4;

const builderSidePlayerIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(MAX_TRADE_BUILDER_PLAYERS_PER_SIDE);

export const tradeEvaluationRequestSchema = z
  .object({
    opponentTeamId: z.string().uuid(),
    sendsPlayerIds: builderSidePlayerIdsSchema,
    receivesPlayerIds: builderSidePlayerIdsSchema,
  })
  .strict()
  .refine((value) => new Set(value.sendsPlayerIds).size === value.sendsPlayerIds.length, {
    message: "A player cannot be sent twice in one package",
    path: ["sendsPlayerIds"],
  })
  .refine((value) => new Set(value.receivesPlayerIds).size === value.receivesPlayerIds.length, {
    message: "A player cannot be received twice in one package",
    path: ["receivesPlayerIds"],
  })
  .refine((value) => !value.sendsPlayerIds.some((id) => value.receivesPlayerIds.includes(id)), {
    message: "A player cannot appear on both sides of a package",
    path: ["receivesPlayerIds"],
  });
export type TradeEvaluationRequest = z.infer<typeof tradeEvaluationRequestSchema>;

/**
 * One code covers both roster-membership failures on purpose: an endpoint that answered differently
 * for "not on that roster" than for "no such player" would be a roster-probing oracle.
 */
export const tradeBuilderRejectionCodeSchema = z.enum([
  "OPPONENT_NOT_IN_LEAGUE",
  "PLAYER_NOT_ON_ROSTER",
]);
export type TradeBuilderRejectionCode = z.infer<typeof tradeBuilderRejectionCodeSchema>;

export const tradeEvaluationDiagnosticSchema = z
  .object({
    code: z.enum([
      "INVALID_TRADE",
      "UNKNOWN_TRADED_PLAYER",
      "DUPLICATE_TRADED_PLAYER",
      "NO_LEGAL_FORCED_DROP",
      "ILLEGAL_RESULTING_ROSTER",
    ]),
    message: z.string().min(1),
    teamId: z.string().uuid().nullable(),
    playerId: z.string().uuid().nullable(),
  })
  .strict();
export type TradeEvaluationDiagnostic = z.infer<typeof tradeEvaluationDiagnosticSchema>;

export const tradeEvaluationHorizonSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    weight: z.number().finite().positive(),
  })
  .strict();
export type TradeEvaluationHorizon = z.infer<typeof tradeEvaluationHorizonSchema>;

/**
 * Why rest-of-season value was not blended in. Never null while the response carries a single
 * weekly horizon, so a weekly-only answer can never read as a multi-horizon one.
 */
export const tradeRosUnavailableSchema = z
  .object({
    code: z.enum([
      "ROS_RELEASE_STATUS_UNAVAILABLE",
      "ROS_SET_UNAVAILABLE",
      "ROS_SET_INCOMPATIBLE",
      "ROS_SET_STALE",
    ]),
    message: z.string().min(1),
  })
  .strict();
export type TradeRosUnavailable = z.infer<typeof tradeRosUnavailableSchema>;

const tradeEvaluationProvenanceSchema = z
  .object({
    leagueLastSyncedAt: z.iso.datetime().nullable(),
    rosterEffectiveAt: z.iso.datetime().nullable(),
    projectionSet: z
      .object({
        id: z.string().uuid(),
        source: z.string().min(1),
        version: z.string().min(1),
        horizon: z.string().min(1),
        sourceObservedAt: z.iso.datetime().nullable(),
        sourceObservedAtStatus: projectionSourceObservedAtStatusSchema,
        importedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    projectionFreshness: freshnessSchema,
  })
  .strict();

export const tradeEvaluationResponseSchema = z.discriminatedUnion("state", [
  unavailableDecisionSectionSchema,
  z
    .object({
      state: z.literal("available"),
      generatedAt: z.iso.datetime(),
      league: z.object({ id: z.string().uuid(), name: z.string().min(1) }).strict(),
      /** ADR 0003: every recommendation-shaped output retains its algorithm version… */
      algorithmVersion: z.string().min(1).max(120),
      /** …and the checksum of the inputs it was computed from. */
      inputChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      legal: z.boolean(),
      package: tradePackageDecisionSchema.nullable(),
      diagnostics: z.array(tradeEvaluationDiagnosticSchema).max(16),
      horizons: z.array(tradeEvaluationHorizonSchema).min(1).max(4),
      rosUnavailable: tradeRosUnavailableSchema.nullable(),
      provenance: tradeEvaluationProvenanceSchema,
      execution: decisionExecutionSchema,
      notes: z.array(z.string()).max(8),
    })
    .strict(),
]);
export type TradeEvaluationResponse = z.infer<typeof tradeEvaluationResponseSchema>;
export type AvailableTradeEvaluation = Extract<TradeEvaluationResponse, { state: "available" }>;

/**
 * API-internal outcome union. It has no wire schema because the route maps each arm to a distinct
 * HTTP status; only the `evaluated` arm's payload is serialized.
 */
export type TradeEvaluationOutcome =
  | { readonly outcome: "not-found" }
  | { readonly outcome: "rejected"; readonly code: TradeBuilderRejectionCode }
  | { readonly outcome: "evaluated"; readonly response: TradeEvaluationResponse };
