import { createHash } from "node:crypto";

import {
  NORMALIZED_SYNC_SCHEMA_VERSION,
  type DraftType,
  type LeagueSyncBundle,
  type NormalizedMatchupSnapshot,
  type NormalizedRosterPlayer,
  type NormalizedScoringRule,
  type NormalizedStandingsSnapshot,
  type NormalizedTeam,
  type WaiverType,
} from "@laces-out/connectors";
import { z } from "zod";

/**
 * Parser contract for the observed ESPN fantasy-football web client response.
 * This is our version, not an ESPN API or schema version.
 *
 * v2 (2026-07-28): ESPN re-encoded two `acquisitionSettings` fields. `waiverProcessDays` now
 * carries uppercase day names, and `matchupLimitPerScoringPeriod` is a boolean flag rather than
 * the count v1 read it as. Both encodings of both fields parse, but the boolean is never read as
 * a count, so the meaning of a normalized `matchupAcquisitionLimit` changed for consumers.
 */
export const ESPN_WEB_CLIENT_CONTRACT_VERSION = 2 as const;
export const MAX_ESPN_WEB_CLIENT_SNAPSHOT_BYTES = 5 * 1024 * 1024;

const ESPN_READ_ORIGIN = "https://lm-api-reads.fantasy.espn.com";
const REQUIRED_VIEWS = ["mSettings", "mTeam", "mRoster"] as const;
const ALLOWED_VIEWS = new Set([...REQUIRED_VIEWS, "mStandings", "mMatchup"]);
const ENVELOPE_DISCRIMINATORS = new Set([
  "schemaVersion",
  "provider",
  "authority",
  "readOnly",
  "leagueId",
  "season",
  "capturedAt",
  "endpoint",
  "checksumSha256",
  "payload",
]);

const LINEUP_SLOT_NAMES = {
  0: "QB",
  1: "TQB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  8: "DT",
  9: "DE",
  10: "LB",
  11: "DL",
  12: "CB",
  13: "S",
  14: "DB",
  15: "DP",
  16: "D/ST",
  17: "K",
  18: "P",
  19: "HC",
  20: "BN",
  21: "IR",
  22: "INVALID",
  23: "FLEX",
  24: "ER",
  25: "ROOKIE",
} as const;

const PRIMARY_POSITION_SLOT_IDS = new Set([
  0, 1, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
]);
const RESERVE_SLOT_IDS = new Set([20, 21, 24, 25]);

const PRO_TEAM_ABBREVIATIONS = {
  0: null,
  1: "ATL",
  2: "BUF",
  3: "CHI",
  4: "CIN",
  5: "CLE",
  6: "DAL",
  7: "DEN",
  8: "DET",
  9: "GB",
  10: "TEN",
  11: "IND",
  12: "KC",
  13: "LV",
  14: "LAR",
  15: "MIA",
  16: "MIN",
  17: "NE",
  18: "NO",
  19: "NYG",
  20: "NYJ",
  21: "PHI",
  22: "ARI",
  23: "PIT",
  24: "LAC",
  25: "SF",
  26: "SEA",
  27: "TB",
  28: "WSH",
  29: "CAR",
  30: "JAX",
  33: "BAL",
  34: "HOU",
} as const;

const providerIdSchema = z
  .union([
    z.string().regex(/^\d{1,20}$/u, "must be a numeric ESPN ID"),
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => String(value));
const providerPlayerIdSchema = z
  .union([
    z.string().regex(/^-?\d{1,20}$/u, "must be a signed numeric ESPN player ID"),
    z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => String(value));
const memberIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace");
const nonEmptyTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableTextSchema = (maximum: number) =>
  z.union([z.string().trim().max(maximum), z.null()]).optional();
const webUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol),
    "must use HTTP or HTTPS",
  );
const espnBooleanSchema = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => value === true || value === 1);
const knownLineupSlotIdSchema = z
  .number()
  .int()
  .refine(
    (value) => Object.hasOwn(LINEUP_SLOT_NAMES, value),
    "uses an unsupported ESPN lineup slot ID",
  );
const usableLineupSlotIdSchema = knownLineupSlotIdSchema.refine(
  (value) => value !== 22,
  "uses ESPN's invalid lineup slot code",
);
const proTeamIdSchema = z
  .number()
  .int()
  .refine(
    (value) => Object.hasOwn(PRO_TEAM_ABBREVIATIONS, value),
    "uses an unsupported ESPN pro-team ID",
  );

const lineupSlotCountsSchema = z
  .record(z.string().regex(/^\d{1,3}$/u), z.number().int().min(0).max(64))
  .superRefine((value, context) => {
    const entries = Object.entries(value);
    if (entries.length > Object.keys(LINEUP_SLOT_NAMES).length) {
      context.addIssue({
        code: "custom",
        message: "lineupSlotCounts contains too many slot IDs",
      });
    }
    if (!entries.some(([, count]) => count > 0)) {
      context.addIssue({
        code: "custom",
        message: "lineupSlotCounts must contain at least one roster position",
      });
    }
    for (const [slotIdText, count] of entries) {
      const slotId = Number(slotIdText);
      if (!Object.hasOwn(LINEUP_SLOT_NAMES, slotId)) {
        context.addIssue({
          code: "custom",
          path: [slotIdText],
          message: "lineupSlotCounts uses an unsupported ESPN slot ID",
        });
      }
      if (slotId === 22 && count !== 0) {
        context.addIssue({
          code: "custom",
          path: [slotIdText],
          message: "ESPN's invalid lineup slot must have a zero count",
        });
      }
    }
  });

const scoringItemSchema = z
  .object({
    statId: z.number().int().min(0).max(9999),
    points: z.number().finite().min(-1000).max(1000),
    pointsOverrides: z
      .record(z.string().regex(/^\d{1,3}$/u), z.number().finite().min(-1000).max(1000))
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    for (const slotIdText of Object.keys(value.pointsOverrides ?? {})) {
      const slotId = Number(slotIdText);
      if (!Object.hasOwn(LINEUP_SLOT_NAMES, slotId) || slotId === 22) {
        context.addIssue({
          code: "custom",
          path: ["pointsOverrides", slotIdText],
          message: "pointsOverrides uses an unsupported ESPN slot ID",
        });
      }
    }
  });

/**
 * ESPN's observed `waiverProcessDays` day names, indexed so that the array position *is* the
 * normalized number. The project pins `Date.prototype.getDay()` numbering (0 = Sunday) for
 * `operationalRules.waiverProcessDays`: nothing downstream consumed the field when the encoding
 * changed and no other connector populates it, so the platform convention every future JS consumer
 * will compare against was chosen deliberately. See docs/unofficial-web-client-v2.md.
 */
const WAIVER_PROCESS_DAY_NAMES = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

/**
 * Accepts either encoding but not a mixture of the two, because the numeric encoding's own
 * convention was never established by ESPN and must not be silently interleaved with day names
 * that this contract does map. Unknown names fail closed rather than dropping a waiver day.
 */
const waiverProcessDaysSchema = z
  .array(z.union([z.number().int().min(0).max(7), z.string().min(1).max(32)]))
  .max(8)
  .superRefine((value, context) => {
    let names = 0;
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") continue;
      names += 1;
      if (!(WAIVER_PROCESS_DAY_NAMES as readonly string[]).includes(entry)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "waiverProcessDays uses an unrecognized ESPN day name",
        });
      }
    }
    if (names > 0 && names !== value.length) {
      context.addIssue({
        code: "custom",
        message: "waiverProcessDays mixes ESPN day names with the legacy numeric encoding",
      });
    }
  });

const settingsSchema = z
  .object({
    name: nonEmptyTextSchema(160),
    size: z.number().int().min(1).max(64),
    acquisitionSettings: z
      .object({
        acquisitionBudget: z.number().int().min(0).max(100_000),
        acquisitionType: z.enum(["WAIVERS_TRADITIONAL", "WAIVERS_CONTINUOUS", "FREE_AGENTS_ONLY"]),
        isUsingAcquisitionBudget: z.boolean(),
        waiverOrderReset: z.boolean(),
        acquisitionLimit: z.number().int().min(-1).max(10_000).optional(),
        matchupAcquisitionLimit: z.number().int().min(-1).max(10_000).optional(),
        /**
         * Observed as a boolean flag on 2026-07-28 ("is there a per-scoring-period limit") and as
         * a count before that. The boolean is never read as a count; see
         * {@link matchupAcquisitionLimits}.
         */
        matchupLimitPerScoringPeriod: z
          .union([z.boolean(), z.number().int().min(-1).max(10_000)])
          .optional(),
        minimumBid: z.number().int().min(0).max(100_000).optional(),
        waiverProcessDays: waiverProcessDaysSchema.optional(),
        waiverProcessHour: z.number().int().min(0).max(23).optional(),
      })
      .passthrough(),
    draftSettings: z
      .object({
        auctionBudget: z.number().int().min(0).max(100_000),
        type: z.enum(["SNAKE", "AUTOPICK", "SNAIL", "AUCTION"]),
        keeperCount: z.number().int().min(0).max(128).optional(),
      })
      .passthrough(),
    rosterSettings: z
      .object({
        lineupSlotCounts: lineupSlotCountsSchema,
      })
      .passthrough(),
    scheduleSettings: z
      .object({
        playoffTeamCount: z.number().int().min(1).max(64),
        matchupPeriodCount: z.number().int().min(0).max(30).optional(),
        playoffMatchupPeriodLength: z.number().int().min(0).max(10).optional(),
        playoffSeedingRule: nullableTextSchema(120),
        divisions: z
          .array(
            z
              .object({
                id: providerIdSchema,
                name: nonEmptyTextSchema(120),
              })
              .passthrough(),
          )
          .max(64)
          .optional(),
      })
      .passthrough(),
    scoringSettings: z
      .object({
        scoringItems: z.array(scoringItemSchema).max(256),
        matchupTieRule: nullableTextSchema(120),
        playoffMatchupTieRule: nullableTextSchema(120),
        scoringType: nullableTextSchema(120),
        scoringEnhancementType: nullableTextSchema(120),
      })
      .passthrough(),
    tradeSettings: z
      .object({
        deadlineDate: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
        revisionHours: z
          .number()
          .int()
          .min(0)
          .max(24 * 30)
          .optional(),
        vetoVotesRequired: z.number().int().min(0).max(64).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.draftSettings.type === "AUCTION" && value.draftSettings.auctionBudget < 1) {
      context.addIssue({
        code: "custom",
        path: ["draftSettings", "auctionBudget"],
        message: "auction drafts must declare a positive auction budget",
      });
    }
  });

const memberSchema = z
  .object({
    id: memberIdSchema,
    displayName: nonEmptyTextSchema(120),
    // ESPN sends these alongside the username on the league `members` array, but not for every
    // member and not on every league response — a member who never filled them in has neither.
    // Optional on purpose: a missing real name is a normal state, not schema drift.
    firstName: nonEmptyTextSchema(80).optional(),
    lastName: nonEmptyTextSchema(80).optional(),
    // ESPN omits this flag in some current league responses and has historically represented
    // provider booleans as 0/1 in adjacent payloads. Missing means unknown, never commissioner.
    isLeagueManager: espnBooleanSchema.optional(),
  })
  .passthrough();

/**
 * Joins ESPN's separate name parts. Returns null unless at least one part is present, so a member
 * who supplied neither keeps their username rather than being labelled with an empty string.
 */
function memberFullName(member: {
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
}): string | null {
  const joined = [member.firstName, member.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return joined.length > 0 ? joined : null;
}

const standingRecordSchema = z
  .object({
    wins: z.number().int().min(0).max(64),
    losses: z.number().int().min(0).max(64),
    ties: z.number().int().min(0).max(64),
    pointsFor: z.number().finite().min(-100_000).max(100_000),
    pointsAgainst: z.number().finite().min(-100_000).max(100_000),
    streakLength: z.number().int().min(0).max(64),
    streakType: z.enum(["WIN", "LOSS", "TIE", "NONE"]),
  })
  .passthrough();

const rosterEntrySchema = z
  .object({
    lineupSlotId: usableLineupSlotIdSchema,
    playerId: providerPlayerIdSchema,
    status: nonEmptyTextSchema(64),
    playerPoolEntry: z
      .object({
        id: providerPlayerIdSchema,
        onTeamId: providerIdSchema,
        status: z.literal("ONTEAM"),
        player: z
          .object({
            id: providerPlayerIdSchema,
            fullName: nonEmptyTextSchema(160),
            defaultPositionId: z.number().int().min(0).max(100),
            eligibleSlots: z.array(usableLineupSlotIdSchema).min(1).max(26),
            proTeamId: proTeamIdSchema,
            injuryStatus: z.union([nonEmptyTextSchema(64), z.null()]),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const pool = value.playerPoolEntry;
    if (value.playerId !== pool.id || value.playerId !== pool.player.id) {
      context.addIssue({
        code: "custom",
        path: ["playerId"],
        message: "roster player IDs must match at every ESPN nesting level",
      });
    }
    if (new Set(pool.player.eligibleSlots).size !== pool.player.eligibleSlots.length) {
      context.addIssue({
        code: "custom",
        path: ["playerPoolEntry", "player", "eligibleSlots"],
        message: "eligibleSlots must not contain duplicate slot IDs",
      });
    }
    if (!pool.player.eligibleSlots.some((slotId) => PRIMARY_POSITION_SLOT_IDS.has(slotId))) {
      context.addIssue({
        code: "custom",
        path: ["playerPoolEntry", "player", "eligibleSlots"],
        message: "eligibleSlots must include a supported primary position",
      });
    }
    if (!pool.player.eligibleSlots.includes(value.lineupSlotId)) {
      context.addIssue({
        code: "custom",
        path: ["lineupSlotId"],
        message: "lineupSlotId must occur in the player's eligibleSlots",
      });
    }
  });

const teamSchema = z
  .object({
    id: providerIdSchema,
    name: nullableTextSchema(160),
    location: nullableTextSchema(80),
    nickname: nullableTextSchema(80),
    abbrev: nullableTextSchema(12),
    logo: z.union([webUrlSchema, z.literal(""), z.null()]).optional(),
    owners: z.array(memberIdSchema).max(16),
    primaryOwner: z.union([memberIdSchema, z.null()]).optional(),
    // A zero seed is ESPN's preseason/unranked sentinel. Positive in-season seeds remain strict.
    playoffSeed: z.number().int().min(0).max(64).optional(),
    waiverRank: z.number().int().min(0).max(64).optional(),
    transactionCounter: z
      .object({
        acquisitionBudgetSpent: z.number().int().min(0).max(100_000).optional(),
      })
      .passthrough()
      .optional(),
    record: z
      .object({
        overall: standingRecordSchema,
      })
      .passthrough()
      .optional(),
    roster: z
      .object({
        entries: z.array(rosterEntrySchema).max(128),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const hasName = typeof value.name === "string" && value.name.length > 0;
    const hasLocation = typeof value.location === "string" && value.location.length > 0;
    const hasNickname = typeof value.nickname === "string" && value.nickname.length > 0;
    if (!hasName && !(hasLocation && hasNickname)) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "team must have name or both location and nickname",
      });
    }
    if (new Set(value.owners).size !== value.owners.length) {
      context.addIssue({
        code: "custom",
        path: ["owners"],
        message: "team owners must not contain duplicate member IDs",
      });
    }
    if (value.primaryOwner !== undefined && value.primaryOwner !== null) {
      if (!value.owners.includes(value.primaryOwner)) {
        context.addIssue({
          code: "custom",
          path: ["primaryOwner"],
          message: "primaryOwner must also occur in owners",
        });
      }
    }
  });

const matchupSideSchema = z
  .object({
    teamId: providerIdSchema,
    totalPoints: z.number().finite().min(-100_000).max(100_000),
  })
  .passthrough();

const matchupSchema = z
  .object({
    id: providerIdSchema,
    matchupPeriodId: z.number().int().min(1).max(30),
    winner: z.enum(["HOME", "AWAY", "TIE", "UNDECIDED"]),
    home: matchupSideSchema,
    away: matchupSideSchema,
  })
  .passthrough();

export const espnWebClientPayloadV1Schema = z
  .object({
    id: providerIdSchema,
    seasonId: z.number().int().min(2000).max(2100),
    scoringPeriodId: z.number().int().min(0).max(30),
    status: z
      .object({
        latestScoringPeriod: z.number().int().min(0).max(30),
      })
      .passthrough(),
    settings: settingsSchema,
    members: z.array(memberSchema).max(128),
    teams: z.array(teamSchema).min(1).max(64),
    schedule: z.array(matchupSchema).max(1024).optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.settings.size !== value.teams.length) {
      context.addIssue({
        code: "custom",
        path: ["settings", "size"],
        message: "settings.size must equal the number of teams",
      });
    }
    if (value.settings.scheduleSettings.playoffTeamCount > value.settings.size) {
      context.addIssue({
        code: "custom",
        path: ["settings", "scheduleSettings", "playoffTeamCount"],
        message: "playoffTeamCount cannot exceed league size",
      });
    }

    const memberIds = new Set<string>();
    value.members.forEach((member, memberIndex) => {
      if (memberIds.has(member.id)) {
        context.addIssue({
          code: "custom",
          path: ["members", memberIndex, "id"],
          message: "member IDs must be unique",
        });
      }
      memberIds.add(member.id);
    });

    const configuredSlots = value.settings.rosterSettings.lineupSlotCounts;
    const rosterCapacity = Object.values(configuredSlots).reduce(
      (total, count) => total + count,
      0,
    );
    const teamIds = new Set<string>();
    const playerIds = new Set<string>();
    const standingSeeds = new Set<number>();
    let standingTeamCount = 0;
    value.teams.forEach((team, teamIndex) => {
      if (teamIds.has(team.id)) {
        context.addIssue({
          code: "custom",
          path: ["teams", teamIndex, "id"],
          message: "team IDs must be unique",
        });
      }
      teamIds.add(team.id);
      if (team.record !== undefined) {
        standingTeamCount += 1;
        if (team.playoffSeed === undefined) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "playoffSeed"],
            message: "a standings record requires playoffSeed",
          });
        } else if (team.playoffSeed > 0 && standingSeeds.has(team.playoffSeed)) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "playoffSeed"],
            message: "standings seeds must be unique",
          });
        } else if (team.playoffSeed > 0) {
          standingSeeds.add(team.playoffSeed);
        }
      } else if ((team.playoffSeed ?? 0) > 0) {
        context.addIssue({
          code: "custom",
          path: ["teams", teamIndex, "record"],
          message: "playoffSeed requires an overall standings record",
        });
      }
      team.owners.forEach((ownerId, ownerIndex) => {
        if (!memberIds.has(ownerId)) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "owners", ownerIndex],
            message: "team owner must reference a member",
          });
        }
      });
      if (team.roster.entries.length > rosterCapacity) {
        context.addIssue({
          code: "custom",
          path: ["teams", teamIndex, "roster", "entries"],
          message: "team roster exceeds configured roster capacity",
        });
      }
      team.roster.entries.forEach((entry, entryIndex) => {
        if (entry.playerPoolEntry.onTeamId !== team.id) {
          context.addIssue({
            code: "custom",
            path: [
              "teams",
              teamIndex,
              "roster",
              "entries",
              entryIndex,
              "playerPoolEntry",
              "onTeamId",
            ],
            message: "roster entry onTeamId must match its team",
          });
        }
        if ((configuredSlots[String(entry.lineupSlotId)] ?? 0) < 1) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "roster", "entries", entryIndex, "lineupSlotId"],
            message: "roster entry uses a slot not configured by the league",
          });
        }
        if (playerIds.has(entry.playerId)) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "roster", "entries", entryIndex, "playerId"],
            message: "a player cannot be rostered more than once in a league snapshot",
          });
        }
        playerIds.add(entry.playerId);
      });
    });
    if (standingTeamCount !== 0 && standingTeamCount !== value.teams.length) {
      context.addIssue({
        code: "custom",
        path: ["teams"],
        message: "standings records must be present for every team or omitted for every team",
      });
    }

    const matchupIds = new Set<string>();
    value.schedule?.forEach((matchup, matchupIndex) => {
      if (matchupIds.has(matchup.id)) {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "id"],
          message: "matchup IDs must be unique",
        });
      }
      matchupIds.add(matchup.id);
      if (!teamIds.has(matchup.home.teamId)) {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "home", "teamId"],
          message: "home team must reference a league team",
        });
      }
      if (!teamIds.has(matchup.away.teamId)) {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "away", "teamId"],
          message: "away team must reference a league team",
        });
      }
      if (matchup.home.teamId === matchup.away.teamId) {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex],
          message: "a team cannot play itself",
        });
      }
      if (matchup.matchupPeriodId < value.scoringPeriodId && matchup.winner === "UNDECIDED") {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "winner"],
          message: "a completed scoring period cannot remain undecided",
        });
      }
      if (matchup.matchupPeriodId > value.scoringPeriodId && matchup.winner !== "UNDECIDED") {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "winner"],
          message: "a future matchup cannot have a winner",
        });
      }
      if (matchup.winner === "HOME" && matchup.home.totalPoints <= matchup.away.totalPoints) {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "winner"],
          message: "HOME winner must have the higher score",
        });
      }
      if (matchup.winner === "AWAY" && matchup.away.totalPoints <= matchup.home.totalPoints) {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "winner"],
          message: "AWAY winner must have the higher score",
        });
      }
      if (matchup.winner === "TIE" && matchup.home.totalPoints !== matchup.away.totalPoints) {
        context.addIssue({
          code: "custom",
          path: ["schedule", matchupIndex, "winner"],
          message: "TIE winner requires equal scores",
        });
      }
    });

    const scoringRuleCount = value.settings.scoringSettings.scoringItems.reduce(
      (total, item) => total + 1 + Object.keys(item.pointsOverrides ?? {}).length,
      0,
    );
    if (scoringRuleCount > 512) {
      context.addIssue({
        code: "custom",
        path: ["settings", "scoringSettings", "scoringItems"],
        message: "expanded scoring rules exceed the normalized contract limit",
      });
    }
    const scoringStatIds = new Set<number>();
    value.settings.scoringSettings.scoringItems.forEach((item, itemIndex) => {
      if (scoringStatIds.has(item.statId)) {
        context.addIssue({
          code: "custom",
          path: ["settings", "scoringSettings", "scoringItems", itemIndex, "statId"],
          message: "scoringItems stat IDs must be unique",
        });
      }
      scoringStatIds.add(item.statId);
    });
  });

export type EspnWebClientPayloadV1 = z.infer<typeof espnWebClientPayloadV1Schema>;

const endpointSchema = z
  .string()
  .url()
  .max(4096)
  .refine(
    (value) => URL.canParse(value) && new URL(value).origin === ESPN_READ_ORIGIN,
    "must use the ESPN fantasy read origin",
  );

export const espnBridgeSnapshotLikeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("espn"),
    // `browser-local` remains wire-compatible with published extensions; native agents use the
    // same bounded envelope with distinct audit provenance.
    authority: z.enum(["browser-local", "native-local", "server-session"]),
    readOnly: z.literal(true),
    leagueId: z.string().regex(/^\d{1,20}$/u),
    season: z.number().int().min(2000).max(2100),
    capturedAt: z.string().datetime({ offset: true }),
    endpoint: endpointSchema,
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    checksumAlgorithm: z.enum(["json-stringify-sha256", "canonical-json-v1-sha256"]).optional(),
    payload: z.unknown(),
  })
  .strict();

export type EspnBridgeSnapshotLikeV1 = z.infer<typeof espnBridgeSnapshotLikeV1Schema>;

export type EspnWebClientNormalizationErrorCode =
  "INVALID_JSON" | "TOO_LARGE" | "INVALID_ENVELOPE" | "INVALID_METADATA" | "SCHEMA_DRIFT";

export interface EspnWebClientNormalizationIssue {
  readonly path: string;
  readonly code: EspnWebClientNormalizationErrorCode;
  readonly message: string;
}

export class EspnWebClientNormalizationError extends Error {
  public readonly code: EspnWebClientNormalizationErrorCode;
  public readonly issues: readonly EspnWebClientNormalizationIssue[];

  public constructor(input: {
    code: EspnWebClientNormalizationErrorCode;
    message: string;
    issues?: readonly EspnWebClientNormalizationIssue[];
  }) {
    super(input.message);
    this.name = "EspnWebClientNormalizationError";
    this.code = input.code;
    this.issues = input.issues ?? [];
  }
}

export interface NormalizeEspnWebClientSnapshotOptions {
  /** Used only when a raw payload has no capturedAt metadata. */
  readonly now?: () => Date;
  /** Optional provenance for a raw payload. A bridge envelope remains authoritative. */
  readonly capturedAt?: string;
  readonly endpoint?: string | null;
  readonly checksumSha256?: string | null;
}

interface ReadInputResult {
  readonly artifact: string;
  readonly value: unknown;
}

interface NormalizationSource {
  readonly checksumSha256: string;
  readonly endpoint: string | null;
  readonly fetchedAt: string;
  readonly kind: "bridge-envelope" | "raw-payload";
  readonly authority: "browser-local" | "native-local" | "server-session" | null;
  readonly payload: unknown;
  readonly expectedLeagueId: string | null;
  readonly expectedSeason: number | null;
}

function readBoundedInput(input: unknown): ReadInputResult {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_ESPN_WEB_CLIENT_SNAPSHOT_BYTES) {
      throw new EspnWebClientNormalizationError({
        code: "TOO_LARGE",
        message: "ESPN web-client snapshot exceeds the 5 MiB safety limit",
      });
    }
    try {
      return { value: JSON.parse(input) as unknown, artifact: input };
    } catch {
      throw new EspnWebClientNormalizationError({
        code: "INVALID_JSON",
        message: "ESPN web-client snapshot is not valid JSON",
      });
    }
  }

  let artifact: string | undefined;
  try {
    artifact = JSON.stringify(input);
  } catch {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_JSON",
      message: "ESPN web-client snapshot must be JSON serializable",
    });
  }
  if (artifact === undefined) {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_JSON",
      message: "ESPN web-client snapshot cannot be empty",
    });
  }
  if (Buffer.byteLength(artifact, "utf8") > MAX_ESPN_WEB_CLIENT_SNAPSHOT_BYTES) {
    throw new EspnWebClientNormalizationError({
      code: "TOO_LARGE",
      message: "ESPN web-client snapshot exceeds the 5 MiB safety limit",
    });
  }
  return { value: input, artifact };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeEnvelope(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some((key) => ENVELOPE_DISCRIMINATORS.has(key));
}

function sanitizedIssues(
  error: z.ZodError,
  code: EspnWebClientNormalizationErrorCode,
): readonly EspnWebClientNormalizationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    code,
    message:
      issue.code === "custom"
        ? issue.message
        : `Value did not match the expected ESPN web-client v${ESPN_WEB_CLIENT_CONTRACT_VERSION} shape`,
  }));
}

function validateEndpoint(endpoint: string, leagueId: string, season: number): void {
  const url = new URL(endpoint);
  const expectedPath = `/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const views = url.searchParams.getAll("view");
  const invalidParameter = [...url.searchParams.keys()].some((key) => key !== "view");
  const invalidView = views.some((view) => !ALLOWED_VIEWS.has(view));
  const missingView = REQUIRED_VIEWS.some((requiredView) => !views.includes(requiredView));
  if (
    url.origin !== ESPN_READ_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath ||
    url.hash !== "" ||
    invalidParameter ||
    invalidView ||
    missingView
  ) {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN bridge endpoint did not match the requested league and required views",
      issues: [
        {
          path: "endpoint",
          code: "INVALID_ENVELOPE",
          message: "Endpoint must be the versioned ESPN league read URL with required views",
        },
      ],
    });
  }
}

function rawMetadata(
  artifact: string,
  options: NormalizeEspnWebClientSnapshotOptions,
): Omit<NormalizationSource, "payload" | "expectedLeagueId" | "expectedSeason"> {
  const metadataSchema = z
    .object({
      capturedAt: z.string().datetime({ offset: true }).optional(),
      endpoint: z.union([endpointSchema, z.null()]).optional(),
      checksumSha256: z.union([z.string().regex(/^[a-f0-9]{64}$/u), z.null()]).optional(),
    })
    .strict();
  const result = metadataSchema.safeParse({
    capturedAt: options.capturedAt,
    endpoint: options.endpoint,
    checksumSha256: options.checksumSha256,
  });
  if (!result.success) {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_METADATA",
      message: "Raw ESPN payload provenance metadata is invalid",
      issues: sanitizedIssues(result.error, "INVALID_METADATA"),
    });
  }

  let fetchedAt = result.data.capturedAt;
  if (fetchedAt === undefined) {
    try {
      fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    } catch {
      throw new EspnWebClientNormalizationError({
        code: "INVALID_METADATA",
        message: "Raw ESPN payload capture time is invalid",
      });
    }
  }
  return {
    checksumSha256:
      result.data.checksumSha256 ?? createHash("sha256").update(artifact, "utf8").digest("hex"),
    endpoint: result.data.endpoint ?? null,
    fetchedAt,
    kind: "raw-payload",
    authority: null,
  };
}

function sourceFromInput(
  input: ReadInputResult,
  options: NormalizeEspnWebClientSnapshotOptions,
): NormalizationSource {
  if (!looksLikeEnvelope(input.value)) {
    return {
      ...rawMetadata(input.artifact, options),
      payload: input.value,
      expectedLeagueId: null,
      expectedSeason: null,
    };
  }

  const envelopeResult = espnBridgeSnapshotLikeV1Schema.safeParse(input.value);
  if (!envelopeResult.success) {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN bridge snapshot did not match the browser-local envelope contract",
      issues: sanitizedIssues(envelopeResult.error, "INVALID_ENVELOPE"),
    });
  }
  const envelope = envelopeResult.data;
  validateEndpoint(envelope.endpoint, envelope.leagueId, envelope.season);
  return {
    payload: envelope.payload,
    expectedLeagueId: envelope.leagueId,
    expectedSeason: envelope.season,
    endpoint: envelope.endpoint,
    fetchedAt: envelope.capturedAt,
    checksumSha256: envelope.checksumSha256,
    kind: "bridge-envelope",
    authority: envelope.authority,
  };
}

function draftType(type: EspnWebClientPayloadV1["settings"]["draftSettings"]["type"]): DraftType {
  return type === "AUCTION" ? "auction" : "snake";
}

function waiverType(
  settings: EspnWebClientPayloadV1["settings"]["acquisitionSettings"],
): WaiverType {
  if (settings.isUsingAcquisitionBudget) return "faab";
  if (settings.acquisitionType === "FREE_AGENTS_ONLY") return "free-agent";
  return settings.waiverOrderReset ? "reverse-standings" : "rolling";
}

function lineupSlotName(slotId: number): string {
  return LINEUP_SLOT_NAMES[slotId as keyof typeof LINEUP_SLOT_NAMES];
}

export function espnLineupSlotName(slotId: number): string | undefined {
  return LINEUP_SLOT_NAMES[slotId as keyof typeof LINEUP_SLOT_NAMES];
}

export function espnPrimaryPosition(eligibleSlotIds: readonly number[]): string | undefined {
  const primarySlotId = eligibleSlotIds.find((slotId) => PRIMARY_POSITION_SLOT_IDS.has(slotId));
  return primarySlotId === undefined ? undefined : espnLineupSlotName(primarySlotId);
}

export function espnProTeamAbbreviation(proTeamId: number): string | null | undefined {
  return PRO_TEAM_ABBREVIATIONS[proTeamId as keyof typeof PRO_TEAM_ABBREVIATIONS];
}

export function espnLineupSlotIsStarter(slotId: number): boolean {
  return Object.hasOwn(LINEUP_SLOT_NAMES, slotId) && slotId !== 22 && !RESERVE_SLOT_IDS.has(slotId);
}

function teamAbbreviation(team: EspnWebClientPayloadV1["teams"][number]): string | null {
  return typeof team.abbrev === "string" && team.abbrev.length > 0 ? team.abbrev : null;
}

function teamLogo(team: EspnWebClientPayloadV1["teams"][number]): string | null {
  if (typeof team.logo !== "string" || team.logo.length === 0) return null;
  const url = new URL(team.logo);
  // Never persist or render provider-supplied mixed-content URLs. A logo is optional data, so
  // dropping a legacy HTTP URL is safer than guessing that its host supports HTTPS.
  return url.protocol === "https:" ? url.toString() : null;
}

function teamName(team: EspnWebClientPayloadV1["teams"][number]): string {
  if (typeof team.name === "string" && team.name.length > 0) return team.name;
  return `${String(team.location)} ${String(team.nickname)}`;
}

function normalizeScoringRules(
  items: EspnWebClientPayloadV1["settings"]["scoringSettings"]["scoringItems"],
): readonly NormalizedScoringRule[] {
  return items.flatMap((item) => {
    const base: NormalizedScoringRule = {
      statId: String(item.statId),
      name: null,
      points: item.points,
    };
    const overrides = Object.entries(item.pointsOverrides ?? {}).map(
      ([slotIdText, points]): NormalizedScoringRule => {
        const slotName = lineupSlotName(Number(slotIdText));
        return {
          statId: `${item.statId}:slot:${slotIdText}`,
          name: `ESPN stat ${item.statId} override for ${slotName}`,
          points,
        };
      },
    );
    return [base, ...overrides];
  });
}

function normalizePlayer(
  entry: EspnWebClientPayloadV1["teams"][number]["roster"]["entries"][number],
  season: number,
): NormalizedRosterPlayer {
  const player = entry.playerPoolEntry.player;
  const primarySlotId = player.eligibleSlots.find((slotId) =>
    PRIMARY_POSITION_SLOT_IDS.has(slotId),
  );
  if (primarySlotId === undefined) {
    throw new EspnWebClientNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN player had no supported primary position",
    });
  }
  return {
    externalId: `espn:${season}:player:${entry.playerId}`,
    providerPlayerId: entry.playerId,
    fullName: player.fullName,
    primaryPosition: lineupSlotName(primarySlotId),
    eligiblePositions: [...new Set(player.eligibleSlots.map((slotId) => lineupSlotName(slotId)))],
    lineupSlot: lineupSlotName(entry.lineupSlotId),
    proTeamAbbreviation:
      PRO_TEAM_ABBREVIATIONS[player.proTeamId as keyof typeof PRO_TEAM_ABBREVIATIONS],
    status: player.injuryStatus,
  };
}

function normalizeTeam(
  team: EspnWebClientPayloadV1["teams"][number],
  members: ReadonlyMap<string, EspnWebClientPayloadV1["members"][number]>,
  leagueId: string,
  season: number,
  acquisitionBudget: number | null,
): NormalizedTeam {
  const spent = team.transactionCounter?.acquisitionBudgetSpent;
  const faabRemaining =
    acquisitionBudget === null || spent === undefined
      ? null
      : Math.max(0, acquisitionBudget - spent);
  return {
    externalId: `espn:${season}:${leagueId}:team:${team.id}`,
    providerTeamId: team.id,
    name: teamName(team),
    abbreviation: teamAbbreviation(team),
    url: `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${team.id}`,
    logoUrl: teamLogo(team),
    isCurrentUser: false,
    faabRemaining,
    waiverPriority: team.waiverRank && team.waiverRank > 0 ? team.waiverRank : null,
    managers: team.owners.map((ownerId) => {
      const member = members.get(ownerId);
      if (member === undefined) {
        throw new EspnWebClientNormalizationError({
          code: "SCHEMA_DRIFT",
          message: "ESPN team owner did not resolve to a league member",
        });
      }
      return {
        externalId: member.id,
        displayName: member.displayName,
        fullName: memberFullName(member),
        isCommissioner: member.isLeagueManager ?? false,
      };
    }),
    roster: team.roster.entries.map((entry) => normalizePlayer(entry, season)),
  };
}

function normalizedLimit(value: number | undefined): number | null {
  return value === undefined || value < 0 ? null : value;
}

/**
 * Splits ESPN's two per-matchup acquisition fields into the count and the "does a limit apply"
 * answer. `matchupLimitPerScoringPeriod` is a boolean flag in the current API, so it can only ever
 * supply the second answer; coercing `false` into the count would write a bogus limit, and mapping
 * `true` to a number would invent one. A count therefore comes only from a numeric field.
 *
 * `false` was observed on both active leagues captured on 2026-07-28 and is treated as
 * authoritative: no limit applies, so no count is reported even if ESPN also sent one. `true` was
 * observed only on a league ESPN had not activated for the season, so it is passed through as the
 * flag ESPN sent and nothing further is concluded from it.
 */
function matchupAcquisitionLimits(
  acquisition: EspnWebClientPayloadV1["settings"]["acquisitionSettings"],
): { limit: number | null; enabled: boolean | null } {
  const perPeriod = acquisition.matchupLimitPerScoringPeriod;
  const flag = typeof perPeriod === "boolean" ? perPeriod : null;
  const legacyCount = typeof perPeriod === "number" ? perPeriod : undefined;
  const declared = acquisition.matchupAcquisitionLimit ?? legacyCount;
  return {
    limit: flag === false ? null : normalizedLimit(declared),
    // Without the flag, ESPN's own -1 sentinel still distinguishes "unlimited" from "not told".
    enabled: flag ?? (declared === undefined ? null : declared >= 0),
  };
}

/** Day names normalize by index (0 = Sunday); legacy numbers pass through as ESPN encoded them. */
function normalizedWaiverProcessDays(
  value: readonly (number | string)[] | undefined,
): readonly number[] {
  const days = (value ?? []).map((entry) =>
    typeof entry === "number"
      ? entry
      : (WAIVER_PROCESS_DAY_NAMES as readonly string[]).indexOf(entry),
  );
  return [...new Set(days)].sort((left, right) => left - right);
}

function operationalRules(
  settings: EspnWebClientPayloadV1["settings"],
): NonNullable<LeagueSyncBundle["league"]["settings"]["operationalRules"]> {
  const acquisition = settings.acquisitionSettings;
  const schedule = settings.scheduleSettings;
  const scoring = settings.scoringSettings;
  const trade = settings.tradeSettings;
  const deadline = trade?.deadlineDate;
  const matchupLimits = matchupAcquisitionLimits(acquisition);
  return {
    acquisitionLimit: normalizedLimit(acquisition.acquisitionLimit),
    matchupAcquisitionLimit: matchupLimits.limit,
    matchupAcquisitionLimitEnabled: matchupLimits.enabled,
    minimumBid: acquisition.minimumBid ?? null,
    waiverProcessDays: normalizedWaiverProcessDays(acquisition.waiverProcessDays),
    waiverProcessHour: acquisition.waiverProcessHour ?? null,
    keeperCount: settings.draftSettings.keeperCount ?? null,
    regularSeasonMatchupPeriods: schedule.matchupPeriodCount ?? null,
    playoffMatchupPeriodLength: schedule.playoffMatchupPeriodLength ?? null,
    playoffSeedingRule: schedule.playoffSeedingRule ?? null,
    matchupTieRule: scoring.matchupTieRule ?? null,
    playoffMatchupTieRule: scoring.playoffMatchupTieRule ?? null,
    scoringType: scoring.scoringType ?? null,
    medianGameEnabled:
      scoring.scoringEnhancementType === undefined || scoring.scoringEnhancementType === null
        ? null
        : scoring.scoringEnhancementType === "WIN_BONUS_TOP_HALF",
    tradeDeadlineAt: deadline === undefined ? null : new Date(deadline).toISOString(),
    tradeReviewHours: trade?.revisionHours ?? null,
    vetoVotesRequired: trade?.vetoVotesRequired ?? null,
    divisions: (schedule.divisions ?? []).map((division) => ({
      providerDivisionId: division.id,
      name: division.name,
    })),
  };
}

function normalizedTeamExternalId(
  leagueId: string,
  season: number,
  providerTeamId: string,
): string {
  return `espn:${season}:${leagueId}:team:${providerTeamId}`;
}

function normalizeStandings(
  payload: EspnWebClientPayloadV1,
): NormalizedStandingsSnapshot | undefined {
  if (!payload.teams.some((team) => team.record !== undefined)) return undefined;
  const hasRankedSeeds = payload.teams.every(
    (team) => team.playoffSeed !== undefined && team.playoffSeed > 0,
  );
  const orderedTeams = [...payload.teams].sort((left, right) => {
    if (left.record === undefined || right.record === undefined) return 0;
    if (hasRankedSeeds) return (left.playoffSeed ?? 0) - (right.playoffSeed ?? 0);
    const leftRecord = left.record.overall;
    const rightRecord = right.record.overall;
    return (
      rightRecord.wins - leftRecord.wins ||
      leftRecord.losses - rightRecord.losses ||
      rightRecord.ties - leftRecord.ties ||
      rightRecord.pointsFor - leftRecord.pointsFor ||
      leftRecord.pointsAgainst - rightRecord.pointsAgainst ||
      numericIdComparison(left.id, right.id)
    );
  });
  const rankByTeamId = new Map(orderedTeams.map((team, index) => [team.id, index + 1]));
  const entries = payload.teams.map((team) => {
    if (team.record === undefined || team.playoffSeed === undefined) {
      throw new EspnWebClientNormalizationError({
        code: "SCHEMA_DRIFT",
        message: "ESPN standings were incomplete after validation",
      });
    }
    const overall = team.record.overall;
    const rank = rankByTeamId.get(team.id);
    if (rank === undefined) {
      throw new EspnWebClientNormalizationError({
        code: "SCHEMA_DRIFT",
        message: "ESPN standings rank could not be derived",
      });
    }
    return {
      teamExternalId: normalizedTeamExternalId(payload.id, payload.seasonId, team.id),
      providerTeamId: team.id,
      rank,
      playoffSeed: rank,
      wins: overall.wins,
      losses: overall.losses,
      ties: overall.ties,
      pointsFor: overall.pointsFor,
      pointsAgainst: overall.pointsAgainst,
      streakType: overall.streakType.toLowerCase() as "win" | "loss" | "tie" | "none",
      streakLength: overall.streakLength,
    };
  });
  entries.sort((left, right) => left.rank - right.rank);
  return {
    asOfWeek: payload.status.latestScoringPeriod === 0 ? null : payload.status.latestScoringPeriod,
    entries,
  };
}

function numericIdComparison(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

function normalizeMatchups(payload: EspnWebClientPayloadV1): NormalizedMatchupSnapshot | undefined {
  if (payload.schedule === undefined) return undefined;
  const matchups = payload.schedule.map((matchup) => {
    const status =
      matchup.winner !== "UNDECIDED"
        ? ("final" as const)
        : matchup.matchupPeriodId <= payload.scoringPeriodId
          ? ("in-progress" as const)
          : ("scheduled" as const);
    const homeTeamExternalId = normalizedTeamExternalId(
      payload.id,
      payload.seasonId,
      matchup.home.teamId,
    );
    const awayTeamExternalId = normalizedTeamExternalId(
      payload.id,
      payload.seasonId,
      matchup.away.teamId,
    );
    const winnerTeamExternalId =
      matchup.winner === "HOME"
        ? homeTeamExternalId
        : matchup.winner === "AWAY"
          ? awayTeamExternalId
          : null;
    return {
      externalId: `espn:${payload.seasonId}:${payload.id}:matchup:${matchup.id}`,
      providerMatchupId: matchup.id,
      week: matchup.matchupPeriodId,
      status,
      home: {
        teamExternalId: homeTeamExternalId,
        providerTeamId: matchup.home.teamId,
        score: status === "scheduled" ? null : matchup.home.totalPoints,
      },
      away: {
        teamExternalId: awayTeamExternalId,
        providerTeamId: matchup.away.teamId,
        score: status === "scheduled" ? null : matchup.away.totalPoints,
      },
      winnerTeamExternalId,
      tied: matchup.winner === "TIE",
    };
  });
  matchups.sort(
    (left, right) =>
      left.week - right.week ||
      numericIdComparison(left.providerMatchupId, right.providerMatchupId),
  );
  return {
    asOfWeek: payload.scoringPeriodId === 0 ? null : payload.scoringPeriodId,
    matchups,
  };
}

function validateRequestedViewData(
  source: NormalizationSource,
  payload: EspnWebClientPayloadV1,
): void {
  if (source.endpoint === null) return;
  const requestedViews = new Set(new URL(source.endpoint).searchParams.getAll("view"));
  const issues: EspnWebClientNormalizationIssue[] = [];
  if (
    requestedViews.has("mStandings") &&
    !payload.teams.every((team) => team.record !== undefined)
  ) {
    issues.push({
      path: "teams",
      code: "SCHEMA_DRIFT",
      message: "mStandings was requested but complete team standings records were absent",
    });
  }
  if (requestedViews.has("mMatchup") && payload.schedule === undefined) {
    issues.push({
      path: "schedule",
      code: "SCHEMA_DRIFT",
      message: "mMatchup was requested but the league schedule was absent",
    });
  }
  if (issues.length > 0) {
    throw new EspnWebClientNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN payload omitted data requested by the browser bridge",
      issues,
    });
  }
}

/**
 * Normalize a browser-local bridge envelope or a raw observed ESPN payload.
 * This function is deterministic and performs no cookie access or network I/O.
 */
export function normalizeEspnWebClientSnapshot(
  input: unknown,
  options: NormalizeEspnWebClientSnapshotOptions = {},
): LeagueSyncBundle {
  const source = sourceFromInput(readBoundedInput(input), options);
  const payloadResult = espnWebClientPayloadV1Schema.safeParse(source.payload);
  if (!payloadResult.success) {
    throw new EspnWebClientNormalizationError({
      code: "SCHEMA_DRIFT",
      message: `ESPN payload did not match observed web-client contract version ${ESPN_WEB_CLIENT_CONTRACT_VERSION}`,
      issues: sanitizedIssues(payloadResult.error, "SCHEMA_DRIFT"),
    });
  }
  const payload = payloadResult.data;
  if (
    (source.expectedLeagueId !== null && source.expectedLeagueId !== payload.id) ||
    (source.expectedSeason !== null && source.expectedSeason !== payload.seasonId)
  ) {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN bridge envelope does not identify its enclosed league payload",
      issues: [
        {
          path: "payload",
          code: "INVALID_ENVELOPE",
          message: "Envelope leagueId and season must match payload id and seasonId",
        },
      ],
    });
  }
  if (source.endpoint !== null) validateEndpoint(source.endpoint, payload.id, payload.seasonId);
  validateRequestedViewData(source, payload);

  const members = new Map(payload.members.map((member) => [member.id, member]));
  const acquisitionSettings = payload.settings.acquisitionSettings;
  const scoringRules = normalizeScoringRules(payload.settings.scoringSettings.scoringItems);
  const warnings = [
    "ESPN web-client contract v1 is unofficial and can drift; requested settings, team, roster, standings, and matchup shapes were validated before normalization.",
    "This parser performs no network requests and receives no ESPN cookies or credentials.",
    "The snapshot does not identify the active ESPN member, so isCurrentUser is false for every team.",
  ];
  if (payload.members.some((member) => member.isLeagueManager === undefined)) {
    warnings.push(
      "ESPN omitted one or more league-manager flags; those managers were treated as non-commissioners.",
    );
  }
  if (
    payload.teams.some((team) => typeof team.logo === "string" && team.logo.startsWith("http://"))
  ) {
    warnings.push("Legacy insecure ESPN team-logo URLs were discarded instead of persisted.");
  }
  if (payload.teams.some((team) => team.record !== undefined && team.playoffSeed === 0)) {
    warnings.push(
      "ESPN reported unranked preseason standings; Laces Out derived a deterministic provisional order.",
    );
  }
  if (source.kind === "raw-payload") {
    warnings.push(
      "A raw ESPN payload was normalized without a browser-local envelope; capture metadata is generated locally or supplied by the caller.",
    );
  }
  if (scoringRules.length > payload.settings.scoringSettings.scoringItems.length) {
    warnings.push(
      "Position-specific ESPN scoring overrides use composite stat IDs formatted as <statId>:slot:<slotId>.",
    );
  }
  if (["AUTOPICK", "SNAIL"].includes(payload.settings.draftSettings.type)) {
    warnings.push(
      `ESPN draft type ${payload.settings.draftSettings.type} was normalized to snake because the provider-neutral contract has no matching subtype.`,
    );
  }

  const leagueId = payload.id;
  const season = payload.seasonId;
  const standings = normalizeStandings(payload);
  const matchups = normalizeMatchups(payload);
  return {
    schemaVersion: NORMALIZED_SYNC_SCHEMA_VERSION,
    provider: "espn",
    league: {
      externalId: `espn:${season}:${leagueId}`,
      providerLeagueId: leagueId,
      provider: "espn",
      season,
      name: payload.settings.name,
      url: `https://fantasy.espn.com/football/league?leagueId=${leagueId}`,
      currentWeek:
        payload.status.latestScoringPeriod === 0 ? null : payload.status.latestScoringPeriod,
      settings: {
        teamCount: payload.settings.size,
        draftType: draftType(payload.settings.draftSettings.type),
        auctionBudget:
          payload.settings.draftSettings.type === "AUCTION"
            ? payload.settings.draftSettings.auctionBudget
            : null,
        waiverType: waiverType(acquisitionSettings),
        faabBudget: acquisitionSettings.isUsingAcquisitionBudget
          ? acquisitionSettings.acquisitionBudget
          : null,
        playoffTeamCount: payload.settings.scheduleSettings.playoffTeamCount,
        rosterSlots: Object.entries(payload.settings.rosterSettings.lineupSlotCounts)
          .filter(([, count]) => count > 0)
          .map(([slotIdText, count]) => {
            const slotId = Number(slotIdText);
            return {
              position: lineupSlotName(slotId),
              count,
              starting: !RESERVE_SLOT_IDS.has(slotId),
            };
          }),
        scoringRules,
        operationalRules: operationalRules(payload.settings),
      },
    },
    teams: payload.teams.map((team) =>
      normalizeTeam(
        team,
        members,
        leagueId,
        season,
        acquisitionSettings.isUsingAcquisitionBudget ? acquisitionSettings.acquisitionBudget : null,
      ),
    ),
    ...(standings === undefined ? {} : { standings }),
    ...(matchups === undefined ? {} : { matchups }),
    provenance: {
      mode:
        source.authority === "server-session"
          ? "server-session"
          : source.kind === "bridge-envelope"
            ? "browser-local"
            : "public-unofficial",
      fetchedAt: source.fetchedAt,
      endpoint: source.endpoint,
      artifactChecksumSha256: source.checksumSha256,
    },
    warnings,
  };
}
