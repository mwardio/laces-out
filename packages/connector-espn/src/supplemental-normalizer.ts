import { createHash } from "node:crypto";

import {
  type LeagueSupplementalBundle,
  type NormalizedAvailabilityStatus,
  type NormalizedAvailablePlayer,
  type NormalizedCompletedDraftPick,
  type NormalizedFantasyPlayerWeekScore,
  type NormalizedFantasyTransaction,
  type NormalizedTransactionItem,
  type NormalizedTransactionStatus,
  type NormalizedTransactionType,
} from "@fantasy/connectors";
import { z, type ZodError } from "zod";

import {
  espnLineupSlotIsStarter,
  espnLineupSlotName,
  espnPrimaryPosition,
  espnProTeamAbbreviation,
} from "./web-client-normalizer.js";

export const ESPN_SUPPLEMENTAL_CONTRACT_VERSION = 1 as const;
export const MAX_ESPN_SUPPLEMENTAL_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const ESPN_READ_ORIGIN = "https://lm-api-reads.fantasy.espn.com";
const MAXIMUM_WEEK = 30;
const AVAILABILITY_RESULT_LIMIT = 250;

export type EspnSupplementalKind =
  | "available-free-agents"
  | "available-waivers"
  | "weekly-box-scores"
  | "structured-transactions"
  | "completed-draft";

export type EspnSupplementalNormalizationErrorCode =
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_ENVELOPE"
  | "INVALID_ENDPOINT"
  | "CHECKSUM_MISMATCH"
  | "SCHEMA_DRIFT";

export interface EspnSupplementalNormalizationIssue {
  readonly path: string;
  readonly message: string;
}

export class EspnSupplementalNormalizationError extends Error {
  readonly code: EspnSupplementalNormalizationErrorCode;
  readonly issues: readonly EspnSupplementalNormalizationIssue[];

  constructor(input: {
    readonly code: EspnSupplementalNormalizationErrorCode;
    readonly message: string;
    readonly issues?: readonly EspnSupplementalNormalizationIssue[];
  }) {
    super(input.message);
    this.name = "EspnSupplementalNormalizationError";
    this.code = input.code;
    this.issues = input.issues ?? [];
  }
}

const providerIdSchema = z
  .union([
    z.string().regex(/^\d{1,20}$/u, "must be a numeric ESPN ID"),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => String(value));

// ESPN represents NFL team defenses with negative player IDs (for example, one ID per franchise).
// Those are player identifiers, not malformed team or league IDs.
const providerPlayerIdSchema = z
  .union([
    z.string().regex(/^-?\d{1,20}$/u, "must be a signed numeric ESPN player ID"),
    z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => String(value));

// ESPN transaction IDs are UUID-like opaque strings, unlike numeric league, team, player, and
// draft-pick IDs. Treat them as bounded provider identifiers rather than coercing them to numbers.
const providerOpaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "must be a bounded opaque ESPN ID");

const weekSchema = z.number().int().min(0).max(MAXIMUM_WEEK);
const playedWeekSchema = weekSchema.min(1);
const epochMillisecondsSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
const finitePointsSchema = z.number().finite().min(-100_000).max(100_000);
const knownLineupSlotSchema = z
  .number()
  .int()
  .refine((value) => espnLineupSlotName(value) !== undefined, "uses an unsupported lineup slot");
const optionalLineupSlotSchema = z
  .number()
  .int()
  .min(-1)
  .refine(
    (value) => value === -1 || espnLineupSlotName(value) !== undefined,
    "uses an unsupported lineup slot",
  );
const knownProTeamSchema = z
  .number()
  .int()
  .refine(
    (value) => espnProTeamAbbreviation(value) !== undefined,
    "uses an unsupported ESPN pro-team ID",
  );

const commonEnvelopeShape = {
  schemaVersion: z.literal(ESPN_SUPPLEMENTAL_CONTRACT_VERSION),
  provider: z.literal("espn"),
  authority: z.literal("browser-local"),
  readOnly: z.literal(true),
  leagueId: z.string().regex(/^\d{1,20}$/u),
  season: z.number().int().min(2019).max(2100),
  capturedAt: z.iso.datetime(),
  endpoint: z.url(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  payload: z.unknown(),
} as const;

const espnSupplementalEnvelopeV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...commonEnvelopeShape,
      kind: z.literal("available-free-agents"),
      week: weekSchema,
    })
    .strict(),
  z
    .object({
      ...commonEnvelopeShape,
      kind: z.literal("available-waivers"),
      week: weekSchema,
    })
    .strict(),
  z
    .object({
      ...commonEnvelopeShape,
      kind: z.literal("weekly-box-scores"),
      week: playedWeekSchema,
      matchupPeriodId: playedWeekSchema,
    })
    .strict(),
  z
    .object({
      ...commonEnvelopeShape,
      kind: z.literal("structured-transactions"),
      week: weekSchema,
    })
    .strict(),
  z
    .object({
      ...commonEnvelopeShape,
      kind: z.literal("completed-draft"),
      week: z.null(),
    })
    .strict(),
]);

export type EspnSupplementalEnvelopeV1 = z.infer<typeof espnSupplementalEnvelopeV1Schema>;

const availabilityPlayerSchema = z
  .object({
    id: providerPlayerIdSchema,
    fullName: z.string().trim().min(1).max(160),
    eligibleSlots: z.array(knownLineupSlotSchema).min(1).max(26),
    proTeamId: knownProTeamSchema,
    injuryStatus: z.union([z.string().trim().min(1).max(64), z.null()]).optional(),
    ownership: z
      .object({
        percentOwned: z.number().finite().min(0).max(100).nullable().optional(),
        percentStarted: z.number().finite().min(0).max(100).nullable().optional(),
        percentChange: z.number().finite().min(-100).max(100).nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const availabilityEntrySchema = z
  .object({
    id: providerPlayerIdSchema,
    onTeamId: providerIdSchema,
    status: z.enum(["FREEAGENT", "WAIVERS"]),
    player: availabilityPlayerSchema,
  })
  .passthrough()
  .superRefine((entry, context) => {
    if (entry.id !== entry.player.id) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "player IDs must match at every ESPN nesting level",
      });
    }
    if (entry.onTeamId !== "0") {
      context.addIssue({
        code: "custom",
        path: ["onTeamId"],
        message: "an available player must not be assigned to a fantasy team",
      });
    }
    if (espnPrimaryPosition(entry.player.eligibleSlots) === undefined) {
      context.addIssue({
        code: "custom",
        path: ["player", "eligibleSlots"],
        message: "eligibleSlots must include a supported primary position",
      });
    }
  });

const availabilityPayloadSchema = z
  .object({
    players: z.array(availabilityEntrySchema).max(500),
  })
  .passthrough();

const appliedStatsSchema = z
  .record(z.string().regex(/^\d{1,4}$/u), z.number().finite().min(-100_000).max(100_000))
  .default({});

const playerWeekStatSchema = z
  .object({
    seasonId: z.number().int().min(2000).max(2100),
    scoringPeriodId: weekSchema,
    statSourceId: z.union([z.literal(0), z.literal(1)]),
    statSplitTypeId: z.number().int().min(0).max(16),
    appliedTotal: finitePointsSchema,
    appliedStats: appliedStatsSchema,
  })
  .passthrough();

const boxScorePlayerSchema = z
  .object({
    id: providerPlayerIdSchema,
    fullName: z.string().trim().min(1).max(160),
    eligibleSlots: z.array(knownLineupSlotSchema).min(1).max(26),
    proTeamId: knownProTeamSchema,
    injuryStatus: z.union([z.string().trim().min(1).max(64), z.null()]).optional(),
    stats: z.array(playerWeekStatSchema).max(256),
  })
  .passthrough();

const boxScoreRosterEntrySchema = z
  .object({
    lineupSlotId: knownLineupSlotSchema,
    playerId: providerPlayerIdSchema,
    playerPoolEntry: z
      .object({
        id: providerPlayerIdSchema,
        onTeamId: providerIdSchema,
        // Historical box scores contain the roster at that time, while ESPN reports the player's
        // current pool state. A player traded or dropped later can therefore be ONTEAM elsewhere
        // or FREEAGENT here without invalidating the historical roster row.
        status: z.enum(["ONTEAM", "FREEAGENT", "WAIVERS"]),
        player: boxScorePlayerSchema,
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((entry, context) => {
    if (
      entry.playerId !== entry.playerPoolEntry.id ||
      entry.playerId !== entry.playerPoolEntry.player.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["playerId"],
        message: "player IDs must match at every ESPN nesting level",
      });
    }
  });

const boxScoreSideSchema = z
  .object({
    teamId: providerIdSchema,
    totalPoints: finitePointsSchema,
    rosterForCurrentScoringPeriod: z
      .object({
        entries: z.array(boxScoreRosterEntrySchema).max(128),
      })
      .passthrough(),
  })
  .passthrough();

const boxScoreMatchupSchema = z
  .object({
    id: providerIdSchema,
    matchupPeriodId: playedWeekSchema,
    home: boxScoreSideSchema,
    away: boxScoreSideSchema,
  })
  .passthrough();

const boxScorePayloadSchema = z
  .object({
    id: providerIdSchema,
    seasonId: z.number().int().min(2000).max(2100),
    scoringPeriodId: playedWeekSchema,
    schedule: z.array(boxScoreMatchupSchema).max(64),
  })
  .passthrough();

const transactionItemSchema = z
  .object({
    type: z.enum(["ADD", "DROP", "LINEUP", "TRADE", "DRAFT"]),
    playerId: providerPlayerIdSchema,
    fromTeamId: providerIdSchema,
    toTeamId: providerIdSchema,
    fromLineupSlotId: optionalLineupSlotSchema,
    toLineupSlotId: optionalLineupSlotSchema,
  })
  .passthrough();

const transactionSchema = z
  .object({
    id: providerOpaqueIdSchema,
    scoringPeriodId: weekSchema,
    type: z.enum([
      "DRAFT",
      "TRADE_ACCEPT",
      "WAIVER",
      "TRADE_VETO",
      "FUTURE_ROSTER",
      "ROSTER",
      "RETRO_ROSTER",
      "TRADE_PROPOSAL",
      "TRADE_UPHOLD",
      "FREEAGENT",
      "TRADE_DECLINE",
      "WAIVER_ERROR",
      "TRADE_ERROR",
    ]),
    status: z
      .enum([
        "EXECUTED",
        "PENDING",
        "CANCELED",
        "FAILED_INVALIDPLAYERSOURCE",
        "FAILED_PLAYERALREADYDROPPED",
        "FAILED_ROSTERLIMIT",
      ])
      .nullable()
      .optional(),
    executionType: z.enum(["EXECUTE", "PROCESS", "CANCEL"]),
    teamId: providerIdSchema,
    bidAmount: z.number().finite().min(0).max(100_000),
    proposedDate: epochMillisecondsSchema,
    processDate: epochMillisecondsSchema.nullable().optional(),
    items: z.array(transactionItemSchema).max(32).optional().default([]),
  })
  .passthrough();

const transactionPayloadSchema = z
  .object({
    id: providerIdSchema,
    seasonId: z.number().int().min(2000).max(2100),
    scoringPeriodId: weekSchema,
    transactions: z.array(transactionSchema).max(5_000).optional(),
  })
  .passthrough();

const draftPickSchema = z
  .object({
    id: providerIdSchema,
    bidAmount: z.number().finite().min(0).max(100_000),
    keeper: z.boolean(),
    nominatingTeamId: providerIdSchema,
    overallPickNumber: z.number().int().min(1).max(10_000),
    playerId: providerPlayerIdSchema,
    roundId: z.number().int().min(1).max(1_000),
    roundPickNumber: z.number().int().min(1).max(1_000),
    teamId: providerIdSchema,
  })
  .passthrough();

const completedDraftPayloadSchema = z
  .object({
    id: providerIdSchema,
    seasonId: z.number().int().min(2000).max(2100),
    settings: z
      .object({
        draftSettings: z
          .object({
            type: z.enum(["SNAKE", "AUCTION"]),
            auctionBudget: z.number().int().min(0).max(100_000),
          })
          .passthrough(),
      })
      .passthrough(),
    draftDetail: z
      .object({
        completeDate: epochMillisecondsSchema.nullable(),
        drafted: z.boolean(),
        inProgress: z.boolean(),
        picks: z.array(draftPickSchema).max(5_000),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const { draftSettings } = value.settings;
    if (draftSettings.type === "AUCTION" && draftSettings.auctionBudget < 1) {
      context.addIssue({
        code: "custom",
        path: ["settings", "draftSettings", "auctionBudget"],
        message: "auction drafts must declare a positive budget",
      });
    }
    const sequences = new Set<number>();
    for (const [index, pick] of value.draftDetail.picks.entries()) {
      if (sequences.has(pick.overallPickNumber)) {
        context.addIssue({
          code: "custom",
          path: ["draftDetail", "picks", index, "overallPickNumber"],
          message: "overall pick numbers must be unique",
        });
      }
      sequences.add(pick.overallPickNumber);
      if (pick.teamId === "0") {
        context.addIssue({
          code: "custom",
          path: ["draftDetail", "picks", index, "teamId"],
          message: "draft picks must reference a fantasy team",
        });
      }
    }
  });

function sanitizedIssues(
  error: ZodError,
  fallbackMessage: string,
): readonly EspnSupplementalNormalizationIssue[] {
  return error.issues.slice(0, 32).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: typeof issue.message === "string" ? issue.message : fallbackMessage,
  }));
}

function canonicalPayloadChecksum(payload: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN supplemental payload is not JSON serializable",
    });
  }
  if (serialized === undefined) {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN supplemental payload is empty",
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ESPN_SUPPLEMENTAL_SNAPSHOT_BYTES) {
    throw new EspnSupplementalNormalizationError({
      code: "PAYLOAD_TOO_LARGE",
      message: "ESPN supplemental payload exceeds the bounded snapshot limit",
    });
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function expectedViews(kind: EspnSupplementalKind): readonly string[] {
  if (kind === "available-free-agents" || kind === "available-waivers") {
    return ["kona_player_info"];
  }
  if (kind === "weekly-box-scores") return ["mMatchupScore", "mScoreboard"];
  if (kind === "structured-transactions") return ["mTransactions2"];
  return ["mDraftDetail"];
}

function validateEndpoint(envelope: EspnSupplementalEnvelopeV1): void {
  let endpoint: URL;
  try {
    endpoint = new URL(envelope.endpoint);
  } catch {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENDPOINT",
      message: "ESPN supplemental endpoint is invalid",
    });
  }
  if (
    endpoint.origin !== ESPN_READ_ORIGIN ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== ""
  ) {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENDPOINT",
      message: "ESPN supplemental endpoint must use the allowlisted read host",
    });
  }

  const currentPath = `/apis/v3/games/ffl/seasons/${envelope.season}/segments/0/leagues/${envelope.leagueId}`;
  const historyPath = `/apis/v3/games/ffl/leagueHistory/${envelope.leagueId}`;
  const history = endpoint.pathname === historyPath;
  if (endpoint.pathname !== currentPath && !history) {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENDPOINT",
      message: "ESPN supplemental endpoint does not match the scoped league season",
    });
  }

  const allowedParameters = new Set(["view"]);
  if (envelope.kind !== "completed-draft") allowedParameters.add("scoringPeriodId");
  if (history) allowedParameters.add("seasonId");
  for (const key of endpoint.searchParams.keys()) {
    if (!allowedParameters.has(key)) {
      throw new EspnSupplementalNormalizationError({
        code: "INVALID_ENDPOINT",
        message: "ESPN supplemental endpoint contains an unsupported query parameter",
      });
    }
  }
  const actualViews = endpoint.searchParams.getAll("view").sort();
  const wantedViews = [...expectedViews(envelope.kind)].sort();
  if (
    actualViews.length !== wantedViews.length ||
    actualViews.some((view, index) => view !== wantedViews[index])
  ) {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENDPOINT",
      message: "ESPN supplemental endpoint views do not match the artifact kind",
    });
  }
  if (history && endpoint.searchParams.get("seasonId") !== String(envelope.season)) {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENDPOINT",
      message: "ESPN history endpoint season does not match the artifact",
    });
  }
  const scoringPeriod = endpoint.searchParams.get("scoringPeriodId");
  if (
    envelope.kind === "completed-draft"
      ? scoringPeriod !== null
      : scoringPeriod !== String(envelope.week)
  ) {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENDPOINT",
      message: "ESPN supplemental scoring period does not match the artifact",
    });
  }
}

function parsedPayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const root: unknown =
    Array.isArray(payload) && payload.length === 1 ? (payload as readonly unknown[])[0] : payload;
  const parsed = schema.safeParse(root);
  if (!parsed.success) {
    throw new EspnSupplementalNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN supplemental response did not match contract v1",
      issues: sanitizedIssues(parsed.error, "supplemental response field is invalid"),
    });
  }
  return parsed.data;
}

function leagueExternalId(envelope: EspnSupplementalEnvelopeV1): string {
  return `espn:${envelope.season}:${envelope.leagueId}`;
}

function teamExternalId(envelope: EspnSupplementalEnvelopeV1, teamId: string): string {
  return `${leagueExternalId(envelope)}:team:${teamId}`;
}

function playerExternalId(envelope: EspnSupplementalEnvelopeV1, playerId: string): string {
  return `espn:${envelope.season}:player:${playerId}`;
}

function commonContext(envelope: EspnSupplementalEnvelopeV1) {
  return {
    provider: "espn" as const,
    leagueExternalId: leagueExternalId(envelope),
    providerLeagueId: envelope.leagueId,
    season: envelope.season,
    provenance: {
      mode: "browser-local" as const,
      fetchedAt: envelope.capturedAt,
      endpoint: envelope.endpoint,
      artifactChecksumSha256: envelope.checksumSha256,
    },
  };
}

function normalizeAvailability(
  envelope: Extract<
    EspnSupplementalEnvelopeV1,
    { readonly kind: "available-free-agents" | "available-waivers" }
  >,
): LeagueSupplementalBundle {
  const payload = parsedPayload(availabilityPayloadSchema, envelope.payload);
  const providerStatus = envelope.kind === "available-free-agents" ? "FREEAGENT" : "WAIVERS";
  const availability: NormalizedAvailabilityStatus =
    providerStatus === "FREEAGENT" ? "free-agent" : "waivers";
  const seen = new Set<string>();
  const players: NormalizedAvailablePlayer[] = [];
  for (const entry of payload.players) {
    if (entry.status !== providerStatus) {
      throw new EspnSupplementalNormalizationError({
        code: "SCHEMA_DRIFT",
        message: "ESPN available-player status did not match the requested pool",
      });
    }
    if (seen.has(entry.id)) {
      throw new EspnSupplementalNormalizationError({
        code: "SCHEMA_DRIFT",
        message: "ESPN available-player response contained duplicate player IDs",
      });
    }
    seen.add(entry.id);
    const primaryPosition = espnPrimaryPosition(entry.player.eligibleSlots);
    if (primaryPosition === undefined) {
      throw new EspnSupplementalNormalizationError({
        code: "SCHEMA_DRIFT",
        message: "ESPN available player had no supported primary position",
      });
    }
    players.push({
      externalId: playerExternalId(envelope, entry.id),
      providerPlayerId: entry.id,
      fullName: entry.player.fullName,
      primaryPosition,
      eligiblePositions: [
        ...new Set(
          entry.player.eligibleSlots.flatMap((slotId) => {
            const position = espnLineupSlotName(slotId);
            return position === undefined ? [] : [position];
          }),
        ),
      ],
      proTeamAbbreviation: espnProTeamAbbreviation(entry.player.proTeamId) ?? null,
      injuryStatus: entry.player.injuryStatus ?? null,
      availability,
      percentOwned: entry.player.ownership?.percentOwned ?? null,
      percentStarted: entry.player.ownership?.percentStarted ?? null,
      ownershipTrend: entry.player.ownership?.percentChange ?? null,
    });
  }
  return {
    ...commonContext(envelope),
    kind: "available-players",
    asOfWeek: envelope.week,
    availability,
    truncated: players.length >= AVAILABILITY_RESULT_LIMIT,
    players,
    warnings:
      players.length >= AVAILABILITY_RESULT_LIMIT ? ["AVAILABLE_PLAYER_POOL_TRUNCATED"] : [],
  };
}

function matchingWeekStat(
  stats: readonly z.infer<typeof playerWeekStatSchema>[],
  envelope: Extract<EspnSupplementalEnvelopeV1, { readonly kind: "weekly-box-scores" }>,
  source: 0 | 1,
): z.infer<typeof playerWeekStatSchema> | undefined {
  const matches = stats.filter(
    (stat) =>
      stat.seasonId === envelope.season &&
      stat.scoringPeriodId === envelope.week &&
      stat.statSplitTypeId === 1 &&
      stat.statSourceId === source,
  );
  if (matches.length > 1) {
    throw new EspnSupplementalNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN player contained duplicate weekly scoring rows",
    });
  }
  return matches[0];
}

function normalizeBoxScores(
  envelope: Extract<EspnSupplementalEnvelopeV1, { readonly kind: "weekly-box-scores" }>,
): LeagueSupplementalBundle {
  const payload = parsedPayload(boxScorePayloadSchema, envelope.payload);
  if (
    payload.id !== envelope.leagueId ||
    payload.seasonId !== envelope.season ||
    payload.scoringPeriodId !== envelope.week
  ) {
    throw new EspnSupplementalNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN box-score response did not match the scoped league week",
    });
  }

  const seenMatchups = new Set<string>();
  const seenPlayers = new Set<string>();
  const playerScores: NormalizedFantasyPlayerWeekScore[] = [];
  let missingActuals = 0;
  let missingProjections = 0;
  for (const matchup of payload.schedule) {
    if (seenMatchups.has(matchup.id)) {
      throw new EspnSupplementalNormalizationError({
        code: "SCHEMA_DRIFT",
        message: "ESPN box-score response contained duplicate matchup IDs",
      });
    }
    seenMatchups.add(matchup.id);
    for (const side of [matchup.home, matchup.away]) {
      if (side.teamId === "0") continue;
      for (const entry of side.rosterForCurrentScoringPeriod.entries) {
        const identity = `${side.teamId}:${entry.playerId}`;
        if (seenPlayers.has(identity)) {
          throw new EspnSupplementalNormalizationError({
            code: "SCHEMA_DRIFT",
            message: "ESPN box-score response contained duplicate team player rows",
          });
        }
        seenPlayers.add(identity);
        const actual = matchingWeekStat(entry.playerPoolEntry.player.stats, envelope, 0);
        const projected = matchingWeekStat(entry.playerPoolEntry.player.stats, envelope, 1);
        if (!actual) missingActuals += 1;
        if (!projected) missingProjections += 1;
        const lineupSlot = espnLineupSlotName(entry.lineupSlotId);
        if (lineupSlot === undefined) {
          throw new EspnSupplementalNormalizationError({
            code: "SCHEMA_DRIFT",
            message: "ESPN box-score player used an unsupported lineup slot",
          });
        }
        playerScores.push({
          teamExternalId: teamExternalId(envelope, side.teamId),
          providerTeamId: side.teamId,
          playerExternalId: playerExternalId(envelope, entry.playerId),
          providerPlayerId: entry.playerId,
          lineupSlot,
          starter: espnLineupSlotIsStarter(entry.lineupSlotId),
          actualPoints: actual?.appliedTotal ?? null,
          projectedPoints: projected?.appliedTotal ?? null,
          appliedStats: actual?.appliedStats ?? {},
        });
      }
    }
  }
  return {
    ...commonContext(envelope),
    kind: "weekly-box-scores",
    week: envelope.week,
    matchups: payload.schedule.flatMap((matchup) => {
      if (matchup.home.teamId === "0" || matchup.away.teamId === "0") return [];
      return [
        {
          externalId: `${leagueExternalId(envelope)}:matchup:${matchup.id}`,
          providerMatchupId: matchup.id,
          home: {
            teamExternalId: teamExternalId(envelope, matchup.home.teamId),
            providerTeamId: matchup.home.teamId,
            totalPoints: matchup.home.totalPoints,
          },
          away: {
            teamExternalId: teamExternalId(envelope, matchup.away.teamId),
            providerTeamId: matchup.away.teamId,
            totalPoints: matchup.away.totalPoints,
          },
        },
      ];
    }),
    playerScores,
    warnings: [
      ...(missingActuals > 0 ? [`ACTUAL_STAT_ROWS_MISSING:${missingActuals}`] : []),
      ...(missingProjections > 0 ? [`PROJECTED_STAT_ROWS_MISSING:${missingProjections}`] : []),
    ],
  };
}

function normalizedTransactionType(providerType: string): NormalizedTransactionType {
  if (providerType === "FREEAGENT") return "free-agent";
  if (providerType === "WAIVER" || providerType === "WAIVER_ERROR") return "waiver";
  if (providerType === "DRAFT") return "draft";
  if (
    providerType === "ROSTER" ||
    providerType === "FUTURE_ROSTER" ||
    providerType === "RETRO_ROSTER"
  ) {
    return "lineup";
  }
  return "trade";
}

function normalizedTransactionStatus(providerStatus: string | null): NormalizedTransactionStatus {
  if (providerStatus === "EXECUTED") return "executed";
  if (providerStatus === "PENDING") return "pending";
  if (providerStatus === "CANCELED") return "cancelled";
  if (providerStatus?.startsWith("FAILED_")) return "failed";
  return "unknown";
}

function normalizedDate(value: number | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function optionalTeamId(
  envelope: EspnSupplementalEnvelopeV1,
  providerTeamId: string,
): { readonly externalId: string | null; readonly providerId: string | null } {
  return providerTeamId === "0"
    ? { externalId: null, providerId: null }
    : {
        externalId: teamExternalId(envelope, providerTeamId),
        providerId: providerTeamId,
      };
}

function normalizeTransactions(
  envelope: Extract<EspnSupplementalEnvelopeV1, { readonly kind: "structured-transactions" }>,
): LeagueSupplementalBundle {
  const payload = parsedPayload(transactionPayloadSchema, envelope.payload);
  if (
    payload.id !== envelope.leagueId ||
    payload.seasonId !== envelope.season ||
    payload.scoringPeriodId !== envelope.week
  ) {
    throw new EspnSupplementalNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN transaction response did not match the scoped league week",
    });
  }
  const seen = new Set<string>();
  const transactions: NormalizedFantasyTransaction[] = (payload.transactions ?? []).map(
    (transaction) => {
      if (seen.has(transaction.id)) {
        throw new EspnSupplementalNormalizationError({
          code: "SCHEMA_DRIFT",
          message: "ESPN transaction response contained duplicate transaction IDs",
        });
      }
      seen.add(transaction.id);
      const team = optionalTeamId(envelope, transaction.teamId);
      const items: NormalizedTransactionItem[] = transaction.items.map((item, index) => {
        const fromTeam = optionalTeamId(envelope, item.fromTeamId);
        const toTeam = optionalTeamId(envelope, item.toTeamId);
        return {
          sequence: index,
          type: item.type.toLowerCase() as NormalizedTransactionItem["type"],
          playerExternalId: playerExternalId(envelope, item.playerId),
          providerPlayerId: item.playerId,
          fromTeamExternalId: fromTeam.externalId,
          fromProviderTeamId: fromTeam.providerId,
          toTeamExternalId: toTeam.externalId,
          toProviderTeamId: toTeam.providerId,
          fromLineupSlot:
            item.fromLineupSlotId === -1
              ? null
              : (espnLineupSlotName(item.fromLineupSlotId) ?? null),
          toLineupSlot:
            item.toLineupSlotId === -1 ? null : (espnLineupSlotName(item.toLineupSlotId) ?? null),
        };
      });
      return {
        externalId: `${leagueExternalId(envelope)}:transaction:${transaction.id}`,
        providerTransactionId: transaction.id,
        scoringPeriodId: transaction.scoringPeriodId,
        type: normalizedTransactionType(transaction.type),
        providerType: transaction.type,
        status: normalizedTransactionStatus(transaction.status ?? null),
        providerStatus: transaction.status ?? null,
        executionType: transaction.executionType,
        teamExternalId: team.externalId,
        providerTeamId: team.providerId,
        bidAmount: ["WAIVER", "WAIVER_ERROR"].includes(transaction.type)
          ? transaction.bidAmount
          : null,
        proposedAt: normalizedDate(transaction.proposedDate),
        processedAt: normalizedDate(transaction.processDate),
        items,
      };
    },
  );
  return {
    ...commonContext(envelope),
    kind: "transactions",
    week: envelope.week,
    transactions,
    warnings: [],
  };
}

function normalizeCompletedDraft(
  envelope: Extract<EspnSupplementalEnvelopeV1, { readonly kind: "completed-draft" }>,
): LeagueSupplementalBundle {
  const payload = parsedPayload(completedDraftPayloadSchema, envelope.payload);
  if (payload.id !== envelope.leagueId || payload.seasonId !== envelope.season) {
    throw new EspnSupplementalNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN draft response did not match the scoped league season",
    });
  }
  const draftType = payload.settings.draftSettings.type === "AUCTION" ? "auction" : "snake";
  const picks: NormalizedCompletedDraftPick[] = [...payload.draftDetail.picks]
    .sort((left, right) => left.overallPickNumber - right.overallPickNumber)
    .map((pick) => {
      const nomination = optionalTeamId(envelope, pick.nominatingTeamId);
      return {
        externalId: `${leagueExternalId(envelope)}:draft-pick:${pick.id}`,
        providerPickId: pick.id,
        sequence: pick.overallPickNumber,
        round: pick.roundId,
        roundPick: pick.roundPickNumber,
        teamExternalId: teamExternalId(envelope, pick.teamId),
        providerTeamId: pick.teamId,
        playerExternalId: playerExternalId(envelope, pick.playerId),
        providerPlayerId: pick.playerId,
        nominatingTeamExternalId: nomination.externalId,
        nominatingProviderTeamId: nomination.providerId,
        amount: draftType === "auction" ? pick.bidAmount : null,
        keeper: pick.keeper,
      };
    });
  return {
    ...commonContext(envelope),
    kind: "completed-draft",
    draftType,
    budgetPerTeam: draftType === "auction" ? payload.settings.draftSettings.auctionBudget : null,
    state:
      payload.draftDetail.drafted && !payload.draftDetail.inProgress ? "complete" : "in-progress",
    completedAt: normalizedDate(payload.draftDetail.completeDate),
    picks,
    warnings: [],
  };
}

export function normalizeEspnSupplementalSnapshot(input: unknown): LeagueSupplementalBundle {
  let inputSize: number;
  try {
    inputSize = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
  } catch {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN supplemental snapshot is not JSON serializable",
    });
  }
  if (inputSize > MAX_ESPN_SUPPLEMENTAL_SNAPSHOT_BYTES) {
    throw new EspnSupplementalNormalizationError({
      code: "PAYLOAD_TOO_LARGE",
      message: "ESPN supplemental snapshot exceeds the bounded artifact limit",
    });
  }

  const envelopeResult = espnSupplementalEnvelopeV1Schema.safeParse(input);
  if (!envelopeResult.success) {
    throw new EspnSupplementalNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN supplemental snapshot did not match envelope contract v1",
      issues: sanitizedIssues(envelopeResult.error, "supplemental envelope field is invalid"),
    });
  }
  const envelope = envelopeResult.data;
  validateEndpoint(envelope);
  if (canonicalPayloadChecksum(envelope.payload) !== envelope.checksumSha256) {
    throw new EspnSupplementalNormalizationError({
      code: "CHECKSUM_MISMATCH",
      message: "ESPN supplemental snapshot checksum does not match its payload",
    });
  }

  if (envelope.kind === "available-free-agents" || envelope.kind === "available-waivers") {
    return normalizeAvailability(envelope);
  }
  if (envelope.kind === "weekly-box-scores") return normalizeBoxScores(envelope);
  if (envelope.kind === "structured-transactions") return normalizeTransactions(envelope);
  return normalizeCompletedDraft(envelope);
}
