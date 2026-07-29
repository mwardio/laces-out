import { z } from "zod";

/**
 * Wire contract for `GET /v1/drafts/:draftId/analysis`.
 *
 * The engine (`@fantasy/engine-draft`) owns the analysis shapes; this module is the browser-facing
 * mirror of them plus the provenance envelope the engine has no way to know about — which market
 * baseline was admitted, which projection set was selected, and why either one is missing. It is a
 * separate module because `index.ts` is a re-export barrel, not a home for new domains.
 */

// Mirrored rather than imported so the browser contract bundle keeps no runtime dependency on the
// domain package. Response parsing fails closed if engine vocabulary ever drifts from this list.
const NFL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST", "DL", "LB", "DB", "IDP"] as const;
const ROSTER_SLOT_TYPES = [
  "QB",
  "RB",
  "WR",
  "TE",
  "FLEX",
  "REC_FLEX",
  "SUPER_FLEX",
  "OP",
  "K",
  "DST",
  "DL",
  "DB",
  "LB",
  "IDP_FLEX",
  "BENCH",
  "IR",
  "TAXI",
] as const;

const analysisUuidSchema = z.string().uuid();
const analysisChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const analysisTimestampSchema = z.iso.datetime();
const analysisCountSchema = z.number().int().nonnegative().max(1_000_000);
/** Event ids are provider-scoped strings such as `manual:0001`, never UUIDs. */
const analysisEventIdSchema = z.string().min(1).max(200);
const analysisLabelSchema = z.string().min(1).max(400);
const analysisDetailSchema = z.string().min(1).max(2_000);

const analysisWarningSchema = z
  .object({ code: z.string().min(1).max(120), message: analysisDetailSchema })
  .strict();

const analysisWarningsSchema = z.array(analysisWarningSchema).max(40);

const rosterConstructionSchema = z
  .object({
    rosteredPlayers: analysisCountSchema,
    totalRosterSlots: analysisCountSchema,
    openRosterSlots: analysisCountSchema,
    starterSlots: analysisCountSchema,
    coveredStarterSlots: analysisCountSchema,
    openStarterSlots: z
      .array(
        z
          .object({
            slotId: z.string().min(1).max(200),
            type: z.enum(ROSTER_SLOT_TYPES),
            eligiblePositions: z.array(z.enum(NFL_POSITIONS)).min(1).max(NFL_POSITIONS.length),
          })
          .strict(),
      )
      .max(64),
    primaryPositionCounts: z
      .array(z.object({ position: z.enum(NFL_POSITIONS), count: analysisCountSchema }).strict())
      .max(NFL_POSITIONS.length),
    warnings: analysisWarningsSchema,
  })
  .strict();

const rosterNeedSchema = z
  .object({
    starterCoverageBefore: analysisCountSchema,
    starterCoverageAfter: analysisCountSchema,
    filledOpenStarterSlot: z.boolean(),
  })
  .strict();

const teamStrengthSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("AVAILABLE"),
      projectedRosterPoints: z.number(),
      projectedStarterPoints: z.number(),
      projectedStarterPlayerIds: z.array(analysisUuidSchema).max(64),
      leagueRank: analysisCountSchema,
      rankedTeamCount: analysisCountSchema,
      basis: z.literal("CURRENT_ROSTER"),
      warnings: analysisWarningsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("UNAVAILABLE"),
      reason: z.enum([
        "NO_PROJECTIONS",
        "MISSING_LEAGUE_SCORING_PROFILE",
        "INCOMPATIBLE_SCORING_PROFILE",
        "EMPTY_ROSTER",
        "MISSING_PLAYER_PROJECTIONS",
      ]),
      missingPlayerIds: z.array(analysisUuidSchema).max(64),
      message: analysisDetailSchema,
    })
    .strict(),
]);

const snakeMissedAlternativeSchema = z
  .object({
    playerId: analysisUuidSchema,
    name: analysisLabelSchema,
    adp: z.number(),
    adpAdvantage: z.number(),
    tier: z.number().nullable(),
    outcome: z.enum(["DRAFTED_LATER_BY_OPPONENT", "UNDRAFTED_AT_ANALYSIS"]),
    laterOverallPick: z.number().nullable(),
    laterTeamId: analysisUuidSchema.nullable(),
  })
  .strict();

const snakeSelectionSchema = z
  .object({
    eventId: analysisEventIdSchema,
    acquisition: z.enum(["SNAKE_PICK", "SNAKE_KEEPER"]),
    playerId: analysisUuidSchema,
    playerName: analysisLabelSchema,
    overallPick: z.number(),
    market: z
      .object({
        status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
        adp: z.number().nullable(),
        /** Positive means selected after ADP; negative means before ADP. */
        pickVsAdp: z.number().nullable(),
        classification: z.enum(["VALUE", "AT_MARKET", "REACH", "UNAVAILABLE"]),
        classificationThresholdPicks: z.number(),
      })
      .strict(),
    rosterNeed: rosterNeedSchema,
    opportunityCost: z
      .object({
        selectedTier: z.number().nullable(),
        bestAvailableTier: z.number().nullable(),
        tierGap: z.number().nullable(),
        bestAvailableAdp: z.number().nullable(),
        adpCost: z.number().nullable(),
      })
      .strict(),
    missedAlternatives: z.array(snakeMissedAlternativeSchema).max(20),
    warnings: analysisWarningsSchema,
  })
  .strict();

const auctionMissedAlternativeSchema = z
  .object({
    playerId: analysisUuidSchema,
    name: analysisLabelSchema,
    baselineValue: z.number(),
    laterPrice: z.number(),
    valueAtLaterPrice: z.number(),
    surplusAdvantage: z.number(),
    laterTeamId: analysisUuidSchema,
  })
  .strict();

const auctionPurchaseSchema = z
  .object({
    eventId: analysisEventIdSchema,
    acquisition: z.enum(["AUCTION", "AUCTION_KEEPER"]),
    playerId: analysisUuidSchema,
    playerName: analysisLabelSchema,
    price: z.number(),
    market: z
      .object({
        status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
        baselineValue: z.number().nullable(),
        /** Positive is value gained; negative is an overpay against the admitted baseline. */
        surplus: z.number().nullable(),
        classification: z.enum(["VALUE", "AT_MARKET", "OVERPAY", "UNAVAILABLE"]),
        classificationThresholdDollars: z.number(),
      })
      .strict(),
    legality: z
      .object({
        maximumLegalBidBeforePurchase: z.number(),
        withinMaximumBid: z.boolean(),
        remainingBudgetBeforePurchase: z.number(),
        openSlotsBeforePurchase: z.number(),
      })
      .strict(),
    rosterNeed: rosterNeedSchema,
    missedAlternatives: z.array(auctionMissedAlternativeSchema).max(20),
    warnings: analysisWarningsSchema,
  })
  .strict();

const snakeTeamSchema = z
  .object({
    mode: z.literal("SNAKE"),
    teamId: analysisUuidSchema,
    name: analysisLabelSchema,
    roster: rosterConstructionSchema,
    selections: z.array(snakeSelectionSchema).max(60),
    marketSummary: z
      .object({
        status: z.enum(["AVAILABLE", "PARTIAL", "UNAVAILABLE"]),
        coveredSelections: analysisCountSchema,
        totalSelections: analysisCountSchema,
        averagePickVsAdp: z.number().nullable(),
        values: analysisCountSchema,
        reaches: analysisCountSchema,
      })
      .strict(),
    teamStrength: teamStrengthSchema,
    warnings: analysisWarningsSchema,
  })
  .strict();

const auctionTeamSchema = z
  .object({
    mode: z.literal("AUCTION"),
    teamId: analysisUuidSchema,
    name: analysisLabelSchema,
    roster: rosterConstructionSchema,
    purchases: z.array(auctionPurchaseSchema).max(60),
    budget: z
      .object({
        initialBudget: z.number(),
        spent: z.number(),
        remainingBudget: z.number(),
        maximumLegalBid: z.number(),
        rosterFillRate: z.number(),
        budgetSpentRate: z.number(),
        /** Positive means dollars are leaving faster than roster slots are filling. */
        paceDelta: z.number(),
      })
      .strict(),
    marketEfficiency: z.union([
      z
        .object({
          status: z.literal("AVAILABLE"),
          baselineValueAcquired: z.number(),
          spent: z.number(),
          surplus: z.number(),
          baselineValuePerDollar: z.number().nullable(),
        })
        .strict(),
      z
        .object({
          status: z.enum(["UNAVAILABLE", "PARTIAL"]),
          coveredPurchases: analysisCountSchema,
          totalPurchases: analysisCountSchema,
          message: analysisDetailSchema,
        })
        .strict(),
    ]),
    teamStrength: teamStrengthSchema,
    warnings: analysisWarningsSchema,
  })
  .strict();

const draftAnalysisTeamSchema = z.discriminatedUnion("mode", [snakeTeamSchema, auctionTeamSchema]);

const draftAnalysisMarketSourceSchema = z
  .object({
    key: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    attribution: z.string().max(200).nullable(),
    attributionUrl: z.url().nullable(),
    sourceAsOf: analysisTimestampSchema,
    fetchedAt: analysisTimestampSchema,
    checksumSha256: analysisChecksumSchema,
    stale: z.boolean(),
    matchRate: z.number().min(0).max(1),
  })
  .strict();

const draftAnalysisMarketSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      source: draftAnalysisMarketSourceSchema,
      coveredPlayers: analysisCountSchema,
      poolPlayers: analysisCountSchema,
      droppedRows: z
        .object({
          notInPool: analysisCountSchema,
          duplicate: analysisCountSchema,
          invalidAdp: analysisCountSchema,
        })
        .strict(),
      /**
       * False for every source admitted today: Fantasy Football Calculator publishes ADP with no
       * auction value. Auction price and value analysis is withheld rather than derived.
       */
      auctionValuesPublished: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum([
        // Forwarded verbatim from the draft-market read.
        "draft-not-found",
        "unknown-scoring",
        "unsupported-team-count",
        "unsupported-roster-format",
        "source-not-ready",
        "identity-coverage-low",
        // Added while mapping the admitted file onto the analyzer's market.
        "market-integrity",
        "no-pool-overlap",
      ]),
      detail: analysisDetailSchema,
    })
    .strict(),
]);

const draftAnalysisProjectionsSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      setId: analysisUuidSchema,
      source: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      horizon: z.string().min(1).max(60),
      scoringProfileId: z.string().min(1).max(200),
      asOf: analysisTimestampSchema,
      coveredPlayers: analysisCountSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum([
        "NO_LEAGUE_SCORING_PROFILE",
        "NO_COMPATIBLE_SET",
        "PUBLISHED_AFTER_DRAFT_START",
        "STALE_BEFORE_DRAFT",
      ]),
      detail: analysisDetailSchema,
      candidatesConsidered: analysisCountSchema,
    })
    .strict(),
]);

export const draftAnalysisResponseSchema = z
  .object({
    draftId: analysisUuidSchema,
    /** Snapshot sequence the report was computed from, so a client can tell a stale panel. */
    sequence: analysisCountSchema,
    generatedAt: analysisTimestampSchema,
    algorithmVersion: z.string().min(1).max(120),
    inputChecksum: analysisChecksumSchema,
    mode: z.enum(["SNAKE", "AUCTION"]),
    draftStatus: z.enum(["IN_PROGRESS", "COMPLETE"]),
    market: draftAnalysisMarketSchema,
    projections: draftAnalysisProjectionsSchema,
    teams: z.array(draftAnalysisTeamSchema).max(32),
    warnings: analysisWarningsSchema,
  })
  .strict()
  .refine(
    (report) => report.teams.every((team) => team.mode === report.mode),
    "every analyzed team must use the report's own draft mode",
  );

export type DraftAnalysisResponse = z.infer<typeof draftAnalysisResponseSchema>;
export type DraftAnalysisTeam = DraftAnalysisResponse["teams"][number];
export type DraftAnalysisSnakeTeam = Extract<DraftAnalysisTeam, { mode: "SNAKE" }>;
export type DraftAnalysisAuctionTeam = Extract<DraftAnalysisTeam, { mode: "AUCTION" }>;
export type DraftAnalysisMarketProvenance = DraftAnalysisResponse["market"];
export type DraftAnalysisMarketSource = z.infer<typeof draftAnalysisMarketSourceSchema>;
export type DraftAnalysisProjectionProvenance = DraftAnalysisResponse["projections"];
export type DraftAnalysisMarketUnavailableReason = Extract<
  DraftAnalysisMarketProvenance,
  { state: "unavailable" }
>["reason"];
export type DraftAnalysisProjectionUnavailableReason = Extract<
  DraftAnalysisProjectionProvenance,
  { state: "unavailable" }
>["reason"];
export type DraftAnalysisWarning = DraftAnalysisResponse["warnings"][number];
