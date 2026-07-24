import { z } from "zod";

// Mirrored here so the browser contract bundle has no runtime dependency on the domain package.
// Response parsing fails closed if service vocabulary ever drifts from this wire contract.
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
  "LB",
  "DB",
  "IDP_FLEX",
  "BENCH",
  "IR",
  "TAXI",
] as const;

export const providerSchema = z.enum(["yahoo", "espn", "manual"]);
export type Provider = z.infer<typeof providerSchema>;

export const connectionHealthSchema = z.enum([
  "pending",
  "healthy",
  "degraded",
  "reauthorize",
  "disabled",
]);

export const connectionSummarySchema = z.object({
  id: z.string(),
  provider: providerSchema,
  label: z.string(),
  health: connectionHealthSchema,
  official: z.boolean(),
  mode: z.string(),
  readOnly: z.boolean(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
  message: z.string().nullable(),
});
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;

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

export const leagueMembershipRoleSchema = z.enum(["owner", "commissioner", "manager", "viewer"]);

export const leagueMembershipSummarySchema = z.object({
  role: leagueMembershipRoleSchema,
  claimedFantasyTeamId: z.string().uuid().nullable(),
  claimedTeamName: z.string().nullable(),
  claimedAt: z.iso.datetime().nullable(),
});
export type LeagueMembershipSummary = z.infer<typeof leagueMembershipSummarySchema>;

export const leagueSeasonSummarySchema = z.object({
  id: z.string().uuid(),
  provider: providerSchema,
  season: z.number().int(),
  status: z.string(),
  teamCount: z.number().int().positive(),
  draftType: z.string(),
  waiverType: z.string().nullable(),
  currentWeek: z.number().int().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  providerFreshness: freshnessSchema,
});
export type LeagueSeasonSummary = z.infer<typeof leagueSeasonSummarySchema>;

export const leaguePortfolioItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  archived: z.boolean(),
  membership: leagueMembershipSummarySchema,
  season: leagueSeasonSummarySchema.nullable(),
});
export type LeaguePortfolioItem = z.infer<typeof leaguePortfolioItemSchema>;

export const leagueListResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  leagues: z.array(leaguePortfolioItemSchema),
});
export type LeagueListResponse = z.infer<typeof leagueListResponseSchema>;

export const rosterPlayerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  position: z.string(),
  eligiblePositions: z.array(z.string()),
  nflTeam: z.string().nullable(),
  status: z.string().nullable(),
  slotCode: z.string(),
  isStarter: z.boolean(),
  locked: z.boolean(),
});
export type RosterPlayer = z.infer<typeof rosterPlayerSchema>;

export const leagueTeamSnapshotSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  abbreviation: z.string().nullable(),
  managerDisplayName: z.string().nullable(),
  faabRemaining: z.number().int().nullable(),
  waiverPriority: z.number().int().nullable(),
  claimStatus: z.enum(["current-user", "available", "taken", "not-claimable"]),
  latestRoster: z
    .object({
      effectiveAt: z.iso.datetime(),
      week: z.number().int().nullable(),
      players: z.array(rosterPlayerSchema),
    })
    .nullable(),
});
export type LeagueTeamSnapshot = z.infer<typeof leagueTeamSnapshotSchema>;

export const teamClaimPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("provider-mapped"),
      provider: z.literal("yahoo"),
      claimableTeamId: z.string().uuid(),
      claimableTeamName: z.string().min(1),
      explanation: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("self-asserted"),
      provider: z.enum(["espn", "manual"]),
      claimableTeamId: z.null(),
      claimableTeamName: z.null(),
      explanation: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("unavailable"),
      provider: providerSchema.nullable(),
      claimableTeamId: z.null(),
      claimableTeamName: z.null(),
      explanation: z.string().min(1),
    })
    .strict(),
]);
export type TeamClaimPolicy = z.infer<typeof teamClaimPolicySchema>;

export const dataSourceFreshnessSchema = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.string(),
  attribution: z.string().nullable(),
  attributionUrl: z.url().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  quality: z
    .object({
      rowsRead: z.number().int().nonnegative(),
      rowsRejected: z.number().int().nonnegative(),
      rowsUnmatched: z.number().int().nonnegative(),
      matchRate: z.number().min(0).max(1).nullable(),
    })
    .nullable(),
  freshness: freshnessSchema,
});
export type DataSourceFreshness = z.infer<typeof dataSourceFreshnessSchema>;

export const leagueStandingEntrySchema = z.object({
  teamId: z.string().uuid(),
  teamName: z.string(),
  abbreviation: z.string().nullable(),
  managerDisplayName: z.string().nullable(),
  rank: z.number().int().positive(),
  playoffSeed: z.number().int().positive().nullable(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  pointsFor: z.number(),
  pointsAgainst: z.number(),
  pointDifferential: z.number(),
  streakType: z.enum(["win", "loss", "tie", "none"]),
  streakLength: z.number().int().nonnegative(),
  isCurrentUser: z.boolean(),
});
export type LeagueStandingEntry = z.infer<typeof leagueStandingEntrySchema>;

export const leagueStandingsSnapshotSchema = z.object({
  state: z.enum(["available", "unavailable"]),
  asOfWeek: z.number().int().positive().nullable(),
  effectiveAt: z.iso.datetime().nullable(),
  freshness: freshnessSchema,
  entries: z.array(leagueStandingEntrySchema),
});
export type LeagueStandingsSnapshot = z.infer<typeof leagueStandingsSnapshotSchema>;

export const leagueMatchupTeamSchema = z.object({
  teamId: z.string().uuid(),
  teamName: z.string(),
  abbreviation: z.string().nullable(),
  managerDisplayName: z.string().nullable(),
  score: z.number().nullable(),
});
export type LeagueMatchupTeam = z.infer<typeof leagueMatchupTeamSchema>;

export const leagueWeeklyMatchupSchema = z.object({
  id: z.string().uuid(),
  week: z.number().int().positive(),
  status: z.enum(["scheduled", "in-progress", "final"]),
  home: leagueMatchupTeamSchema,
  away: leagueMatchupTeamSchema,
  winnerTeamId: z.string().uuid().nullable(),
  tied: z.boolean(),
  isCurrentUserMatchup: z.boolean(),
});
export type LeagueWeeklyMatchup = z.infer<typeof leagueWeeklyMatchupSchema>;

export const weeklyScoreLeaderSchema = z.object({
  rank: z.number().int().positive(),
  teamId: z.string().uuid(),
  teamName: z.string(),
  managerDisplayName: z.string().nullable(),
  score: z.number(),
  opponentTeamId: z.string().uuid(),
  opponentTeamName: z.string(),
  matchupStatus: z.enum(["in-progress", "final"]),
  outcome: z.enum(["win", "loss", "tie", "leading", "trailing", "level"]),
  isCurrentUser: z.boolean(),
});
export type WeeklyScoreLeader = z.infer<typeof weeklyScoreLeaderSchema>;

export const leagueWeeklyInsightsSchema = z.object({
  state: z.enum(["available", "week-unavailable", "unavailable"]),
  week: z.number().int().positive().nullable(),
  snapshotAsOfWeek: z.number().int().positive().nullable(),
  effectiveAt: z.iso.datetime().nullable(),
  freshness: freshnessSchema,
  matchups: z.array(leagueWeeklyMatchupSchema),
  metrics: z.object({
    matchupCount: z.number().int().nonnegative(),
    completedMatchupCount: z.number().int().nonnegative(),
    inProgressMatchupCount: z.number().int().nonnegative(),
    scheduledMatchupCount: z.number().int().nonnegative(),
    scoredTeamCount: z.number().int().nonnegative(),
    totalPoints: z.number().nullable(),
    averageTeamScore: z.number().nullable(),
    highestTeamScore: z.number().nullable(),
    lowestTeamScore: z.number().nullable(),
    smallestScoreMargin: z.number().nullable(),
    largestScoreMargin: z.number().nullable(),
  }),
  scoreLeaders: z.array(weeklyScoreLeaderSchema),
});
export type LeagueWeeklyInsights = z.infer<typeof leagueWeeklyInsightsSchema>;

export const memberWeekContextSchema = z.object({
  state: z.enum(["available", "team-unclaimed", "week-unavailable", "matchup-unavailable"]),
  week: z.number().int().positive().nullable(),
  teamId: z.string().uuid().nullable(),
  teamName: z.string().nullable(),
  standingRank: z.number().int().positive().nullable(),
  wins: z.number().int().nonnegative().nullable(),
  losses: z.number().int().nonnegative().nullable(),
  ties: z.number().int().nonnegative().nullable(),
  opponentTeamId: z.string().uuid().nullable(),
  opponentTeamName: z.string().nullable(),
  opponentManagerDisplayName: z.string().nullable(),
  opponentStandingRank: z.number().int().positive().nullable(),
  opponentWins: z.number().int().nonnegative().nullable(),
  opponentLosses: z.number().int().nonnegative().nullable(),
  opponentTies: z.number().int().nonnegative().nullable(),
  matchupId: z.string().uuid().nullable(),
  matchupStatus: z.enum(["scheduled", "in-progress", "final"]).nullable(),
  isHome: z.boolean().nullable(),
  teamScore: z.number().nullable(),
  opponentScore: z.number().nullable(),
  scoreState: z.enum(["not-started", "leading", "trailing", "tied", "won", "lost"]).nullable(),
});
export type MemberWeekContext = z.infer<typeof memberWeekContextSchema>;

export const leagueDashboardSchema = z.object({
  generatedAt: z.iso.datetime(),
  league: z.object({
    id: z.string().uuid(),
    name: z.string(),
    archived: z.boolean(),
  }),
  membership: leagueMembershipSummarySchema,
  teamClaim: teamClaimPolicySchema,
  season: leagueSeasonSummarySchema.nullable(),
  latestSyncRun: z
    .object({
      kind: z.string(),
      state: z.string(),
      startedAt: z.iso.datetime().nullable(),
      finishedAt: z.iso.datetime().nullable(),
      recordsRead: z.number().int().nonnegative(),
      recordsWritten: z.number().int().nonnegative(),
    })
    .nullable(),
  overview: z.object({
    configuredTeamCount: z.number().int().nonnegative(),
    storedTeamCount: z.number().int().nonnegative(),
    teamsWithRosterSnapshots: z.number().int().nonnegative(),
    rosteredPlayerCount: z.number().int().nonnegative(),
    starterCount: z.number().int().nonnegative(),
    availableTeamClaims: z.number().int().nonnegative(),
    positionCounts: z.record(z.string(), z.number().int().nonnegative()),
  }),
  teams: z.array(leagueTeamSnapshotSchema),
  standings: leagueStandingsSnapshotSchema,
  weeklyInsights: leagueWeeklyInsightsSchema,
  memberWeek: memberWeekContextSchema,
  dataSources: z.array(dataSourceFreshnessSchema),
  notices: z.array(z.string()),
});
export type LeagueDashboard = z.infer<typeof leagueDashboardSchema>;

export const teamClaimRequestSchema = z.object({
  teamId: z.string().uuid(),
});

export const teamClaimResponseSchema = z.object({
  leagueId: z.string().uuid(),
  teamId: z.string().uuid(),
  teamName: z.string(),
  claimedAt: z.iso.datetime(),
});
export type TeamClaimResponse = z.infer<typeof teamClaimResponseSchema>;

export const actionItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["lineup", "waiver", "trade", "draft", "connection"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  title: z.string(),
  summary: z.string(),
  valueLabel: z.string().nullable(),
  href: z.string(),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const leagueCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: providerSchema,
  season: z.number().int(),
  draftType: z.enum(["snake", "auction"]),
  scoringLabel: z.string(),
  record: z.string().nullable(),
  standing: z.string().nullable(),
  userTeamName: z.string(),
  opponentName: z.string().nullable(),
  projectedFor: z.number().nullable(),
  projectedAgainst: z.number().nullable(),
  sync: freshnessSchema,
  actions: z.array(actionItemSchema),
  demo: z.boolean(),
});
export type LeagueCard = z.infer<typeof leagueCardSchema>;

export const dashboardSnapshotSchema = z.object({
  generatedAt: z.iso.datetime(),
  season: z.number().int(),
  week: z.number().int().nullable(),
  mode: z.enum(["demo", "live", "partial"]),
  leagues: z.array(leagueCardSchema),
  connections: z.array(connectionSummarySchema),
  notices: z.array(z.string()),
});
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  correlationId: z.string(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const yahooAuthorizeRequestSchema = z.object({
  returnTo: z
    .string()
    .max(1024)
    .regex(/^\/(?!\/)[\x20-\x7E]*$/u, "must be an application-relative path")
    .refine((value) => !value.includes("\\"), "must not contain a backslash")
    .default("/connections"),
});

export const yahooAuthorizeResponseSchema = z.object({
  authorizationUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const espnBridgeDeviceRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).default("ESPN browser bridge"),
  allowedLeagueIds: z
    .array(z.string().regex(/^\d{1,20}$/u))
    .min(1)
    .max(32)
    .refine((values) => new Set(values).size === values.length, "league IDs must be unique"),
});

export const espnBridgeDeviceResponseSchema = z.object({
  deviceId: z.string().uuid(),
  deviceToken: z.string().min(32).max(512),
  expiresAt: z.iso.datetime().nullable(),
});

export const espnBridgeDeviceStatusSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(80),
  state: z.enum(["active", "expired", "revoked"]),
  allowedLeagues: z.array(
    z.object({
      externalLeagueId: z.string().regex(/^\d{1,20}$/u),
      season: z.number().int().min(2000).max(2200).nullable(),
      leagueId: z.string().uuid().nullable(),
      leagueName: z.string().min(1).nullable(),
    }),
  ),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export const espnBridgeDeviceListResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  devices: z.array(espnBridgeDeviceStatusSchema),
});

export const espnBridgeDeviceRevokeResponseSchema = z.object({
  deviceId: z.string().uuid(),
  revokedAt: z.iso.datetime(),
});

export const espnBridgeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("espn"),
    authority: z.literal("browser-local"),
    readOnly: z.literal(true),
    leagueId: z.string().regex(/^\d{1,20}$/u),
    season: z.number().int().min(2000).max(2100),
    capturedAt: z.iso.datetime(),
    endpoint: z
      .url()
      .refine(
        (value) => new URL(value).origin === "https://lm-api-reads.fantasy.espn.com",
        "must use the allowlisted ESPN fantasy read host",
      ),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    payload: z.unknown(),
  })
  .strict();
export type EspnBridgeSnapshot = z.infer<typeof espnBridgeSnapshotSchema>;

const espnSupplementalBridgeBase = {
  schemaVersion: z.literal(1),
  provider: z.literal("espn"),
  authority: z.literal("browser-local"),
  readOnly: z.literal(true),
  leagueId: z.string().regex(/^\d{1,20}$/u),
  season: z.number().int().min(2019).max(2100),
  capturedAt: z.iso.datetime(),
  endpoint: z
    .url()
    .refine(
      (value) => new URL(value).origin === "https://lm-api-reads.fantasy.espn.com",
      "must use the allowlisted ESPN fantasy read host",
    ),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  payload: z.unknown(),
} as const;

export const espnSupplementalBridgeSnapshotSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...espnSupplementalBridgeBase,
      kind: z.literal("available-free-agents"),
      week: z.number().int().min(0).max(30),
    })
    .strict(),
  z
    .object({
      ...espnSupplementalBridgeBase,
      kind: z.literal("available-waivers"),
      week: z.number().int().min(0).max(30),
    })
    .strict(),
  z
    .object({
      ...espnSupplementalBridgeBase,
      kind: z.literal("weekly-box-scores"),
      week: z.number().int().min(1).max(30),
      matchupPeriodId: z.number().int().min(1).max(30),
    })
    .strict(),
  z
    .object({
      ...espnSupplementalBridgeBase,
      kind: z.literal("structured-transactions"),
      week: z.number().int().min(0).max(30),
    })
    .strict(),
  z
    .object({
      ...espnSupplementalBridgeBase,
      kind: z.literal("completed-draft"),
      week: z.null(),
    })
    .strict(),
]);
export type EspnSupplementalBridgeSnapshot = z.infer<typeof espnSupplementalBridgeSnapshotSchema>;

export const espnBridgeReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  state: z.enum(["accepted", "unchanged"]),
  receivedAt: z.iso.datetime(),
});

export const jobAcceptedSchema = z
  .object({
    jobId: z.string().nullable(),
    state: z.enum(["queued", "deduplicated"]),
    target: z.enum(["shared-nfl-data", "draft-market-adp"]),
    requestedAt: z.iso.datetime(),
  })
  .strict();
export type JobAccepted = z.infer<typeof jobAcceptedSchema>;

export const refreshRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("player-data") }).strict(),
  z.object({ scope: z.literal("adp-data") }).strict(),
  z.object({ scope: z.literal("league"), leagueId: z.string().uuid() }).strict(),
]);
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

const draftUuidSchema = z.string().uuid();
const draftSequenceSchema = z.number().int().nonnegative().max(1_000_000);
const draftPositiveIntegerSchema = z.number().int().positive().max(1_000_000);
const draftNonNegativeIntegerSchema = z.number().int().nonnegative().max(1_000_000);

export const draftManualActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("SNAKE_PLAYER_SELECTED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      overallPick: draftPositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("SNAKE_KEEPER_ASSIGNED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      overallPick: draftPositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_KEEPER_ASSIGNED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      price: draftNonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_NOMINATION_STARTED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      nominationNumber: draftPositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_BID_PLACED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      amount: draftNonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_PLAYER_SOLD"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      price: draftNonNegativeIntegerSchema,
    })
    .strict(),
]);
export type DraftManualAction = z.infer<typeof draftManualActionSchema>;

export const draftSessionCreateRequestSchema = z
  .object({
    leagueSeasonId: draftUuidSchema,
    mode: z.enum(["snake", "auction"]).optional(),
    teamOrder: z.array(z.string().trim().min(1).max(200)).min(2).optional(),
    thirdRoundReversal: z.boolean().optional(),
    budgetPerTeam: draftPositiveIntegerSchema.optional(),
    minimumBid: draftPositiveIntegerSchema.optional(),
  })
  .strict();
export type DraftSessionCreateRequest = z.infer<typeof draftSessionCreateRequestSchema>;

export const draftEventAppendRequestSchema = z
  .object({
    expectedSequence: draftSequenceSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
    action: draftManualActionSchema,
  })
  .strict();
export type DraftEventAppendRequest = z.infer<typeof draftEventAppendRequestSchema>;

export const draftEventUndoRequestSchema = z
  .object({
    expectedSequence: draftSequenceSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
    targetSequence: draftPositiveIntegerSchema.optional(),
  })
  .strict();
export type DraftEventUndoRequest = z.infer<typeof draftEventUndoRequestSchema>;

export const draftEventCorrectionRequestSchema = z
  .object({
    expectedSequence: draftSequenceSchema,
    idempotencyKey: z.string().trim().min(8).max(180),
    targetSequence: draftPositiveIntegerSchema,
    replacement: draftManualActionSchema,
  })
  .strict();
export type DraftEventCorrectionRequest = z.infer<typeof draftEventCorrectionRequestSchema>;

const draftRosterSlotSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(ROSTER_SLOT_TYPES),
    label: z.string().min(1),
    kind: z.enum(["STARTER", "BENCH", "INJURED_RESERVE", "TAXI"]),
    eligiblePositions: z.array(z.enum(NFL_POSITIONS)).min(1),
  })
  .strict();

const draftPlayerSchema = z
  .object({
    id: draftUuidSchema,
    name: z.string().min(1),
    positions: z.array(z.enum(NFL_POSITIONS)).min(1),
    nflTeam: z.enum(NFL_TEAMS).optional(),
    status: z.enum(PLAYER_STATUSES).optional(),
  })
  .strict();

const draftTeamConfigSchema = z
  .object({
    id: draftUuidSchema,
    name: z.string().min(1),
    rosterSlots: z.array(draftRosterSlotSchema).min(1),
    budget: draftNonNegativeIntegerSchema.optional(),
  })
  .strict();

const draftConfigSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("SNAKE"),
      teams: z.array(draftTeamConfigSchema).min(2),
      players: z.array(draftPlayerSchema).min(1),
      pickOrder: z.array(draftUuidSchema).min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("AUCTION"),
      teams: z.array(draftTeamConfigSchema).min(2),
      players: z.array(draftPlayerSchema).min(1),
      minimumBid: draftNonNegativeIntegerSchema,
    })
    .strict(),
]);

const draftEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
      type: z.literal("SNAKE_PLAYER_SELECTED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      overallPick: draftPositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
      type: z.literal("SNAKE_KEEPER_ASSIGNED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      overallPick: draftPositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
      type: z.literal("AUCTION_KEEPER_ASSIGNED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      price: draftNonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
      type: z.literal("AUCTION_NOMINATION_STARTED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      nominationNumber: draftPositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
      type: z.literal("AUCTION_BID_PLACED"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      amount: draftNonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
      type: z.literal("AUCTION_PLAYER_SOLD"),
      teamId: draftUuidSchema,
      playerId: draftUuidSchema,
      price: draftNonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
      type: z.literal("DRAFT_EVENT_REVERTED"),
      targetEventId: z.string().min(1),
    })
    .strict(),
]);

const draftTeamStateSchema = z
  .object({
    teamId: draftUuidSchema,
    name: z.string().min(1),
    roster: z.array(
      z
        .object({
          playerId: draftUuidSchema,
          eventId: z.string().min(1),
          acquisition: z.enum(["SNAKE_PICK", "SNAKE_KEEPER", "AUCTION", "AUCTION_KEEPER"]),
          overallPick: draftPositiveIntegerSchema.optional(),
          price: draftNonNegativeIntegerSchema.optional(),
        })
        .strict(),
    ),
    openSlots: draftNonNegativeIntegerSchema,
    spent: draftNonNegativeIntegerSchema.optional(),
    remainingBudget: draftNonNegativeIntegerSchema.optional(),
    maximumBid: draftNonNegativeIntegerSchema.optional(),
  })
  .strict();

const draftStateSchema = z
  .object({
    mode: z.enum(["SNAKE", "AUCTION"]),
    teams: z.array(draftTeamStateSchema).min(2),
    draftedPlayerIds: z.array(draftUuidSchema),
    activeEventIds: z.array(z.string().min(1)),
    revertedEventIds: z.array(z.string().min(1)),
    nextPick: z
      .object({ overallPick: draftPositiveIntegerSchema, teamId: draftUuidSchema })
      .strict()
      .nullable(),
    activeNomination: z
      .object({
        nominationNumber: draftPositiveIntegerSchema,
        playerId: draftUuidSchema,
        nominatorTeamId: draftUuidSchema,
        highBidTeamId: draftUuidSchema.nullable(),
        highBid: draftNonNegativeIntegerSchema.nullable(),
      })
      .strict()
      .nullable(),
    complete: z.boolean(),
  })
  .strict();

export const draftSessionSnapshotSchema = z
  .object({
    id: draftUuidSchema,
    leagueSeasonId: draftUuidSchema,
    transport: z.literal("manual"),
    providerPolling: z.literal(false),
    accessRole: leagueMembershipRoleSchema,
    sequence: draftSequenceSchema,
    persistedState: z.enum(["created", "live", "complete"]),
    config: draftConfigSchema,
    state: draftStateSchema,
    events: z.array(
      z
        .object({
          sequence: draftPositiveIntegerSchema,
          idempotencyKey: z.string().min(8).max(200),
          source: z.literal("manual"),
          occurredAt: z.iso.datetime(),
          revertsSequence: draftPositiveIntegerSchema.nullable(),
          event: draftEventSchema,
        })
        .strict(),
    ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type DraftSessionSnapshot = z.infer<typeof draftSessionSnapshotSchema>;

const draftMarketSourceSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    attribution: z.string().nullable(),
    attributionUrl: z.url().nullable(),
    sourceAsOf: z.iso.datetime(),
    fetchedAt: z.iso.datetime(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    stale: z.boolean(),
    matchRate: z.number().min(0).max(1),
  })
  .strict();

export const draftMarketBaselineSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      context: z
        .object({
          season: z.number().int().min(2000).max(2200),
          scoringFormat: z.enum(["standard", "half-ppr", "ppr"]),
          teamCount: z.number().int().min(4).max(32),
          rosterFormat: z.literal("one-qb"),
        })
        .strict(),
      source: draftMarketSourceSchema,
      players: z.array(
        z
          .object({
            playerId: z.string().uuid(),
            overallAdp: z.number().positive(),
            sourceRank: z.number().int().positive().nullable(),
            positionRank: z.number().int().positive().nullable(),
            standardDeviation: z.number().nonnegative().nullable(),
            sampleSize: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      ),
      warnings: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum([
        "draft-not-found",
        "unknown-scoring",
        "unsupported-team-count",
        "unsupported-roster-format",
        "source-not-ready",
        "identity-coverage-low",
      ]),
      detail: z.string().min(1),
    })
    .strict(),
]);
export type DraftMarketBaseline = z.infer<typeof draftMarketBaselineSchema>;

export const draftMutationResponseSchema = z
  .object({
    idempotent: z.boolean(),
    appendedSequences: z.array(draftPositiveIntegerSchema),
    session: draftSessionSnapshotSchema,
  })
  .strict();
export type DraftMutationResponse = z.infer<typeof draftMutationResponseSchema>;

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

const decisionPlayerSchema = z
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

const unavailableDecisionSectionSchema = z
  .object({
    state: z.literal("unavailable"),
    reasons: z.array(decisionUnavailableReasonSchema).min(1),
  })
  .strict();

const decisionExecutionSchema = z
  .object({
    mode: z.literal("provider-required"),
    provider: providerSchema,
    label: z.string().min(1),
    url: z.url().nullable(),
  })
  .strict();

const lineupAssignmentDecisionSchema = z
  .object({
    slotId: z.string().min(1),
    slotLabel: z.string().min(1),
    player: decisionPlayerSchema,
    locked: z.boolean(),
  })
  .strict();

const lineupChangeDecisionSchema = z
  .object({
    slotId: z.string().min(1),
    slotLabel: z.string().min(1),
    remove: decisionPlayerSchema.nullable(),
    add: decisionPlayerSchema.nullable(),
    projectedPointDelta: z.number().finite(),
  })
  .strict();

export const lineupDecisionSectionSchema = z.discriminatedUnion("state", [
  unavailableDecisionSectionSchema,
  z
    .object({
      state: z.literal("available"),
      metric: z.literal("mean"),
      feasible: z.boolean(),
      currentProjectedPoints: z.number().finite(),
      optimalProjectedPoints: z.number().finite(),
      projectedGain: z.number().finite(),
      assignments: z.array(lineupAssignmentDecisionSchema).max(30),
      changes: z.array(lineupChangeDecisionSchema).max(30),
      execution: decisionExecutionSchema,
      notes: z.array(z.string()),
    })
    .strict(),
]);
export type LineupDecisionSection = z.infer<typeof lineupDecisionSectionSchema>;

const faabRangeSchema = z
  .object({
    low: z.number().int().nonnegative(),
    recommended: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
  })
  .strict();

const waiverMoveDecisionSchema = z
  .object({
    add: decisionPlayerSchema,
    drop: decisionPlayerSchema.nullable(),
    weightedGain: z.number().finite(),
    lineupGain: z.number().finite(),
    faab: faabRangeSchema.nullable(),
    market: z
      .object({
        addCount: z.number().int().nonnegative(),
        dropCount: z.number().int().nonnegative(),
        lookbackHours: z.number().int().positive().max(168),
        observedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    rationale: z.string().min(1),
  })
  .strict();

export const waiverDecisionSectionSchema = z.discriminatedUnion("state", [
  unavailableDecisionSectionSchema,
  z
    .object({
      state: z.literal("available"),
      candidateCount: z.number().int().nonnegative(),
      evaluatedMoveCount: z.number().int().nonnegative(),
      recommendations: z.array(waiverMoveDecisionSchema).max(8),
      execution: decisionExecutionSchema,
      notes: z.array(z.string()),
    })
    .strict(),
]);
export type WaiverDecisionSection = z.infer<typeof waiverDecisionSectionSchema>;

const tradePackageDecisionSchema = z
  .object({
    id: z.string().min(1),
    partner: z.object({ id: z.string().uuid(), name: z.string().min(1) }).strict(),
    shape: z.enum(["1-for-1", "2-for-1", "1-for-2"]),
    send: z.array(decisionPlayerSchema).min(1).max(2),
    receive: z.array(decisionPlayerSchema).min(1).max(2),
    forcedDropsForUser: z.array(decisionPlayerSchema).max(2),
    forcedDropsForPartner: z.array(decisionPlayerSchema).max(2),
    userGain: z.number().finite(),
    partnerGain: z.number().finite(),
    totalGain: z.number().finite(),
    fairnessGap: z.number().finite().nonnegative(),
    mutuallyBeneficial: z.boolean(),
  })
  .strict();

export const tradeDecisionSectionSchema = z.discriminatedUnion("state", [
  unavailableDecisionSectionSchema,
  z
    .object({
      state: z.literal("available"),
      evaluatedPackageCount: z.number().int().nonnegative(),
      eligibleOpponentCount: z.number().int().nonnegative(),
      bestForMe: z.array(tradePackageDecisionSchema).max(6),
      fairest: z.array(tradePackageDecisionSchema).max(6),
      execution: decisionExecutionSchema,
      notes: z.array(z.string()),
    })
    .strict(),
]);
export type TradeDecisionSection = z.infer<typeof tradeDecisionSectionSchema>;

export const inSeasonDecisionSnapshotSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    league: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        season: z.number().int().min(2000).max(2200).nullable(),
        week: z.number().int().min(1).max(30).nullable(),
        provider: providerSchema.nullable(),
      })
      .strict(),
    team: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        faabRemaining: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    provenance: z
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
      .strict(),
    providerVerification: z
      .object({
        lockCoverage: z.literal("unavailable"),
        storedTrueLocksHonored: z.literal(true),
        storedFalseMeansUnlocked: z.literal(false),
        storedLockedPlayerCount: z.number().int().nonnegative(),
        actionWarning: z.string().min(1),
      })
      .strict(),
    coverage: z
      .object({
        leagueTeams: z.number().int().nonnegative(),
        teamsWithRosters: z.number().int().nonnegative(),
        leagueRosteredPlayers: z.number().int().nonnegative(),
        claimedRosterPlayers: z.number().int().nonnegative(),
        claimedRosterProjected: z.number().int().nonnegative(),
        claimedRosterProjectionRatio: z.number().min(0).max(1),
        projectionSetPlayers: z.number().int().nonnegative(),
        projectionQueryLimited: z.boolean(),
      })
      .strict(),
    lineup: lineupDecisionSectionSchema,
    waivers: waiverDecisionSectionSchema,
    trades: tradeDecisionSectionSchema,
  })
  .strict();
export type InSeasonDecisionSnapshot = z.infer<typeof inSeasonDecisionSnapshotSchema>;

export const projectionVisibilitySchema = z.enum(["private", "league"]);
export type ProjectionVisibility = z.infer<typeof projectionVisibilitySchema>;

export const projectionImportHorizonSchema = z.enum(["week", "rest-of-season"]);
export type ProjectionImportHorizon = z.infer<typeof projectionImportHorizonSchema>;

export const projectionImportDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string().min(1).max(80),
    rowNumber: z.number().int().positive(),
    column: z
      .enum([
        "player_id",
        "player_name",
        "mean_points",
        "floor_points",
        "ceiling_points",
        "confidence",
      ])
      .nullable(),
    message: z.string().min(1).max(500),
    candidates: z
      .array(
        z
          .object({
            playerId: z.string().uuid(),
            playerName: z.string().min(1).max(160).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type ProjectionImportDiagnostic = z.infer<typeof projectionImportDiagnosticSchema>;

export const projectionImportPreviewResponseSchema = z
  .object({
    metadata: z
      .object({
        season: z.number().int().min(2000).max(2100),
        week: z.number().int().min(1).max(18),
        horizon: z.literal("week"),
        sourceLabel: z.string().min(2).max(80),
        sourceObservedAt: z.iso.datetime(),
      })
      .strict(),
    visibility: projectionVisibilitySchema,
    sourceChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    importChecksum: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    rowCount: z.number().int().nonnegative().max(5_000),
    resolvedRowCount: z.number().int().nonnegative().max(5_000),
    diagnostics: z.array(projectionImportDiagnosticSchema).max(10_032),
    canCommit: z.boolean(),
  })
  .strict();
export type ProjectionImportPreviewResponse = z.infer<typeof projectionImportPreviewResponseSchema>;

export const projectionSetOriginSchema = z.enum(["laces-out", "custom"]);
export type ProjectionSetOrigin = z.infer<typeof projectionSetOriginSchema>;

const projectionWeekReferenceSchema = z
  .object({
    season: z.number().int().min(2000).max(2100),
    week: z.number().int().min(1).max(25).nullable(),
  })
  .strict();

const managedProjectionDetailsSchema = z
  .object({
    modelVersion: z.string().min(1).max(120).nullable(),
    computedAt: z.iso.datetime(),
    inputCheckedAt: z.iso.datetime(),
    trainingCutoff: projectionWeekReferenceSchema.nullable(),
    statsThrough: projectionWeekReferenceSchema.nullable(),
    qualityState: z.enum(["publishable", "degraded", "rejected"]).nullable(),
    championByPosition: z
      .array(
        z
          .object({
            position: z.enum(["QB", "RB", "WR", "TE", "K"]),
            strategy: z.enum(["first-party-model", "recency-only"]),
            reason: z.enum(["insufficient-samples", "model-cleared-margin", "baseline-defended"]),
            samples: z.number().int().nonnegative(),
            completedWeekBatches: z.number().int().nonnegative(),
            modelImprovement: z.number(),
          })
          .strict(),
      )
      .max(5),
    coverage: z
      .object({
        projected: z.number().int().nonnegative().max(5_000),
        eligible: z.number().int().nonnegative().max(5_000),
        ratio: z.number().min(0).max(1),
      })
      .strict()
      .nullable(),
    warnings: z.array(z.string().min(1).max(240)).max(20),
    backtest: z
      .object({
        samples: z.number().int().nonnegative(),
        mae: z.number().nonnegative(),
        baselineMae: z.number().nonnegative().nullable(),
        intervalCoverage: z.number().min(0).max(1).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const projectionSetSummarySchema = z
  .object({
    id: z.string().uuid(),
    leagueSeasonId: z.string().uuid(),
    creatorUserId: z.string().uuid().nullable(),
    creatorDisplayName: z.string().min(1).max(160).nullable(),
    origin: projectionSetOriginSchema,
    managed: managedProjectionDetailsSchema.nullable(),
    visibility: projectionVisibilitySchema,
    sourceLabel: z.string().min(2).max(80),
    sourceFileName: z.string().min(1).max(240).nullable(),
    season: z.number().int().min(2000).max(2100),
    week: z.number().int().min(1).max(18),
    horizon: projectionImportHorizonSchema,
    playerCount: z.number().int().nonnegative().max(5_000),
    inputChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    sourceChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    sourceObservedAt: z.iso.datetime().nullable(),
    sourceObservedAtStatus: projectionSourceObservedAtStatusSchema,
    importedAt: z.iso.datetime(),
    isOwnedByCurrentUser: z.boolean(),
  })
  .strict();
export type ProjectionSetSummary = z.infer<typeof projectionSetSummarySchema>;

export const projectionSetListResponseSchema = z
  .object({
    league: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        leagueSeasonId: z.string().uuid(),
        provider: providerSchema,
        season: z.number().int().min(2000).max(2100),
        currentWeek: z.number().int().min(1).max(18).nullable(),
        membershipRole: leagueMembershipRoleSchema,
        canShareLeague: z.boolean(),
      })
      .strict(),
    managedForecastStatus: z
      .object({
        state: z.enum(["published", "withheld", "pending"]),
        evaluatedAt: z.iso.datetime().nullable(),
        qualityState: z.enum(["publishable", "degraded", "rejected"]).nullable(),
        reasons: z.array(z.string().min(1).max(500)).max(10),
      })
      .strict(),
    projectionSets: z.array(projectionSetSummarySchema).max(100),
  })
  .strict();
export type ProjectionSetListResponse = z.infer<typeof projectionSetListResponseSchema>;

export const projectionImportCommitResponseSchema = z
  .object({
    projectionSet: projectionSetSummarySchema,
    deduplicated: z.boolean(),
  })
  .strict();
export type ProjectionImportCommitResponse = z.infer<typeof projectionImportCommitResponseSchema>;

export const leagueAnalyticsUnavailableCodeSchema = z.enum([
  "NO_SEASON",
  "LEAGUE_EMPTY",
  "LEAGUE_SIZE_UNSUPPORTED",
  "MATCHUPS_MISSING",
  "MATCHUP_HISTORY_LIMIT",
  "PROJECTIONS_MISSING",
  "PROJECTION_WEEK_UNKNOWN",
  "ROSTERS_MISSING",
  "ROSTER_COVERAGE_INCOMPLETE",
  "DEDICATED_STARTERS_MISSING",
  "TEAM_UNCLAIMED",
  "OPPONENT_MISSING",
]);
export type LeagueAnalyticsUnavailableCode = z.infer<typeof leagueAnalyticsUnavailableCodeSchema>;

export const leagueAnalyticsUnavailableReasonSchema = z
  .object({
    code: leagueAnalyticsUnavailableCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();
export type LeagueAnalyticsUnavailableReason = z.infer<
  typeof leagueAnalyticsUnavailableReasonSchema
>;

const leagueAnalyticsUnavailableSectionSchema = z
  .object({
    state: z.literal("unavailable"),
    reasons: z.array(leagueAnalyticsUnavailableReasonSchema).min(1).max(10),
  })
  .strict();

const leagueAnalyticsTeamSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    abbreviation: z.string().max(20).nullable(),
    managerDisplayName: z.string().max(200).nullable(),
    isCurrentUser: z.boolean(),
  })
  .strict();
export type LeagueAnalyticsTeam = z.infer<typeof leagueAnalyticsTeamSchema>;

const leagueAnalyticsRecordSchema = z
  .object({
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    games: z.number().int().nonnegative(),
    winPercentage: z.number().min(0).max(1).nullable(),
  })
  .strict();

const leagueAnalyticsPointsSchema = z
  .object({
    total: z.number().finite(),
    average: z.number().finite().nullable(),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();

const leagueAnalyticsScoreTeamSchema = z
  .object({
    team: leagueAnalyticsTeamSchema,
    scoringWeeks: z.number().int().nonnegative(),
    missingScoringWeeks: z.array(z.number().int().min(1).max(30)).max(30),
    completedMatchups: z.number().int().nonnegative(),
    incompleteMatchups: z.number().int().nonnegative(),
    pointsFor: leagueAnalyticsPointsSchema,
    pointsAgainst: leagueAnalyticsPointsSchema,
    actualRecord: leagueAnalyticsRecordSchema,
    allPlay: leagueAnalyticsRecordSchema,
    expectedWins: z.number().finite().nonnegative(),
    actualWinEquivalents: z.number().finite().nonnegative(),
    luckWins: z.number().finite(),
    eligibleExpectedMatchups: z.number().int().nonnegative(),
  })
  .strict();

const analyticsMetricDefinitionSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    definition: z.string().min(1).max(1_000),
  })
  .strict();

export const leagueScoreAnalyticsSectionSchema = z.discriminatedUnion("state", [
  leagueAnalyticsUnavailableSectionSchema,
  z
    .object({
      state: z.literal("available"),
      weeks: z.array(z.number().int().min(1).max(30)).max(30),
      officialFinalMatchups: z.number().int().nonnegative(),
      incompleteFinalMatchups: z.number().int().nonnegative(),
      teams: z.array(leagueAnalyticsScoreTeamSchema).max(32),
      definitions: z.array(analyticsMetricDefinitionSchema).max(12),
      warnings: z.array(z.string().min(1).max(500)).max(20),
    })
    .strict(),
]);
export type LeagueScoreAnalyticsSection = z.infer<typeof leagueScoreAnalyticsSectionSchema>;

const leaguePowerFactorSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    definition: z.string().min(1).max(1_000),
    configuredWeight: z.number().finite().nonnegative(),
  })
  .strict();

const leaguePowerContributionSchema = z
  .object({
    id: z.string().min(1).max(80),
    rawValue: z.number().finite().nullable(),
    normalizedScore: z.number().min(0).max(100).nullable(),
    effectiveWeight: z.number().min(0).max(1),
    contribution: z.number().finite(),
    included: z.boolean(),
  })
  .strict();

export const leaguePowerAnalyticsSectionSchema = z.discriminatedUnion("state", [
  leagueAnalyticsUnavailableSectionSchema,
  z
    .object({
      state: z.literal("available"),
      factors: z.array(leaguePowerFactorSchema).min(1).max(8),
      rankings: z
        .array(
          z
            .object({
              team: leagueAnalyticsTeamSchema,
              rank: z.number().int().positive().nullable(),
              score: z.number().min(0).max(100).nullable(),
              tiedOnScore: z.boolean(),
              dataCoverage: z.number().min(0).max(1),
              contributions: z.array(leaguePowerContributionSchema).max(8),
            })
            .strict(),
        )
        .max(32),
      definition: z.string().min(1).max(1_000),
      tieBreaker: z.string().min(1).max(500),
    })
    .strict(),
]);
export type LeaguePowerAnalyticsSection = z.infer<typeof leaguePowerAnalyticsSectionSchema>;

const leaguePositionalEntrySchema = z
  .object({
    position: z.enum(NFL_POSITIONS),
    status: z.enum(["available", "missing"]),
    projectedPoints: z.number().finite().nullable(),
    leagueMean: z.number().finite().nullable(),
    strengthPercentile: z.number().min(0).max(100).nullable(),
    strengthZScore: z.number().finite().nullable(),
    rank: z.number().int().positive().nullable(),
    starterCount: z.number().int().positive(),
    rosterPlayerCount: z.number().int().nonnegative(),
    projectedPlayerCount: z.number().int().nonnegative(),
  })
  .strict();

export const leaguePositionalAnalyticsSectionSchema = z.discriminatedUnion("state", [
  leagueAnalyticsUnavailableSectionSchema,
  z
    .object({
      state: z.literal("available"),
      basis: z
        .object({
          id: z.literal("weekly-dedicated-starters"),
          label: z.string().min(1).max(120),
          definition: z.string().min(1).max(1_500),
          starterCounts: z
            .object({
              QB: z.number().int().positive().optional(),
              RB: z.number().int().positive().optional(),
              WR: z.number().int().positive().optional(),
              TE: z.number().int().positive().optional(),
              K: z.number().int().positive().optional(),
              DST: z.number().int().positive().optional(),
              DL: z.number().int().positive().optional(),
              LB: z.number().int().positive().optional(),
              DB: z.number().int().positive().optional(),
              IDP: z.number().int().positive().optional(),
            })
            .strict()
            .refine((value) => Object.keys(value).length > 0, "A starter count is required"),
        })
        .strict(),
      positions: z.array(z.enum(NFL_POSITIONS)).min(1).max(10),
      teams: z
        .array(
          z
            .object({
              team: leagueAnalyticsTeamSchema,
              averagePercentile: z.number().min(0).max(100).nullable(),
              coverage: z.number().min(0).max(1),
              strengths: z.array(z.enum(NFL_POSITIONS)).max(10),
              weaknesses: z.array(z.enum(NFL_POSITIONS)).max(10),
              entries: z.array(leaguePositionalEntrySchema).max(10),
            })
            .strict(),
        )
        .max(32),
      definition: z.string().min(1).max(1_000),
    })
    .strict(),
]);
export type LeaguePositionalAnalyticsSection = z.infer<
  typeof leaguePositionalAnalyticsSectionSchema
>;

const leagueOpponentMetricSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    definition: z.string().min(1).max(1_000),
    unit: z.string().max(40).nullable(),
    subjectValue: z.number().finite().nullable(),
    opponentValue: z.number().finite().nullable(),
    leagueAverage: z.number().finite().nullable(),
    subjectAdvantage: z.number().finite().nullable(),
    edgeOwner: z.enum(["subject", "opponent", "even", "unknown"]),
  })
  .strict();

export const leagueOpponentScoutSectionSchema = z.discriminatedUnion("state", [
  leagueAnalyticsUnavailableSectionSchema,
  z
    .object({
      state: z.literal("available"),
      week: z.number().int().min(1).max(30),
      matchupStatus: z.enum(["scheduled", "in-progress", "final"]),
      subject: leagueAnalyticsTeamSchema,
      opponent: leagueAnalyticsTeamSchema,
      metrics: z.array(leagueOpponentMetricSchema).max(12),
      subjectAdvantages: z.array(z.string().min(1).max(80)).max(12),
      opponentAdvantages: z.array(z.string().min(1).max(80)).max(12),
      definition: z.string().min(1).max(1_000),
    })
    .strict(),
]);
export type LeagueOpponentScoutSection = z.infer<typeof leagueOpponentScoutSectionSchema>;

export const leagueAnalyticsSnapshotSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    league: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(200),
        season: z.number().int().min(2000).max(2200).nullable(),
        currentWeek: z.number().int().min(1).max(30).nullable(),
        provider: providerSchema.nullable(),
      })
      .strict(),
    membership: z
      .object({
        role: leagueMembershipRoleSchema,
        claimedTeamId: z.string().uuid().nullable(),
        claimedTeamName: z.string().min(1).max(200).nullable(),
      })
      .strict(),
    provenance: z
      .object({
        leagueLastSyncedAt: z.iso.datetime().nullable(),
        latestMatchupObservedAt: z.iso.datetime().nullable(),
        matchupFreshness: freshnessSchema,
        matchupObservationsRead: z.number().int().nonnegative(),
        deduplicatedMatchups: z.number().int().nonnegative(),
        projectionSet: z
          .object({
            id: z.string().uuid(),
            source: z.string().min(1).max(120),
            version: z.string().min(1).max(300),
            sourceLabel: z.string().min(1).max(120),
            visibility: projectionVisibilitySchema,
            creatorDisplayName: z.string().min(1).max(200),
            season: z.number().int().min(2000).max(2200),
            week: z.number().int().min(1).max(30),
            horizon: z.literal("week"),
            sourceObservedAt: z.iso.datetime().nullable(),
            sourceObservedAtStatus: projectionSourceObservedAtStatusSchema,
            importedAt: z.iso.datetime(),
          })
          .strict()
          .nullable(),
        projectionFreshness: freshnessSchema,
      })
      .strict(),
    coverage: z
      .object({
        leagueTeams: z.number().int().nonnegative(),
        teamsWithLatestRoster: z.number().int().nonnegative(),
        rosterPlayers: z.number().int().nonnegative(),
        rosterPlayersProjected: z.number().int().nonnegative(),
        officialScoreWeeks: z.number().int().nonnegative(),
      })
      .strict(),
    scores: leagueScoreAnalyticsSectionSchema,
    power: leaguePowerAnalyticsSectionSchema,
    positional: leaguePositionalAnalyticsSectionSchema,
    opponentScout: leagueOpponentScoutSectionSchema,
  })
  .strict();
export type LeagueAnalyticsSnapshot = z.infer<typeof leagueAnalyticsSnapshotSchema>;

export const aiProviderNameSchema = z.enum(["openai", "anthropic", "gemini", "openrouter"]);
export type AiProviderName = z.infer<typeof aiProviderNameSchema>;

export const aiProviderAccessModeSchema = z.enum(["managed", "byok", "unavailable"]);
export type AiProviderAccessMode = z.infer<typeof aiProviderAccessModeSchema>;

export const aiProviderConfigurationSchema = z
  .object({
    provider: aiProviderNameSchema,
    available: z.boolean(),
    configured: z.boolean(),
    accessMode: aiProviderAccessModeSchema,
    modelEditable: z.boolean(),
    model: z.string().min(1).max(160),
    status: z.enum(["active", "invalid"]).nullable(),
    dailyRequestLimit: z.number().int().min(1).max(500),
    maxOutputTokens: z.number().int().min(64).max(8192),
    requestsToday: z.number().int().nonnegative(),
    requestsRemaining: z.number().int().nonnegative(),
    lastValidatedAt: z.iso.datetime().nullable(),
    lastErrorCode: z.string().min(1).max(120).nullable(),
    lastErrorAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type AiProviderConfiguration = z.infer<typeof aiProviderConfigurationSchema>;

export const aiProviderListResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    providers: z.array(aiProviderConfigurationSchema).length(4),
  })
  .strict();
export type AiProviderListResponse = z.infer<typeof aiProviderListResponseSchema>;

export const aiProviderSaveRequestSchema = z
  .object({
    apiKey: z.string().trim().min(8).max(512).optional(),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._~:/-]{1,160}$/u),
    dailyRequestLimit: z.number().int().min(1).max(500),
    maxOutputTokens: z.number().int().min(64).max(8192),
  })
  .strict();
export type AiProviderSaveRequest = z.infer<typeof aiProviderSaveRequestSchema>;

export const aiProviderTestResponseSchema = z
  .object({
    provider: aiProviderNameSchema,
    model: z.string().min(1).max(160),
    ok: z.literal(true),
    validatedAt: z.iso.datetime(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();
export type AiProviderTestResponse = z.infer<typeof aiProviderTestResponseSchema>;

export const aiAnalysisRequestSchema = z
  .object({
    provider: aiProviderNameSchema.optional(),
    leagueId: z.string().uuid(),
    question: z.string().trim().min(3).max(2_000),
  })
  .strict();
export type AiAnalysisRequest = z.infer<typeof aiAnalysisRequestSchema>;

export const aiAnalysisResponseSchema = z
  .object({
    provider: aiProviderNameSchema,
    accessMode: z.enum(["managed", "byok"]),
    model: z.string().min(1).max(160),
    league: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(200),
      })
      .strict(),
    answer: z.string().min(1).max(30_000),
    generatedAt: z.iso.datetime(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    sources: z.array(z.enum(["League overview", "Decision Desk", "League analytics"])).min(1),
  })
  .strict();
export type AiAnalysisResponse = z.infer<typeof aiAnalysisResponseSchema>;

export const aiFeatureNameSchema = z.enum([
  "weekly-brief",
  "start-sit",
  "waiver-scan",
  "trade-builder",
  "standings-prediction",
]);
export type AiFeatureName = z.infer<typeof aiFeatureNameSchema>;

export const aiFeatureRequestSchema = z
  .object({
    provider: aiProviderNameSchema.optional(),
    leagueId: z.string().uuid(),
    instructions: z.string().trim().max(1_000).optional(),
  })
  .strict();
export type AiFeatureRequest = z.infer<typeof aiFeatureRequestSchema>;

export const aiFeatureResponseSchema = z
  .object({
    feature: aiFeatureNameSchema,
    outcome: z.enum(["generated", "no-action"]),
    provider: aiProviderNameSchema,
    accessMode: z.enum(["managed", "byok"]),
    model: z.string().min(1).max(160),
    league: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(200),
      })
      .strict(),
    title: z.string().min(1).max(200),
    answer: z.string().min(1).max(30_000),
    generatedAt: z.iso.datetime(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    sources: z.array(z.enum(["League overview", "Decision Desk", "League analytics"])).min(1),
  })
  .strict();
export type AiFeatureResponse = z.infer<typeof aiFeatureResponseSchema>;

export const statsCenterMetricSchema = z.enum([
  "targets",
  "carries",
  "opportunities",
  "targetShare",
  "offensiveSnapShare",
]);
export type StatsCenterMetric = z.infer<typeof statsCenterMetricSchema>;

const statsCenterAvailabilitySchema = z
  .object({
    state: z.enum(["available", "unavailable", "no-data"]),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();

const statsCenterSourceSchema = z
  .object({
    dataset: z.enum(["weekly-stats", "snap-counts"]),
    state: z.enum(["available", "unavailable", "quarantined"]),
    key: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    attribution: z.string().min(1).max(300).nullable(),
    attributionUrl: z.url().nullable(),
    fetchedAt: z.iso.datetime().nullable(),
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    coveredWeeks: z.array(z.number().int().min(1).max(25)).max(25),
    quality: z
      .object({
        rowsRead: z.number().int().nonnegative().nullable(),
        rowsRejected: z.number().int().nonnegative().nullable(),
        rowsUnmatched: z.number().int().nonnegative().nullable(),
        matchRate: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type StatsCenterSource = z.infer<typeof statsCenterSourceSchema>;

const statsCenterPlayerSchema = z
  .object({
    playerId: z.string().uuid(),
    name: z.string().min(1).max(200),
    position: z.string().min(1).max(20),
    team: z.string().min(2).max(4).nullable(),
    games: z.number().int().nonnegative(),
    snapGames: z.number().int().nonnegative(),
    targets: z.number().int().nonnegative().nullable(),
    carries: z.number().int().nonnegative().nullable(),
    opportunities: z.number().int().nonnegative().nullable(),
    targetsPerGame: z.number().finite().nonnegative().nullable(),
    carriesPerGame: z.number().finite().nonnegative().nullable(),
    opportunitiesPerGame: z.number().finite().nonnegative().nullable(),
    targetShare: z.number().min(0).max(1).nullable(),
    offensiveSnaps: z.number().int().nonnegative().nullable(),
    offensiveSnapShare: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type StatsCenterPlayer = z.infer<typeof statsCenterPlayerSchema>;

export const statsCenterResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    filters: z
      .object({
        season: z.number().int().min(2012).max(2200),
        week: z.number().int().min(1).max(25).nullable(),
        position: z.string().min(1).max(20).nullable(),
        search: z.string().max(80),
        sort: statsCenterMetricSchema,
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    availability: z
      .object({
        targets: statsCenterAvailabilitySchema,
        carries: statsCenterAvailabilitySchema,
        opportunities: statsCenterAvailabilitySchema,
        targetShare: statsCenterAvailabilitySchema,
        offensiveSnapShare: statsCenterAvailabilitySchema,
        redZone: statsCenterAvailabilitySchema,
        boomBust: statsCenterAvailabilitySchema,
        fantasyPointsAllowed: statsCenterAvailabilitySchema,
      })
      .strict(),
    sources: z.array(statsCenterSourceSchema).length(2),
    players: z.array(statsCenterPlayerSchema).max(100),
    totalMatched: z.number().int().nonnegative(),
    truncated: z.boolean(),
    definitions: z
      .object({
        opportunities: z.string().min(1).max(1_000),
        targetShare: z.string().min(1).max(1_000),
        offensiveSnapShare: z.string().min(1).max(1_000),
      })
      .strict(),
  })
  .strict();
export type StatsCenterResponse = z.infer<typeof statsCenterResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  version: z.string(),
  time: z.iso.datetime(),
});
