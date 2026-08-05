import { z } from "zod";

import {
  decisionExecutionSchema,
  decisionPlayerSchema,
  freshnessSchema,
  projectionSourceObservedAtStatusSchema,
  providerSchema,
  tradePackageDecisionSchema,
  unavailableDecisionSectionSchema,
} from "./decision-primitives.js";

// Decision primitives shared by the snapshot and the trade builder. A leaf module so the builder
// contract can import them without a circular read through this barrel.
export * from "./decision-primitives.js";

// User-constructed trade package evaluation.
export * from "./trade-evaluation.js";

// Kept in its own module because it parses a stored provider blob rather than a wire contract.
export * from "./league-rules.js";

// Source-quality and unresolved-identity diagnostics.
export * from "./data-quality.js";

// Post-draft analysis envelope. Its own module because this barrel is a re-export surface rather
// than a home for new domains.
export * from "./draft-analysis.js";

// Stored provenance for a persisted recommendation run (ADR 0003). Written by the worker's
// recompute; read by the change-event feed.
export * from "./recommendation-runs.js";

// A versioned payload registry plus the feed's wire shapes, kept separate because it is a registry
// rather than a single wire contract and must degrade rather than throw on an unknown version.
export * from "./change-events.js";

// Typed, read-only AI tool declarations and their ADR 0003 result provenance. Its own module so
// the model-facing surface is versioned independently of the deterministic contracts it wraps.
export * from "./ai-tools.js";

// Six independent rest-of-season release facts. Deliberately not collapsible into one verdict:
// conflating artifact state with shadow-audit state previously produced the wrong conclusion that
// all ROS publication was disabled.
export * from "./ros-release-status.js";

// The Weekly Reckoning recap envelope. Its own module because this barrel is a re-export surface
// rather than a home for new domains.
export * from "./weekly-recap.js";

// Shared automated ESPN refresh and sync-agent wire protocol.
export * from "./espn-refresh.js";

// Opt-in encrypted ESPN web-session connection contracts.
export * from "./espn-session.js";

// Mirrored here so the browser contract bundle has no runtime dependency on the domain package.
// Response parsing fails closed if service vocabulary ever drifts from this wire contract.
const NFL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST", "DL", "LB", "DB", "IDP"] as const;
export const NFL_TEAMS = [
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

export const leagueRemovalRequestSchema = z.object({
  confirmation: z.string().min(1).max(500),
});

export const leagueRemovalResponseSchema = z.object({
  leagueId: z.string().uuid(),
  leagueName: z.string(),
  leagueDeleted: z.boolean(),
  ownershipTransferred: z.boolean(),
  removedAt: z.iso.datetime(),
});
export type LeagueRemovalResponse = z.infer<typeof leagueRemovalResponseSchema>;

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

/**
 * Provider-hosted team logo. The connector normalizers are the single enforcement point for
 * https-only URLs; this schema keeps a malformed or oversized value from reaching a member's
 * browser rather than re-validating the provider's host.
 */
export const teamLogoUrlSchema = z.string().url().max(2_000).nullable();

export const leagueStandingEntrySchema = z.object({
  teamId: z.string().uuid(),
  teamName: z.string(),
  abbreviation: z.string().nullable(),
  managerDisplayName: z.string().nullable(),
  logoUrl: teamLogoUrlSchema,
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
  logoUrl: teamLogoUrlSchema,
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
  teamLogoUrl: teamLogoUrlSchema,
  standingRank: z.number().int().positive().nullable(),
  wins: z.number().int().nonnegative().nullable(),
  losses: z.number().int().nonnegative().nullable(),
  ties: z.number().int().nonnegative().nullable(),
  opponentTeamId: z.string().uuid().nullable(),
  opponentTeamName: z.string().nullable(),
  opponentLogoUrl: teamLogoUrlSchema,
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

const yahooBrowserReturnToSchema = z
  .string()
  .max(1024)
  .regex(/^\/(?!\/)[\x20-\x7E]*$/u, "must be an application-relative path")
  .refine((value) => !value.includes("\\"), "must not contain a backslash");

/** Closed completion behavior persisted with a Yahoo OAuth state; never a caller-provided URL. */
export const yahooReturnModeSchema = z.enum(["browser", "ios-app"]);
export type YahooReturnMode = z.infer<typeof yahooReturnModeSchema>;

const yahooBrowserAuthorizeRequestSchema = z
  .object({
    returnMode: z.literal("browser").optional(),
    returnTo: yahooBrowserReturnToSchema.default("/connections"),
  })
  .strict()
  .transform((input) => ({ returnMode: "browser" as const, returnTo: input.returnTo }));

const yahooIosAuthorizeRequestSchema = z
  .object({ returnMode: z.literal("ios-app") })
  .strict()
  // The browser fallback stays server-selected even though an iOS completion never uses it.
  .transform(() => ({ returnMode: "ios-app" as const, returnTo: "/connections" as const }));

/**
 * Browser callers remain source-compatible with `{ returnTo }` (or an empty body). Native callers
 * can select only the fixed iOS completion contract and cannot supply any callback or return path.
 */
export const yahooAuthorizeRequestSchema = z.union([
  yahooIosAuthorizeRequestSchema,
  yahooBrowserAuthorizeRequestSchema,
]);
export type YahooAuthorizeRequest = z.infer<typeof yahooAuthorizeRequestSchema>;

export const yahooAuthorizeResponseSchema = z
  .object({
    authorizationUrl: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const yahooIosCompletionStatusSchema = z.enum([
  "connected",
  "denied",
  "unavailable",
  "failed",
]);
export type YahooIosCompletionStatus = z.infer<typeof yahooIosCompletionStatusSchema>;

/** Credential-free ASWebAuthenticationSession callbacks owned by the Laces Out iOS application. */
export const YAHOO_IOS_COMPLETION_URLS = Object.freeze({
  connected: "lacesout://connections/yahoo?status=connected",
  denied: "lacesout://connections/yahoo?status=denied",
  unavailable: "lacesout://connections/yahoo?status=unavailable",
  failed: "lacesout://connections/yahoo?status=failed",
} satisfies Readonly<Record<YahooIosCompletionStatus, string>>);

export const espnSyncAgentCapabilitySchema = z.literal("refresh-intents-v1");

const espnBridgeDeviceRequestObjectSchema = z.object({
  name: z.string().trim().min(1).max(80).default("ESPN browser bridge"),
  clientKind: z.enum(["chrome-extension", "ios-app"]).default("chrome-extension"),
  agentCapabilities: z
    .array(espnSyncAgentCapabilitySchema)
    .max(1)
    .refine((values) => new Set(values).size === values.length, "capabilities must be unique")
    .default([]),
  season: z.number().int().min(2000).max(2100).optional(),
  allowedLeagueIds: z
    .array(z.string().regex(/^\d{1,20}$/u))
    .min(1)
    .max(32)
    .refine((values) => new Set(values).size === values.length, "league IDs must be unique"),
});

export const espnBridgeDeviceRequestSchema = espnBridgeDeviceRequestObjectSchema.superRefine(
  (value, context) => {
    if (value.clientKind === "ios-app" && !value.agentCapabilities.includes("refresh-intents-v1")) {
      context.addIssue({
        code: "custom",
        path: ["agentCapabilities"],
        message: "iOS sync devices must declare refresh-intents-v1",
      });
    }
    if (value.clientKind === "ios-app" && value.season === undefined) {
      context.addIssue({
        code: "custom",
        path: ["season"],
        message: "iOS sync devices require an exact season",
      });
    }
  },
);

export const espnBridgeDeviceResponseSchema = z.object({
  deviceId: z.string().uuid(),
  clientKind: z.enum(["chrome-extension", "ios-app"]),
  agentCapable: z.boolean(),
  deviceToken: z.string().min(32).max(512),
  expiresAt: z.iso.datetime().nullable(),
});

export const espnBridgePairingCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/u, "must be a valid Laces Out pairing code");

export const espnBridgePairingSessionRequestSchema = espnBridgeDeviceRequestObjectSchema.extend({
  clientKind: z.literal("chrome-extension").default("chrome-extension"),
  agentCapabilities: z.tuple([espnSyncAgentCapabilitySchema]).default(["refresh-intents-v1"]),
  season: z.number().int().min(2000).max(2100),
});

export const espnBridgePairingSessionResponseSchema = z.object({
  pairingCode: espnBridgePairingCodeSchema,
  expiresAt: z.iso.datetime(),
});

export const espnBridgePairingRedeemRequestSchema = z.object({
  pairingCode: espnBridgePairingCodeSchema,
});

export const espnBridgePairingRedeemResponseSchema = espnBridgeDeviceResponseSchema.extend({
  expiresAt: z.iso.datetime(),
  leagueIds: espnBridgeDeviceRequestObjectSchema.shape.allowedLeagueIds,
  season: z.number().int().min(2000).max(2100),
  automaticSync: z.literal(true),
  agentCapable: z.literal(true),
});

export const espnBridgeDeviceStatusSchema = z.object({
  deviceId: z.string().uuid(),
  clientKind: z.enum(["chrome-extension", "ios-app"]),
  agentCapable: z.boolean(),
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

export const espnPayloadChecksumAlgorithmSchema = z.enum([
  "json-stringify-sha256",
  "canonical-json-v1-sha256",
]);

export const espnBridgeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("espn"),
    authority: z.enum(["browser-local", "native-local"]),
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
    checksumAlgorithm: espnPayloadChecksumAlgorithmSchema.optional(),
    payload: z.unknown(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.authority === "native-local" &&
      value.checksumAlgorithm !== "canonical-json-v1-sha256"
    ) {
      context.addIssue({
        code: "custom",
        path: ["checksumAlgorithm"],
        message: "native agents must use portable canonical JSON checksums",
      });
    }
  });
export type EspnBridgeSnapshot = z.infer<typeof espnBridgeSnapshotSchema>;

const espnSupplementalBridgeBase = {
  schemaVersion: z.literal(1),
  provider: z.literal("espn"),
  authority: z.enum(["browser-local", "native-local"]),
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
  checksumAlgorithm: espnPayloadChecksumAlgorithmSchema.optional(),
  payload: z.unknown(),
} as const;

export const espnSupplementalBridgeSnapshotSchema = z
  .discriminatedUnion("kind", [
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
  ])
  .superRefine((value, context) => {
    if (
      value.authority === "native-local" &&
      value.checksumAlgorithm !== "canonical-json-v1-sha256"
    ) {
      context.addIssue({
        code: "custom",
        path: ["checksumAlgorithm"],
        message: "native agents must use portable canonical JSON checksums",
      });
    }
  });
export type EspnSupplementalBridgeSnapshot = z.infer<typeof espnSupplementalBridgeSnapshotSchema>;

export const espnBridgeReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  state: z.enum(["accepted", "unchanged"]),
  receivedAt: z.iso.datetime(),
});

/**
 * Bounds for the ESPN live draft feed. Every limit is named here so the browser companion, the
 * ingest route, and the reconciler agree on one number instead of three drifting literals.
 */
export const ESPN_LIVE_DRAFT_LIMITS = {
  /** Rejected above this size before the body is parsed. */
  maximumBodyBytes: 1_048_576,
  maximumTeams: 32,
  maximumPicks: 1_000,
  maximumTeamNameLength: 80,
  maximumPlayerNameLength: 120,
  maximumPrice: 100_000,
  /** Heartbeat cadence the companion aims for while a draft is live. */
  heartbeatIntervalMs: 5_000,
  /** A feed observed within this window is reported fresh. */
  freshWindowMs: 10_000,
  /** A standby source may claim the lease once the active one goes quiet this long. */
  failoverEligibleMs: 25_000,
  /** Beyond this the feed is reported disconnected rather than merely stale. */
  disconnectedMs: 60_000,
  /** Ceiling on transient auction uploads so a bidding war cannot flood the API. */
  transientUploadsPerSecond: 2,
  /**
   * A destructive snapshot must be seen this many times before it rewrites accepted history.
   * Guards against a mid-render ESPN table looking like a commissioner rollback.
   */
  destructiveConfirmations: 2,
} as const;

/** ESPN exposes D/ST as negative player IDs, so the player form permits a leading sign. */
const espnProviderTeamIdSchema = z.string().regex(/^\d{1,20}$/u);
const espnProviderPlayerIdSchema = z.string().regex(/^-?\d{1,20}$/u);

/**
 * Text lifted from a provider page is untrusted. Control characters are rejected outright so a
 * hostile or malformed DOM cannot smuggle framing into logs, names, or downstream rendering.
 */
function espnLiveDraftText(maximum: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/\p{Cc}/u.test(value), "must not contain control characters");
}

const espnLiveDraftStateSchema = z.enum(["waiting", "live", "paused", "complete"]);
const espnLiveDraftTypeSchema = z.enum(["snake", "auction"]);

const espnLiveDraftPickSchema = z
  .object({
    sequence: z.number().int().min(1).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
    round: z.number().int().min(1).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks).nullable(),
    roundPick: z.number().int().min(1).max(ESPN_LIVE_DRAFT_LIMITS.maximumTeams).nullable(),
    keeper: z.boolean(),
    providerTeamId: espnProviderTeamIdSchema.nullable(),
    teamName: espnLiveDraftText(ESPN_LIVE_DRAFT_LIMITS.maximumTeamNameLength),
    providerPlayerId: espnProviderPlayerIdSchema.nullable(),
    playerName: espnLiveDraftText(ESPN_LIVE_DRAFT_LIMITS.maximumPlayerNameLength),
    proTeam: espnLiveDraftText(12).nullable(),
    position: espnLiveDraftText(12).nullable(),
    price: z.number().int().min(0).max(ESPN_LIVE_DRAFT_LIMITS.maximumPrice).nullable(),
    nominatingProviderTeamId: espnProviderTeamIdSchema.nullable(),
  })
  .strict();
export type EspnLiveDraftPick = z.infer<typeof espnLiveDraftPickSchema>;

const espnLiveDraftPickOwnershipSchema = z
  .object({
    overallPick: z.number().int().min(1).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
    providerTeamId: espnProviderTeamIdSchema.nullable(),
    teamName: espnLiveDraftText(ESPN_LIVE_DRAFT_LIMITS.maximumTeamNameLength),
  })
  .strict();
export type EspnLiveDraftPickOwnership = z.infer<typeof espnLiveDraftPickOwnershipSchema>;

const espnLiveDraftCurrentAuctionSchema = z
  .object({
    nominationNumber: z.number().int().min(1).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
    nominatingProviderTeamId: espnProviderTeamIdSchema.nullable(),
    providerPlayerId: espnProviderPlayerIdSchema.nullable(),
    playerName: espnLiveDraftText(ESPN_LIVE_DRAFT_LIMITS.maximumPlayerNameLength),
    proTeam: espnLiveDraftText(12).nullable(),
    position: espnLiveDraftText(12).nullable(),
    highBidProviderTeamId: espnProviderTeamIdSchema.nullable(),
    highBid: z.number().int().min(0).max(ESPN_LIVE_DRAFT_LIMITS.maximumPrice).nullable(),
  })
  .strict();
export type EspnLiveDraftCurrentAuction = z.infer<typeof espnLiveDraftCurrentAuctionSchema>;

export const espnLiveDraftObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("espn-live-draft"),
    leagueId: espnProviderTeamIdSchema,
    season: z.number().int().min(2019).max(2100),
    /** Extension-generated random UUID. Never an ESPN token, cookie, or session identifier. */
    pageSessionId: z.string().uuid(),
    revision: z.number().int().min(0).max(1_000_000),
    capturedAt: z.iso.datetime(),
    state: espnLiveDraftStateSchema,
    draftType: espnLiveDraftTypeSchema,
    expectedTeamCount: z.number().int().min(2).max(ESPN_LIVE_DRAFT_LIMITS.maximumTeams),
    expectedRosterSize: z.number().int().min(1).max(100).nullable(),
    pickOwnership: z
      .array(espnLiveDraftPickOwnershipSchema)
      .max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
    picks: z.array(espnLiveDraftPickSchema).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
    currentAuction: espnLiveDraftCurrentAuctionSchema.nullable(),
    completeness: z
      .object({
        contiguousThrough: z.number().int().min(0).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
        duplicateSequences: z.number().int().min(0).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
        unresolvedRows: z.number().int().min(0).max(ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
      })
      .strict(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.completeness.contiguousThrough > observation.picks.length) {
      context.addIssue({
        code: "custom",
        path: ["completeness", "contiguousThrough"],
        message: "cannot exceed the number of reported picks",
      });
    }
    if (observation.draftType === "snake" && observation.currentAuction !== null) {
      context.addIssue({
        code: "custom",
        path: ["currentAuction"],
        message: "snake drafts cannot report auction nomination state",
      });
    }
    const ownership = new Set(observation.pickOwnership.map((entry) => entry.overallPick));
    if (ownership.size !== observation.pickOwnership.length) {
      context.addIssue({
        code: "custom",
        path: ["pickOwnership"],
        message: "overall pick ownership must be unique",
      });
    }
  });
export type EspnLiveDraftObservation = z.infer<typeof espnLiveDraftObservationSchema>;

/**
 * Canonical serialization the observation checksum is taken over.
 *
 * Deliberately covers only durable board facts. `capturedAt`, `revision`, `pageSessionId`, and the
 * transient auction block are excluded so that re-observing an unchanged board yields the same
 * checksum — that identity is what makes a replayed snapshot an idempotent no-op instead of a new
 * material event. Field order is fixed here rather than inherited from wire JSON key order, so the
 * browser companion and the server can compute it independently and still agree.
 *
 * The browser companion mirrors this function; `espnLiveDraftDigestGolden` pins both to one value.
 */
export function espnLiveDraftDigestSource(observation: {
  readonly leagueId: string;
  readonly season: number;
  readonly state: EspnLiveDraftObservation["state"];
  readonly draftType: EspnLiveDraftObservation["draftType"];
  readonly expectedTeamCount: number;
  readonly expectedRosterSize: number | null;
  readonly pickOwnership: readonly EspnLiveDraftPickOwnership[];
  readonly picks: readonly EspnLiveDraftPick[];
}): string {
  return JSON.stringify([
    "espn-live-draft/1",
    observation.leagueId,
    observation.season,
    observation.state,
    observation.draftType,
    observation.expectedTeamCount,
    observation.expectedRosterSize,
    observation.pickOwnership.map((entry) => [
      entry.overallPick,
      entry.providerTeamId,
      entry.teamName,
    ]),
    observation.picks.map((pick) => [
      pick.sequence,
      pick.round,
      pick.roundPick,
      pick.keeper,
      pick.providerTeamId,
      pick.teamName,
      pick.providerPlayerId,
      pick.playerName,
      pick.proTeam,
      pick.position,
      pick.price,
      pick.nominatingProviderTeamId,
    ]),
  ]);
}

/**
 * A fixed observation and the digest it must produce. Imported by both the server and the browser
 * companion's tests; if either canonicalizer drifts, one of those tests fails instead of every
 * live observation silently failing its checksum mid-draft.
 */
export const espnLiveDraftDigestGolden = {
  observation: {
    leagueId: "1234567",
    season: 2026,
    state: "live",
    draftType: "snake",
    expectedTeamCount: 2,
    expectedRosterSize: 1,
    pickOwnership: [
      { overallPick: 1, providerTeamId: "1", teamName: "Ditka's Revenge" },
      { overallPick: 2, providerTeamId: "2", teamName: "Finkle Is Einhorn" },
    ],
    picks: [
      {
        sequence: 1,
        round: 1,
        roundPick: 1,
        keeper: false,
        providerTeamId: "1",
        teamName: "Ditka's Revenge",
        providerPlayerId: "3139477",
        playerName: "Patrick Mahomes",
        proTeam: "KC",
        position: "QB",
        price: null,
        nominatingProviderTeamId: null,
      },
    ],
  },
  source:
    '["espn-live-draft/1","1234567",2026,"live","snake",2,1,[[1,"1","Ditka\'s Revenge"],[2,"2","Finkle Is Einhorn"]],[[1,1,1,false,"1","Ditka\'s Revenge","3139477","Patrick Mahomes","KC","QB",null,null]]]',
} as const;

export const espnLiveDraftHeartbeatSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("espn-live-draft-heartbeat"),
    leagueId: espnProviderTeamIdSchema,
    season: z.number().int().min(2019).max(2100),
    pageSessionId: z.string().uuid(),
    revision: z.number().int().min(0).max(1_000_000),
    capturedAt: z.iso.datetime(),
    state: espnLiveDraftStateSchema,
    /** Lets the server confirm a standby is holding the same board before granting the lease. */
    lastChecksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict();
export type EspnLiveDraftHeartbeat = z.infer<typeof espnLiveDraftHeartbeatSchema>;

export const espnLiveDraftIngestRequestSchema = z.discriminatedUnion("kind", [
  espnLiveDraftObservationSchema,
  espnLiveDraftHeartbeatSchema,
]);
export type EspnLiveDraftIngestRequest = z.infer<typeof espnLiveDraftIngestRequestSchema>;

export const espnLiveDraftFeedStateSchema = z.enum([
  "waiting",
  "live",
  "paused",
  "stale",
  "complete",
  "degraded",
]);
export type EspnLiveDraftFeedState = z.infer<typeof espnLiveDraftFeedStateSchema>;

/**
 * Bounded reasons an observation did not advance the board. Kept as an enum so logs and metrics
 * never carry free text lifted from a provider page.
 */
export const espnLiveDraftIssueCodeSchema = z.enum([
  "UNRESOLVED_TEAM",
  "UNRESOLVED_PLAYER",
  "PICK_SEQUENCE_GAP",
  "DUPLICATE_PICK_SEQUENCE",
  "EMPTY_RENDER",
  "PICK_OWNERSHIP_UNKNOWN",
  "DRAFT_TYPE_MISMATCH",
  "TEAM_COUNT_MISMATCH",
  "ROSTER_CAPACITY_EXCEEDED",
  "PRICE_ILLEGAL",
  "REDUCER_INVARIANT",
  "DESTRUCTIVE_PENDING",
  "MANUAL_BACKUP_ACTIVE",
  "STALE_PAGE_REVISION",
  "CHECKSUM_MISMATCH",
  "SESSION_NOT_READY",
]);
export type EspnLiveDraftIssueCode = z.infer<typeof espnLiveDraftIssueCodeSchema>;

export const espnLiveDraftIngestResponseSchema = z
  .object({
    status: z.enum(["accepted", "idempotent", "standby", "held", "rejected"]),
    draftId: z.string().uuid().nullable(),
    serverSequence: z.number().int().min(0).nullable(),
    feedState: espnLiveDraftFeedStateSchema,
    acceptedChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    unresolvedTeams: z.number().int().min(0),
    unresolvedPlayers: z.number().int().min(0),
    issueCode: espnLiveDraftIssueCodeSchema.nullable(),
    sourceLeaseExpiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type EspnLiveDraftIngestResponse = z.infer<typeof espnLiveDraftIngestResponseSchema>;

/**
 * Current nomination state, resolved to internal identities. Transient by design: it lives on the
 * feed row rather than the permanent event ledger so a bidding war never bloats draft history.
 */
export const espnLiveDraftTransientAuctionSchema = z
  .object({
    nominationNumber: z.number().int().min(1),
    nominatingTeamId: z.string().uuid().nullable(),
    playerId: z.string().uuid().nullable(),
    playerName: espnLiveDraftText(ESPN_LIVE_DRAFT_LIMITS.maximumPlayerNameLength),
    proTeam: espnLiveDraftText(12).nullable(),
    position: espnLiveDraftText(12).nullable(),
    highBidTeamId: z.string().uuid().nullable(),
    highBid: z.number().int().min(0).nullable(),
    observedAt: z.iso.datetime(),
  })
  .strict();
export type EspnLiveDraftTransientAuction = z.infer<typeof espnLiveDraftTransientAuctionSchema>;

/**
 * Feed health as shown to every league viewer. Deliberately carries no device token, device label,
 * ESPN username, or session material — only whether a source is supplying the board and how fresh
 * it is.
 */
export const espnLiveDraftFeedStatusSchema = z
  .object({
    provider: z.literal("espn"),
    state: espnLiveDraftFeedStateSchema,
    providerLeagueId: espnProviderTeamIdSchema,
    season: z.number().int().min(2019).max(2100),
    fresh: z.boolean(),
    ageSeconds: z.number().min(0).nullable(),
    lastAcceptedAt: z.iso.datetime().nullable(),
    lastMaterialEventAt: z.iso.datetime().nullable(),
    pickCount: z.number().int().min(0),
    unresolvedTeams: z.number().int().min(0),
    unresolvedPlayers: z.number().int().min(0),
    /** True while an owner or commissioner has frozen provider application. */
    manualBackupActive: z.boolean(),
    /** Provider snapshots validated but withheld while manual backup is active. */
    pendingReconciliation: z.number().int().min(0),
    standbySources: z.number().int().min(0),
    verification: z.enum(["pending", "verified", "mismatched"]),
    lastIssueCode: espnLiveDraftIssueCodeSchema.nullable(),
    currentAuction: espnLiveDraftTransientAuctionSchema.nullable(),
  })
  .strict();
export type EspnLiveDraftFeedStatus = z.infer<typeof espnLiveDraftFeedStatusSchema>;

/**
 * Stream payload. Carries only enough to invalidate a cached session, so there is exactly one
 * canonical response contract for draft state and reconnect stays trivial.
 */
export const draftStreamInvalidationSchema = z
  .object({
    draftId: z.string().uuid(),
    sequence: z.number().int().min(0),
    feedRevision: z.number().int().min(0),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type DraftStreamInvalidation = z.infer<typeof draftStreamInvalidationSchema>;

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

/**
 * How a room returns to provider control after a manual backup freeze.
 *
 * `accept-provider` lets the next observation reconcile normally; `keep-manual` keeps this ledger
 * as written. Neither choice reverts a manual event — the reconciler still refuses to rewrite a
 * room that contains one.
 */
export const draftManualBackupReconciliationSchema = z.enum(["accept-provider", "keep-manual"]);
export type DraftManualBackupReconciliation = z.infer<typeof draftManualBackupReconciliationSchema>;

export const draftManualBackupRequestSchema = z
  .object({
    expectedSequence: draftSequenceSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
    active: z.boolean(),
    /** Required only when deactivating with provider snapshots held; the server decides. */
    reconciliation: draftManualBackupReconciliationSchema.optional(),
  })
  .strict();
export type DraftManualBackupRequest = z.infer<typeof draftManualBackupRequestSchema>;

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

export const draftTransportSchema = z.enum(["manual", "espn-live"]);
export type DraftTransport = z.infer<typeof draftTransportSchema>;

/** Provenance travels with every event so provider facts stay distinguishable from manual ones. */
export const draftEventSourceSchema = z.enum(["manual", "espn"]);
export type DraftEventSource = z.infer<typeof draftEventSourceSchema>;

export const draftSessionSnapshotSchema = z
  .object({
    id: draftUuidSchema,
    leagueSeasonId: draftUuidSchema,
    transport: draftTransportSchema,
    /** True only while a provider feed is actually supplying this room. */
    providerPolling: z.boolean(),
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
          source: draftEventSourceSchema,
          occurredAt: z.iso.datetime(),
          revertsSequence: draftPositiveIntegerSchema.nullable(),
          event: draftEventSchema,
        })
        .strict(),
    ),
    /** Null for a manual room. Present whenever an ESPN feed is attached, healthy or not. */
    providerFeed: espnLiveDraftFeedStatusSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (session) => session.transport !== "manual" || session.providerFeed === null,
    "a manual draft session cannot carry a provider feed",
  );
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
        /** ADR 0003: every recommendation-shaped output retains its algorithm version… */
        algorithmVersion: z.string().min(1).max(120),
        /** …and the checksum of the inputs it was computed from. */
        inputChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
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
    week: z.number().int().min(1).max(25).nullable(),
    horizon: projectionImportHorizonSchema,
    playerCount: z.number().int().nonnegative().max(5_000),
    inputChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    sourceChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    sourceObservedAt: z.iso.datetime().nullable(),
    sourceObservedAtStatus: projectionSourceObservedAtStatusSchema,
    importedAt: z.iso.datetime(),
    isOwnedByCurrentUser: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.horizon === "week" && value.week === null) ||
      (value.horizon === "rest-of-season" && value.week !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["week"],
        message: "Weekly sets require a week; rest-of-season sets must use a null week",
      });
    }
  });
export type ProjectionSetSummary = z.infer<typeof projectionSetSummarySchema>;

export const projectionPlayerRosSummarySchema = z
  .object({
    windowStartWeek: z.number().int().min(1).max(25),
    windowEndWeek: z.number().int().min(1).max(25),
    asOfWeek: z.number().int().min(0).max(24),
    asOfAt: z.iso.datetime(),
    scheduledGames: z.number().int().min(0).max(25),
    expectedGames: z.number().min(0).max(25),
    medianPoints: z.number().min(-2_500).max(5_000),
    meanPointsPerExpectedGame: z.number().min(-100).max(200).nullable(),
    pointsStddev: z.number().min(0).max(1_000),
  })
  .strict();
export type ProjectionPlayerRosSummary = z.infer<typeof projectionPlayerRosSummarySchema>;

export const projectionPlayerRowSchema = z
  .object({
    playerId: z.string().uuid(),
    fullName: z.string().min(1).max(200),
    nflTeam: z.string().min(1).max(12).nullable(),
    primaryPosition: z.string().min(1).max(20),
    eligiblePositions: z.array(z.string().min(1).max(20)).max(12),
    status: z.string().min(1).max(80).nullable(),
    overallRank: z.number().int().positive().max(5_000),
    positionRank: z.number().int().positive().max(5_000),
    meanPoints: z.number().min(-2_500).max(5_000),
    floorPoints: z.number().min(-2_500).max(5_000).nullable(),
    ceilingPoints: z.number().min(-2_500).max(5_000).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    ros: projectionPlayerRosSummarySchema.nullable(),
  })
  .strict();
export type ProjectionPlayerRow = z.infer<typeof projectionPlayerRowSchema>;

export const projectionPlayerListResponseSchema = z
  .object({
    projectionSet: projectionSetSummarySchema,
    players: z.array(projectionPlayerRowSchema).max(5_000),
  })
  .strict();
export type ProjectionPlayerListResponse = z.infer<typeof projectionPlayerListResponseSchema>;

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
  "AWARDS_WEEK_UNAVAILABLE",
  "PLAYOFF_RULES_MISSING",
  "PLAYOFF_FIELD_UNSUPPORTED",
  "PLAYOFF_SEASON_COMPLETE",
  "PLAYOFF_SCHEDULE_INCOMPLETE",
  "PLAYOFF_SIMULATION_UNSUPPORTED",
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
    logoUrl: teamLogoUrlSchema,
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

export const weeklyAwardIdSchema = z.enum([
  "bad-beat",
  "horseshoe",
  "bench-warmer",
  "beatdown",
  "photo-finish",
]);
export type WeeklyAwardId = z.infer<typeof weeklyAwardIdSchema>;

export const weeklyAwardWithheldCodeSchema = z.enum([
  "WEEK_MISSING",
  "MATCHUPS_MISSING",
  "SCORES_INCOMPLETE",
  "LINEUP_POINTS_MISSING",
  "NO_QUALIFYING_TEAM",
]);
export type WeeklyAwardWithheldCode = z.infer<typeof weeklyAwardWithheldCodeSchema>;

const weeklyAwardWithheldReasonSchema = z
  .object({
    code: weeklyAwardWithheldCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

const weeklyAwardSchema = z
  .object({
    id: weeklyAwardIdSchema,
    label: z.string().min(1).max(120),
    definition: z.string().min(1).max(1_000),
    team: leagueAnalyticsTeamSchema,
    /** The number that earned the award, in `unit`. */
    value: z.number().finite(),
    unit: z.enum(["points", "percent"]),
    detail: z
      .object({
        opponentTeam: leagueAnalyticsTeamSchema.nullable(),
        teamPoints: z.number().finite().nullable(),
        opponentPoints: z.number().finite().nullable(),
        allPlayWins: z.number().finite().nonnegative().nullable(),
        allPlayGames: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export type WeeklyAward = z.infer<typeof weeklyAwardSchema>;

const withheldWeeklyAwardSchema = z
  .object({
    id: weeklyAwardIdSchema,
    label: z.string().min(1).max(120),
    reasons: z.array(weeklyAwardWithheldReasonSchema).min(1).max(10),
  })
  .strict();
export type WithheldWeeklyAward = z.infer<typeof withheldWeeklyAwardSchema>;

export const leagueWeeklyAwardsSectionSchema = z.discriminatedUnion("state", [
  leagueAnalyticsUnavailableSectionSchema,
  z
    .object({
      state: z.literal("available"),
      week: z.number().int().min(1).max(30),
      awards: z.array(weeklyAwardSchema).max(10),
      /** Awards the evidence did not support, each carrying why. Never rendered as a zero. */
      withheld: z.array(withheldWeeklyAwardSchema).max(10),
      definitions: z.array(analyticsMetricDefinitionSchema).max(12),
    })
    .strict(),
]);
export type LeagueWeeklyAwardsSection = z.infer<typeof leagueWeeklyAwardsSectionSchema>;

const leaguePlayoffSeedProbabilitySchema = z
  .object({
    seed: z.number().int().min(1).max(32),
    probability: z.number().min(0).max(1),
  })
  .strict();

const leaguePlayoffOddsTeamSchema = z
  .object({
    team: leagueAnalyticsTeamSchema,
    playoffProbability: z.number().min(0).max(1),
    /**
     * Sampling uncertainty of the simulation itself. It is deliberately not model uncertainty: a
     * tiny standard error says the Monte Carlo run converged, never that the forecast is right.
     */
    monteCarloStandardError: z.number().min(0).max(1),
    expectedSeed: z.number().finite().positive(),
    /** One entry per league seed, so a distribution is read whole rather than as a single number. */
    seedProbabilities: z.array(leaguePlayoffSeedProbabilitySchema).max(32),
    averageFinalWins: z.number().finite().nonnegative(),
    averageFinalLosses: z.number().finite().nonnegative(),
    averageFinalTies: z.number().finite().nonnegative(),
    averageFinalPointsFor: z.number().finite(),
    scoringMean: z.number().finite(),
    scoringStandardDeviation: z.number().finite().nonnegative(),
  })
  .strict();

export const leaguePlayoffOddsSectionSchema = z.discriminatedUnion("state", [
  leagueAnalyticsUnavailableSectionSchema,
  z
    .object({
      state: z.literal("available"),
      playoffTeamCount: z.number().int().min(1).max(32),
      /**
       * The reproducibility pair required by ADR 0003. The seed is derived only from league
       * season, week, and matchup snapshot, so re-running these two values against the same
       * stored state replays this exact result.
       */
      seed: z.string().min(1).max(300),
      simulations: z.number().int().positive().max(1_000_000),
      /** The matchup snapshot the seed was derived from, so a replay can be pinned to it. */
      matchupSnapshotId: z.string().uuid().nullable(),
      remainingMatchups: z.number().int().nonnegative(),
      /** Where each team's future weekly scoring mean and volatility came from. */
      forecastBasis: analyticsMetricDefinitionSchema,
      teams: z.array(leaguePlayoffOddsTeamSchema).max(32),
      definition: z.string().min(1).max(1_000),
      factors: z.array(z.string().min(1).max(300)).max(12),
      tieBreakers: z.array(z.string().min(1).max(300)).max(12),
      /** How the engine itself defines its standard error, kept separate from forecast basis. */
      samplingErrorDefinition: z.string().min(1).max(1_000).nullable(),
    })
    .strict(),
]);
export type LeaguePlayoffOddsSection = z.infer<typeof leaguePlayoffOddsSectionSchema>;

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
    weeklyAwards: leagueWeeklyAwardsSectionSchema,
    /**
     * Every completed week the deterministic award engine can build, ascending. The recap week
     * selector reads exactly this list, so a client never guesses which weeks are selectable.
     * Empty whenever no season, a bounded-read limitation, or missing final scores leaves the
     * awards section unavailable.
     */
    weeklyAwardWeeks: z.array(z.number().int().min(1).max(30)).max(30),
    /**
     * Optional only so snapshots authored before playoff odds existed still parse. The live
     * service always emits it, in one state or the other.
     */
    playoffOdds: leaguePlayoffOddsSectionSchema,
  })
  .strict();
export type LeagueAnalyticsSnapshot = z.infer<typeof leagueAnalyticsSnapshotSchema>;

export const aiProviderNameSchema = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "grok",
  "openrouter",
]);
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
    providers: z.array(aiProviderConfigurationSchema).length(6),
    includedRecapProvider: z
      .object({
        provider: aiProviderNameSchema,
        model: z.string().min(1).max(160),
        dailyRequestLimitPerSpice: z.number().int().min(1).max(500),
      })
      .strict()
      .nullable()
      .optional(),
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
  })
  .strict();
export type AiAnalysisResponse = z.infer<typeof aiAnalysisResponseSchema>;

export const aiFeatureNameSchema = z.enum([
  "weekly-brief",
  "start-sit",
  "waiver-scan",
  "trade-builder",
  "standings-prediction",
  "weekly-recap",
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

/** Metrics summed from the stored stat components, so a total and a per-game both apply. */
export const statsCenterAdditiveMetricSchema = z.enum([
  "passCompletions",
  "passAttempts",
  "passYards",
  "passTouchdowns",
  "passInterceptions",
  "rushYards",
  "rushTouchdowns",
  "receptions",
  "recYards",
  "recTouchdowns",
  "fumblesLost",
  "pointsStandard",
  "pointsPpr",
  "passAirYards",
  "passYardsAfterCatch",
  "passEpa",
  "rushEpa",
  "recAirYards",
  "recYardsAfterCatch",
  "recEpa",
]);
export type StatsCenterAdditiveMetric = z.infer<typeof statsCenterAdditiveMetricSchema>;

/** Rates, which carry a single window value rather than a total. */
export const statsCenterRatioMetricSchema = z.enum([
  "passAirConversionRatio",
  "airYardsShare",
  "weightedOpportunityRating",
  "completionPercentageOverExpected",
]);
export type StatsCenterRatioMetric = z.infer<typeof statsCenterRatioMetricSchema>;

export const statsCenterDerivedMetricSchema = z.enum([
  ...statsCenterAdditiveMetricSchema.options,
  ...statsCenterRatioMetricSchema.options,
]);
export type StatsCenterDerivedMetric = z.infer<typeof statsCenterDerivedMetricSchema>;

export const statsCenterSortSchema = z.enum([
  ...statsCenterMetricSchema.options,
  ...statsCenterDerivedMetricSchema.options,
]);
export type StatsCenterSort = z.infer<typeof statsCenterSortSchema>;

export const statsCenterTrendMetricSchema = z.enum([
  "targetsPerGame",
  "carriesPerGame",
  "opportunitiesPerGame",
  "targetShare",
  "offensiveSnapShare",
  "fantasyPoints",
]);
export type StatsCenterTrendMetric = z.infer<typeof statsCenterTrendMetricSchema>;

export const statsCenterScoringSchema = z.enum(["standard", "ppr"]);
export type StatsCenterScoring = z.infer<typeof statsCenterScoringSchema>;

const statsCenterAvailabilitySchema = z
  .object({
    state: z.enum(["available", "unavailable", "no-data"]),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();

/**
 * A derived metric plus how it fared for the requested window. Definitions ride here rather
 * than on every player so a withheld metric still explains itself exactly once.
 */
const statsCenterMetricDescriptorSchema = z
  .object({
    id: statsCenterDerivedMetricSchema,
    label: z.string().min(1).max(60),
    family: z.enum(["production", "efficiency"]),
    kind: z.enum(["additive", "derivedRatio", "perGameMean"]),
    definition: z.string().min(1).max(1_000),
    state: z.enum(["available", "unavailable", "no-data"]),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type StatsCenterMetricDescriptor = z.infer<typeof statsCenterMetricDescriptorSchema>;

const statsCenterAdditiveValuesSchema = z.record(
  statsCenterAdditiveMetricSchema,
  z.number().finite().nullable(),
);

const statsCenterRatioValuesSchema = z.record(
  statsCenterRatioMetricSchema,
  z.number().finite().nullable(),
);

const statsCenterTrendSchema = z
  .object({
    status: z.enum(["available", "unavailable"]),
    seasonAverage: z.number().finite().nullable(),
    recentWeightedAverage: z.number().finite().nullable(),
    absoluteChange: z.number().finite().nullable(),
    sampleSize: z.number().int().nonnegative(),
    recentSampleSize: z.number().int().nonnegative(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type StatsCenterTrend = z.infer<typeof statsCenterTrendSchema>;

const statsCenterBoomBustSchema = z
  .object({
    status: z.enum(["available", "unavailable"]),
    games: z.number().int().nonnegative(),
    missingGames: z.number().int().nonnegative(),
    booms: z.number().int().nonnegative().nullable(),
    busts: z.number().int().nonnegative().nullable(),
    neutral: z.number().int().nonnegative().nullable(),
    boomRate: z.number().min(0).max(1).nullable(),
    bustRate: z.number().min(0).max(1).nullable(),
    averagePoints: z.number().finite().nullable(),
    standardDeviation: z.number().finite().nonnegative().nullable(),
    threshold: z
      .object({
        boomAtOrAbove: z.number().finite(),
        bustAtOrBelow: z.number().finite(),
      })
      .strict()
      .nullable(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type StatsCenterBoomBust = z.infer<typeof statsCenterBoomBustSchema>;

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
    totals: statsCenterAdditiveValuesSchema,
    perGame: statsCenterAdditiveValuesSchema,
    ratios: statsCenterRatioValuesSchema,
    trend: z.record(statsCenterTrendMetricSchema, statsCenterTrendSchema),
    boomBust: statsCenterBoomBustSchema,
  })
  .strict();
export type StatsCenterPlayer = z.infer<typeof statsCenterPlayerSchema>;

const statsCenterFiltersSchema = z
  .object({
    season: z.number().int().min(2012).max(2200),
    weekFrom: z.number().int().min(1).max(25).nullable(),
    weekTo: z.number().int().min(1).max(25).nullable(),
    position: z.string().min(1).max(20).nullable(),
    team: z.string().min(2).max(4).nullable(),
    search: z.string().max(80),
    sort: statsCenterSortSchema,
    scoring: statsCenterScoringSchema,
    recentWindow: z.number().int().min(1).max(25),
    recentWeightDecay: z.number().positive().max(1),
    limit: z.number().int().min(1).max(250),
  })
  .strict();
export type StatsCenterFilters = z.infer<typeof statsCenterFiltersSchema>;

const statsCenterUsageAvailabilitySchema = z
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
  .strict();

const statsCenterDefinitionsSchema = z
  .object({
    opportunities: z.string().min(1).max(1_000),
    targetShare: z.string().min(1).max(1_000),
    offensiveSnapShare: z.string().min(1).max(1_000),
    recentTrend: z.string().min(1).max(1_000),
    boomBust: z.string().min(1).max(1_000),
  })
  .strict();

export const statsCenterResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    filters: statsCenterFiltersSchema,
    availability: statsCenterUsageAvailabilitySchema,
    metrics: z.array(statsCenterMetricDescriptorSchema).max(40),
    sources: z.array(statsCenterSourceSchema).length(2),
    players: z.array(statsCenterPlayerSchema).max(250),
    totalMatched: z.number().int().nonnegative(),
    truncated: z.boolean(),
    definitions: statsCenterDefinitionsSchema,
  })
  .strict();
export type StatsCenterResponse = z.infer<typeof statsCenterResponseSchema>;

const statsCenterGameLogEntrySchema = z
  .object({
    season: z.number().int().min(2012).max(2200),
    week: z.number().int().min(1).max(25),
    /** Null on a bye row, which has no game to point at. */
    gameId: z.string().min(1).max(64).nullable(),
    team: z.string().min(2).max(4).nullable(),
    opponentTeam: z.string().min(2).max(4).nullable(),
    targets: z.number().int().nonnegative().nullable(),
    teamTargets: z.number().int().nonnegative().nullable(),
    targetShare: z.number().min(0).max(1).nullable(),
    carries: z.number().int().nonnegative().nullable(),
    opportunities: z.number().int().nonnegative().nullable(),
    offensiveSnaps: z.number().int().nonnegative().nullable(),
    offensiveSnapShare: z.number().min(0).max(1).nullable(),
    points: z.number().finite().nullable(),
    /** Set only where the admitted schedule affirms the team had no game that week. */
    bye: z.boolean(),
  })
  .strict();
export type StatsCenterGameLogEntry = z.infer<typeof statsCenterGameLogEntrySchema>;

export const statsCenterPlayerDetailResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    filters: statsCenterFiltersSchema,
    player: z
      .object({
        playerId: z.string().uuid(),
        name: z.string().min(1).max(200),
        position: z.string().min(1).max(20),
        team: z.string().min(2).max(4).nullable(),
        status: z.string().min(1).max(80).nullable(),
        rookieSeason: z.number().int().min(1900).max(2200).nullable(),
      })
      .strict(),
    availability: statsCenterUsageAvailabilitySchema,
    metrics: z.array(statsCenterMetricDescriptorSchema).max(40),
    summary: statsCenterPlayerSchema,
    gameLog: z.array(statsCenterGameLogEntrySchema).max(30),
    sources: z.array(statsCenterSourceSchema).length(2),
    definitions: statsCenterDefinitionsSchema,
  })
  .strict();
export type StatsCenterPlayerDetailResponse = z.infer<typeof statsCenterPlayerDetailResponseSchema>;

const scheduleSourceSchema = z
  .object({
    dataset: z.literal("schedule"),
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
    coveredTeams: z.array(z.string().regex(/^[A-Z]{2,4}$/u)).max(40),
    quality: z
      .object({
        rowsRead: z.number().int().nonnegative().nullable(),
        rowsRejected: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type ScheduleSource = z.infer<typeof scheduleSourceSchema>;

const scheduleGameSchema = z
  .object({
    gameId: z.string().min(1).max(64),
    week: z.number().int().min(1).max(25),
    gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    /** Null whenever the source still reports the kickoff time as TBD. */
    startTimeEastern: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/u)
      .nullable(),
    timeTbd: z.boolean(),
    kickoffAt: z.iso.datetime().nullable(),
    awayTeam: z.string().regex(/^[A-Z]{2,4}$/u),
    homeTeam: z.string().regex(/^[A-Z]{2,4}$/u),
    status: z.enum(["scheduled", "in-progress", "final", "postponed", "cancelled"]),
    neutralSite: z.boolean(),
    awayScore: z.number().int().nonnegative().nullable(),
    homeScore: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ScheduleGame = z.infer<typeof scheduleGameSchema>;

const teamScheduleWeekSchema = z
  .object({
    week: z.number().int().min(1).max(25),
    /** `unknown` means coverage cannot distinguish a bye from a missing row. */
    state: z.enum(["game", "bye", "unknown"]),
    reason: z.string().min(1).max(500).nullable(),
    opponent: z
      .string()
      .regex(/^[A-Z]{2,4}$/u)
      .nullable(),
    venue: z.enum(["home", "away", "neutral"]).nullable(),
    gameId: z.string().min(1).max(64).nullable(),
    kickoffAt: z.iso.datetime().nullable(),
    timeTbd: z.boolean(),
    status: z.enum(["scheduled", "in-progress", "final", "postponed", "cancelled"]).nullable(),
    restDays: z.number().int().nonnegative().nullable(),
    teamScore: z.number().int().nonnegative().nullable(),
    opponentScore: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type TeamScheduleWeekEntry = z.infer<typeof teamScheduleWeekSchema>;

const teamScheduleSchema = z
  .object({
    team: z.string().regex(/^[A-Z]{2,4}$/u),
    weeks: z.array(teamScheduleWeekSchema).max(25),
    bye: z
      .object({
        status: z.enum(["available", "unavailable"]),
        byeWeeks: z.array(z.number().int().min(1).max(25)).max(25),
        reason: z.string().min(1).max(500).nullable(),
      })
      .strict(),
  })
  .strict();
export type TeamScheduleEntry = z.infer<typeof teamScheduleSchema>;

export const scheduleResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    filters: z
      .object({
        season: z.number().int().min(1999).max(2200),
        week: z.number().int().min(1).max(25).nullable(),
        team: z
          .string()
          .regex(/^[A-Z]{2,4}$/u)
          .nullable(),
      })
      .strict(),
    source: scheduleSourceSchema,
    games: z.array(scheduleGameSchema).max(400),
    teams: z.array(teamScheduleSchema).max(40),
    definitions: z
      .object({
        bye: z.string().min(1).max(1_000),
        venue: z.string().min(1).max(1_000),
      })
      .strict(),
  })
  .strict();
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

export const scheduleByesResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    season: z.number().int().min(1999).max(2200),
    source: scheduleSourceSchema,
    /** Only teams with exactly one affirmed bye appear; the rest are reported as withheld. */
    byeWeeks: z.record(z.string().regex(/^[A-Z]{2,4}$/u), z.number().int().min(1).max(25)),
    withheld: z
      .array(
        z
          .object({
            team: z.string().regex(/^[A-Z]{2,4}$/u),
            reason: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(40),
    definition: z.string().min(1).max(1_000),
  })
  .strict();
export type ScheduleByesResponse = z.infer<typeof scheduleByesResponseSchema>;

const scheduleEdgeAvailabilitySchema = z
  .object({
    state: z.enum(["available", "partial", "unavailable"]),
    reason: z.string().min(1).max(700).nullable(),
  })
  .strict();
export type ScheduleEdgeAvailability = z.infer<typeof scheduleEdgeAvailabilitySchema>;

const scheduleEdgeAlgorithmSchema = z
  .object({
    version: z.string().min(1).max(80),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
    evidenceChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    validationStatus: z.enum(["validated", "descriptive-only", "withheld"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.validationStatus !== "withheld" && value.evidenceChecksum === null) {
      context.addIssue({
        code: "custom",
        path: ["evidenceChecksum"],
        message: "Published Schedule Edge analysis requires a locked evidence checksum",
      });
    }
  });

const scheduleEdgeWindowSchema = z
  .object({
    startWeek: z.number().int().min(1).max(18),
    endWeek: z.number().int().min(1).max(18),
    label: z.string().min(1).max(80),
    source: z.enum(["request", "current-week", "provider", "fallback"]),
  })
  .strict();
export type ScheduleEdgeWindow = z.infer<typeof scheduleEdgeWindowSchema>;

const scheduleEdgeSourceSchema = z
  .object({
    dataset: z.enum(["schedule", "weekly-stats", "weekly-rosters", "projections"]),
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
    reason: z.string().min(1).max(700).nullable(),
  })
  .strict();
export type ScheduleEdgeSource = z.infer<typeof scheduleEdgeSourceSchema>;

const scheduleEdgeMatchupSchema = z
  .object({
    state: z.enum(["available", "unavailable"]),
    percentile: z.number().min(0).max(100).nullable(),
    label: z.enum(["favorable", "neutral", "difficult", "unavailable"]),
    confidence: z.enum(["high", "medium", "low", "unavailable"]),
    rawPointsAllowed: z.number().finite().nullable(),
    adjustedPointsAllowed: z.number().finite().nullable(),
    leagueAveragePoints: z.number().finite().nullable(),
    pointDifferential: z.number().finite().nullable(),
    currentGames: z.number().int().nonnegative(),
    priorGames: z.number().int().nonnegative(),
    incompleteGames: z.number().int().nonnegative(),
    reason: z.string().min(1).max(700).nullable(),
  })
  .strict();
export type ScheduleEdgeMatchup = z.infer<typeof scheduleEdgeMatchupSchema>;

const scheduleEdgeStrengthWeekSchema = z
  .object({
    week: z.number().int().min(1).max(18),
    state: z.enum(["game", "bye", "unknown"]),
    opponent: z
      .string()
      .regex(/^[A-Z]{2,4}$/u)
      .nullable(),
    percentile: z.number().min(0).max(100).nullable(),
    label: z.enum(["favorable", "neutral", "difficult", "unavailable"]),
    confidence: z.enum(["high", "medium", "low", "unavailable"]),
    reason: z.string().min(1).max(700).nullable(),
  })
  .strict();

const scheduleEdgeStrengthSchema = z
  .object({
    state: z.enum(["available", "partial", "unavailable"]),
    averagePercentile: z.number().min(0).max(100).nullable(),
    rank: z.number().int().min(1).max(32).nullable(),
    teamsRanked: z.number().int().min(0).max(32),
    favorableWeeks: z.number().int().nonnegative(),
    neutralWeeks: z.number().int().nonnegative(),
    difficultWeeks: z.number().int().nonnegative(),
    byeWeeks: z.number().int().nonnegative(),
    unknownWeeks: z.number().int().nonnegative(),
    confidence: z.enum(["high", "medium", "low", "unavailable"]),
    weeks: z.array(scheduleEdgeStrengthWeekSchema).max(18),
    reason: z.string().min(1).max(700).nullable(),
  })
  .strict();
export type ScheduleEdgeStrength = z.infer<typeof scheduleEdgeStrengthSchema>;

function hasScheduleEdgeDirectionalStrength(value: ScheduleEdgeStrength): boolean {
  return (
    value.favorableWeeks > 0 ||
    value.neutralWeeks > 0 ||
    value.difficultWeeks > 0 ||
    value.weeks.some((week) => week.label !== "unavailable")
  );
}

const scheduleEdgePlayerReferenceSchema = z
  .object({
    playerId: z.string().uuid(),
    name: z.string().min(1).max(200),
    position: z.string().min(1).max(20),
    nflTeam: z
      .string()
      .regex(/^[A-Z]{2,4}$/u)
      .nullable(),
  })
  .strict();

const scheduleEdgeByeFindingSchema = z
  .object({
    week: z.number().int().min(1).max(18),
    status: z.enum(["covered", "thin", "gap", "unknown"]),
    affectedPlayers: z.array(scheduleEdgePlayerReferenceSchema).max(40),
    fragilePlayerIds: z.array(z.string().uuid()).max(40),
    unfilledSlotLabels: z.array(z.string().min(1).max(80)).max(30),
    detail: z.string().min(1).max(700),
  })
  .strict();
export type ScheduleEdgeByeFinding = z.infer<typeof scheduleEdgeByeFindingSchema>;

const scheduleEdgeFindingSchema = z
  .object({
    id: z.string().min(1).max(160),
    kind: z.enum([
      "bye-gap",
      "bye-thin",
      "bye-unknown",
      "upcoming-bye",
      "favorable-window",
      "difficult-window",
    ]),
    severity: z.enum(["critical", "watch", "edge", "info"]),
    title: z.string().min(1).max(160),
    detail: z.string().min(1).max(700),
    week: z.number().int().min(1).max(18).nullable(),
    playerId: z.string().uuid().nullable(),
    href: z.string().startsWith("/").max(500).nullable(),
    factors: z.array(z.string().min(1).max(300)).max(12),
  })
  .strict();
export type ScheduleEdgeFinding = z.infer<typeof scheduleEdgeFindingSchema>;

const scheduleEdgeRosterPlayerSchema = z
  .object({
    playerId: z.string().uuid(),
    name: z.string().min(1).max(200),
    primaryPosition: z.string().min(1).max(20),
    eligiblePositions: z.array(z.string().min(1).max(20)).min(1).max(12),
    nflTeam: z
      .string()
      .regex(/^[A-Z]{2,4}$/u)
      .nullable(),
    status: z.string().min(1).max(80).nullable(),
    isLikelyStarter: z.boolean(),
    currentSlot: z.string().min(1).max(80).nullable(),
    next: z
      .object({
        week: z.number().int().min(1).max(18),
        state: z.enum(["game", "bye", "unknown"]),
        opponent: z
          .string()
          .regex(/^[A-Z]{2,4}$/u)
          .nullable(),
        kickoffAt: z.iso.datetime().nullable(),
        reason: z.string().min(1).max(700).nullable(),
      })
      .strict(),
    matchup: scheduleEdgeMatchupSchema,
    selectedWindow: scheduleEdgeStrengthSchema,
    playoffWindow: scheduleEdgeStrengthSchema,
    projection: z
      .object({
        weeklyPoints: z.number().finite().nullable(),
        rosPoints: z.number().finite().nullable(),
        source: z.string().min(1).max(160),
        sourceObservedAt: z.iso.datetime().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ScheduleEdgeRosterPlayer = z.infer<typeof scheduleEdgeRosterPlayerSchema>;

const scheduleEdgeDefinitionsSchema = z
  .object({
    matchup: z.string().min(1).max(1_500),
    scheduleStrength: z.string().min(1).max(1_500),
    confidence: z.string().min(1).max(1_500),
    byeFeasibility: z.string().min(1).max(1_500),
  })
  .strict();

export const scheduleEdgeResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    algorithm: scheduleEdgeAlgorithmSchema,
    league: z
      .object({
        id: z.string().uuid(),
        leagueSeasonId: z.string().uuid(),
        name: z.string().min(1).max(200),
        provider: z.enum(["espn", "yahoo", "manual"]),
        season: z.number().int().min(2000).max(2200),
        currentWeek: z.number().int().min(1).max(18).nullable(),
        claimedTeam: z
          .object({
            id: z.string().uuid(),
            name: z.string().min(1).max(200),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    windows: z
      .object({
        selected: scheduleEdgeWindowSchema,
        playoff: scheduleEdgeWindowSchema,
      })
      .strict(),
    availability: z
      .object({
        schedule: scheduleEdgeAvailabilitySchema,
        scoring: scheduleEdgeAvailabilitySchema,
        matchups: scheduleEdgeAvailabilitySchema,
        roster: scheduleEdgeAvailabilitySchema,
        projections: scheduleEdgeAvailabilitySchema,
        byeFeasibility: scheduleEdgeAvailabilitySchema,
      })
      .strict(),
    scoring: z
      .object({
        profileKeyHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        warnings: z.array(z.string().min(1).max(500)).max(40),
      })
      .strict(),
    findings: z.array(scheduleEdgeFindingSchema).max(3),
    roster: z.array(scheduleEdgeRosterPlayerSchema).max(80),
    byeWeeks: z.array(scheduleEdgeByeFindingSchema).max(18),
    sources: z.array(scheduleEdgeSourceSchema).max(12),
    definitions: scheduleEdgeDefinitionsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.algorithm.validationStatus === "validated") return;
    const directionalFinding = value.findings.find(
      (finding) => finding.kind === "favorable-window" || finding.kind === "difficult-window",
    );
    if (directionalFinding) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Directional findings require validated Schedule Edge evidence",
      });
    }
    const directionalPlayerIndex = value.roster.findIndex(
      (player) =>
        player.matchup.label !== "unavailable" ||
        hasScheduleEdgeDirectionalStrength(player.selectedWindow) ||
        hasScheduleEdgeDirectionalStrength(player.playoffWindow),
    );
    if (directionalPlayerIndex >= 0) {
      context.addIssue({
        code: "custom",
        path: ["roster", directionalPlayerIndex],
        message: "Directional matchup labels require validated Schedule Edge evidence",
      });
    }
  });
export type ScheduleEdgeResponse = z.infer<typeof scheduleEdgeResponseSchema>;

const scheduleEdgeMatrixPositionSchema = z
  .object({
    position: z.enum(["QB", "RB", "WR", "TE"]),
    selectedWindow: scheduleEdgeStrengthSchema,
    playoffWindow: scheduleEdgeStrengthSchema,
  })
  .strict();

export const scheduleEdgeMatrixResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    algorithm: scheduleEdgeAlgorithmSchema,
    league: z
      .object({
        id: z.string().uuid(),
        leagueSeasonId: z.string().uuid(),
        name: z.string().min(1).max(200),
        season: z.number().int().min(2000).max(2200),
      })
      .strict(),
    windows: z
      .object({
        selected: scheduleEdgeWindowSchema,
        playoff: scheduleEdgeWindowSchema,
      })
      .strict(),
    availability: z
      .object({
        schedule: scheduleEdgeAvailabilitySchema,
        scoring: scheduleEdgeAvailabilitySchema,
        matchups: scheduleEdgeAvailabilitySchema,
      })
      .strict(),
    scoring: z
      .object({
        profileKeyHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        warnings: z.array(z.string().min(1).max(500)).max(40),
      })
      .strict(),
    teams: z
      .array(
        z
          .object({
            team: z.string().regex(/^[A-Z]{2,4}$/u),
            positions: z.array(scheduleEdgeMatrixPositionSchema).max(4),
          })
          .strict(),
      )
      .max(32),
    sources: z.array(scheduleEdgeSourceSchema).max(12),
    definitions: scheduleEdgeDefinitionsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.algorithm.validationStatus === "validated") return;
    const teamIndex = value.teams.findIndex((team) =>
      team.positions.some(
        (position) =>
          hasScheduleEdgeDirectionalStrength(position.selectedWindow) ||
          hasScheduleEdgeDirectionalStrength(position.playoffWindow),
      ),
    );
    if (teamIndex >= 0) {
      context.addIssue({
        code: "custom",
        path: ["teams", teamIndex],
        message: "Directional schedule labels require validated Schedule Edge evidence",
      });
    }
  });
export type ScheduleEdgeMatrixResponse = z.infer<typeof scheduleEdgeMatrixResponseSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(12).max(128),
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "The new password must differ from the current one",
    path: ["newPassword"],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const changePasswordResponseSchema = z
  .object({
    changed: z.literal(true),
    /** Other devices are signed out; the caller's own session is deliberately preserved. */
    otherSessionsRevoked: z.literal(true),
  })
  .strict();
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

export const deleteAccountRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    /** Intentionally awkward to submit accidentally; both native and web show this exact phrase. */
    confirmation: z.literal("DELETE MY ACCOUNT"),
  })
  .strict();
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

export const deleteAccountResponseSchema = z
  .object({
    deleted: z.literal(true),
    transferredLeagueCount: z.number().int().nonnegative(),
    deletedSoleMemberLeagueCount: z.number().int().nonnegative(),
    preservedSharedProjectionSetCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;

/** Exact browser destinations a native session may hand off to; intentionally no arbitrary URL. */
export const browserHandoffDestinationSchema = z.enum([
  "/app",
  "/analytics",
  "/connections",
  "/connections/yahoo/connect",
  "/decisions",
  "/draft",
  "/film-room",
  "/rankings",
  "/projections",
  "/schedule",
  "/settings",
  "/stats",
  "/admin/members",
]);
export type BrowserHandoffDestination = z.infer<typeof browserHandoffDestinationSchema>;

export const createBrowserHandoffRequestSchema = z
  .object({ destination: browserHandoffDestinationSchema })
  .strict();
export type CreateBrowserHandoffRequest = z.infer<typeof createBrowserHandoffRequestSchema>;

export const createBrowserHandoffResponseSchema = z
  .object({ handoffUrl: z.url(), expiresAt: z.iso.datetime() })
  .strict();
export type CreateBrowserHandoffResponse = z.infer<typeof createBrowserHandoffResponseSchema>;

export const memberPreferencesSchema = z
  .object({ defaultLeagueId: z.string().uuid().nullable() })
  .strict();
export type MemberPreferencesContract = z.infer<typeof memberPreferencesSchema>;

/**
 * Public, non-secret feature identifiers a native client may use before signing in. Keep this a
 * closed vocabulary: it is a compatibility declaration, not an operator-controlled label bag.
 */
export const mobileCapabilitySchema = z.enum([
  "account-data-export",
  "account-deletion",
  "activity-feed",
  "authenticated-browser-handoff",
  "cookie-authentication",
  "espn-automated-refresh",
  "espn-native-session-grant-v1",
  "espn-server-session-v1",
  "espn-sync-agent-v1",
  "in-season-decisions",
  "league-analytics",
  "league-dashboard",
  "league-portfolio",
  "league-removal-v1",
  "weekly-reckoning",
  "yahoo-automated-sync",
  "yahoo-native-connect-v1",
]);
export type MobileCapability = z.infer<typeof mobileCapabilitySchema>;

export const healthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.literal("fantasy-api"),
    version: z.string(),
    time: z.iso.datetime(),
    /** Increment only when the minimum native HTTP contract changes incompatibly. */
    mobileApiVersion: z.number().int().positive(),
    mobileCapabilities: z.array(mobileCapabilitySchema).max(32),
  })
  .strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Web push ("game day alerts"). `available: false` is the ordinary state of a deployment whose
 * operator has not generated VAPID keys; the settings panel renders a labeled disabled section
 * rather than an error.
 */
export const pushConfigurationSchema = z
  .object({
    available: z.boolean(),
    publicKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}$/u)
      .nullable(),
  })
  .strict();
export type PushConfiguration = z.infer<typeof pushConfigurationSchema>;

const pushSubscriptionKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,256}$/u);

/**
 * Push endpoints are server-side destinations, so accepting an arbitrary HTTPS URL would turn a
 * registered member into an SSRF client. Browser subscriptions currently terminate at one of
 * these platform push services; exact or owned-suffix matching keeps the check narrow without
 * depending on a particular regional Windows or Mozilla host.
 */
export function isTrustedPushServiceEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    const hostname = endpoint.hostname.toLowerCase();
    const trustedHostname =
      hostname === "fcm.googleapis.com" ||
      hostname === "web.push.apple.com" ||
      hostname === "push.services.mozilla.com" ||
      hostname.endsWith(".push.services.mozilla.com") ||
      hostname.endsWith(".notify.windows.com");
    return (
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.port === "" &&
      endpoint.hash === "" &&
      trustedHostname
    );
  } catch {
    return false;
  }
}

/** Mirrors `PushSubscription.toJSON()` so the browser value can be posted without reshaping. */
export const pushSubscriptionRequestSchema = z
  .object({
    endpoint: z
      .url()
      .max(2048)
      .refine(isTrustedPushServiceEndpoint, "must be a recognized browser push service endpoint"),
    keys: z.object({ p256dh: pushSubscriptionKeySchema, auth: pushSubscriptionKeySchema }).strict(),
    /** A member-visible device name. Never the raw user-agent string. */
    label: z.string().trim().min(1).max(80).nullish(),
  })
  .strict();
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

/** Deliberately excludes the endpoint and both keys: a device list is not a credential list. */
export const pushDeviceStatusSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    label: z.string().min(1).max(80).nullable(),
    createdAt: z.iso.datetime(),
    lastSuccessAt: z.iso.datetime().nullable(),
    lastFailureAt: z.iso.datetime().nullable(),
  })
  .strict();
export type PushDeviceStatus = z.infer<typeof pushDeviceStatusSchema>;

export const pushDeviceListResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    devices: z.array(pushDeviceStatusSchema).max(20),
  })
  .strict();
export type PushDeviceListResponse = z.infer<typeof pushDeviceListResponseSchema>;

export const pushDeviceRevokeResponseSchema = z
  .object({ subscriptionId: z.string().uuid(), revokedAt: z.iso.datetime() })
  .strict();
export type PushDeviceRevokeResponse = z.infer<typeof pushDeviceRevokeResponseSchema>;

export const pushTestResponseSchema = z
  .object({
    attempted: z.number().int().min(0).max(20),
    delivered: z.number().int().min(0).max(20),
    /** Endpoints the push service reported as gone; those rows were deleted. */
    pruned: z.number().int().min(0).max(20),
  })
  .strict();
export type PushTestResponse = z.infer<typeof pushTestResponseSchema>;
