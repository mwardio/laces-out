import { createHash } from "node:crypto";

import {
  NORMALIZED_SYNC_SCHEMA_VERSION,
  type LeagueSyncBundle,
  type NormalizedRosterPlayer,
  type NormalizedTeam,
} from "@fantasy/connectors";
import { z } from "zod";

export const MAX_ESPN_IMPORT_BYTES = 2 * 1024 * 1024;

const providerIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}$/u, "must be a numeric ESPN ID");
const positionSchema = z.string().trim().min(1).max(16);
const httpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === "https:", "must use HTTPS");

const rosterSlotSchema = z
  .object({
    position: positionSchema,
    count: z.number().int().min(1).max(64),
    starting: z.boolean(),
  })
  .strict();

const scoringRuleSchema = z
  .object({
    statId: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(160).nullable(),
    points: z.number().finite().min(-1000).max(1000),
  })
  .strict();

const managerSchema = z
  .object({
    id: z.string().trim().min(1).max(128).nullable(),
    displayName: z.string().trim().min(1).max(120),
    isCommissioner: z.boolean(),
  })
  .strict();

const rosterPlayerSchema = z
  .object({
    id: providerIdSchema,
    fullName: z.string().trim().min(1).max(160),
    primaryPosition: positionSchema,
    eligiblePositions: z.array(positionSchema).min(1).max(20),
    lineupSlot: positionSchema,
    proTeamAbbreviation: z.string().trim().min(1).max(8).nullable(),
    status: z.string().trim().min(1).max(64).nullable(),
  })
  .strict();

const teamSchema = z
  .object({
    id: providerIdSchema,
    name: z.string().trim().min(1).max(160),
    abbreviation: z.string().trim().min(1).max(12).nullable(),
    logoUrl: httpsUrlSchema.nullable(),
    isCurrentUser: z.boolean(),
    managers: z.array(managerSchema).max(16),
    roster: z.array(rosterPlayerSchema).max(128),
  })
  .strict();

export const espnManualImportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("espn"),
    importedAt: z.string().datetime({ offset: true }).nullable(),
    league: z
      .object({
        id: providerIdSchema,
        season: z.number().int().min(2000).max(2100),
        name: z.string().trim().min(1).max(160),
        currentWeek: z.number().int().min(1).max(30).nullable(),
        settings: z
          .object({
            teamCount: z.number().int().min(1).max(64),
            draftType: z.enum(["snake", "auction", "offline", "unknown"]),
            auctionBudget: z.number().int().min(1).max(100_000).nullable(),
            waiverType: z.enum(["faab", "rolling", "reverse-standings", "free-agent", "unknown"]),
            faabBudget: z.number().int().min(0).max(100_000).nullable(),
            playoffTeamCount: z.number().int().min(1).max(64).nullable(),
            rosterSlots: z.array(rosterSlotSchema).min(1).max(64),
            scoringRules: z.array(scoringRuleSchema).max(512),
          })
          .strict(),
      })
      .strict(),
    teams: z.array(teamSchema).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.league.settings.teamCount !== value.teams.length) {
      context.addIssue({
        code: "custom",
        path: ["league", "settings", "teamCount"],
        message: "teamCount must equal the number of imported teams",
      });
    }

    const teamIds = new Set<string>();
    const rosteredPlayerIds = new Set<string>();
    value.teams.forEach((team, teamIndex) => {
      if (teamIds.has(team.id)) {
        context.addIssue({
          code: "custom",
          path: ["teams", teamIndex, "id"],
          message: "team IDs must be unique",
        });
      }
      teamIds.add(team.id);

      const playerIds = new Set<string>();
      team.roster.forEach((player, playerIndex) => {
        if (playerIds.has(player.id)) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "roster", playerIndex, "id"],
            message: "a player cannot occur twice on the same roster",
          });
        }
        playerIds.add(player.id);
        if (rosteredPlayerIds.has(player.id)) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "roster", playerIndex, "id"],
            message: "a player cannot be rostered by multiple teams",
          });
        }
        rosteredPlayerIds.add(player.id);
      });
    });

    const slotNames = new Set(value.league.settings.rosterSlots.map((slot) => slot.position));
    value.teams.forEach((team, teamIndex) => {
      team.roster.forEach((player, playerIndex) => {
        if (!slotNames.has(player.lineupSlot)) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "roster", playerIndex, "lineupSlot"],
            message: "lineupSlot must be declared in league.settings.rosterSlots",
          });
        }
      });
    });
  });

export type EspnManualImportV1 = z.infer<typeof espnManualImportV1Schema>;

export interface EspnImportIssue {
  readonly path: string;
  readonly message: string;
}

export class EspnImportError extends Error {
  public readonly issues: readonly EspnImportIssue[];

  public constructor(message: string, issues: readonly EspnImportIssue[] = []) {
    super(message);
    this.name = "EspnImportError";
    this.issues = issues;
  }
}

function readInput(input: unknown): { value: unknown; artifact: string } {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_ESPN_IMPORT_BYTES) {
      throw new EspnImportError("ESPN manual import exceeds the size limit");
    }
    try {
      return { value: JSON.parse(input) as unknown, artifact: input };
    } catch {
      throw new EspnImportError("ESPN manual import is not valid JSON");
    }
  }

  let artifact: string;
  try {
    artifact = JSON.stringify(input);
  } catch {
    throw new EspnImportError("ESPN manual import must be JSON serializable");
  }
  if (artifact === undefined || Buffer.byteLength(artifact, "utf8") > MAX_ESPN_IMPORT_BYTES) {
    throw new EspnImportError("ESPN manual import exceeds the size limit or is empty");
  }
  return { value: input, artifact };
}

function normalizePlayer(
  player: EspnManualImportV1["teams"][number]["roster"][number],
  season: number,
): NormalizedRosterPlayer {
  return {
    externalId: `espn:${season}:player:${player.id}`,
    providerPlayerId: player.id,
    fullName: player.fullName,
    primaryPosition: player.primaryPosition,
    eligiblePositions: [...new Set(player.eligiblePositions)],
    lineupSlot: player.lineupSlot,
    proTeamAbbreviation: player.proTeamAbbreviation,
    status: player.status,
  };
}

function normalizeTeam(
  team: EspnManualImportV1["teams"][number],
  leagueId: string,
  season: number,
): NormalizedTeam {
  return {
    externalId: `espn:${season}:${leagueId}:team:${team.id}`,
    providerTeamId: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    url: `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${team.id}`,
    logoUrl: team.logoUrl,
    isCurrentUser: team.isCurrentUser,
    managers: team.managers.map((manager) => ({
      externalId: manager.id,
      displayName: manager.displayName,
      isCommissioner: manager.isCommissioner,
    })),
    roster: team.roster.map((player) => normalizePlayer(player, season)),
  };
}

export interface ParseEspnManualImportOptions {
  readonly now?: () => Date;
}

/** Parse the durable, documented ESPN import contract into provider-neutral data. */
export function parseEspnManualImport(
  input: unknown,
  options: ParseEspnManualImportOptions = {},
): LeagueSyncBundle {
  const { value, artifact } = readInput(input);
  const result = espnManualImportV1Schema.safeParse(value);
  if (!result.success) {
    throw new EspnImportError(
      "ESPN manual import did not match schema version 1",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  const imported = result.data;
  const leagueExternalId = `espn:${imported.league.season}:${imported.league.id}`;
  const fetchedAt = imported.importedAt ?? (options.now ?? (() => new Date()))().toISOString();

  return {
    schemaVersion: NORMALIZED_SYNC_SCHEMA_VERSION,
    provider: "espn",
    league: {
      externalId: leagueExternalId,
      providerLeagueId: imported.league.id,
      provider: "espn",
      season: imported.league.season,
      name: imported.league.name,
      url: `https://fantasy.espn.com/football/league?leagueId=${imported.league.id}`,
      currentWeek: imported.league.currentWeek,
      settings: {
        teamCount: imported.league.settings.teamCount,
        draftType: imported.league.settings.draftType,
        auctionBudget: imported.league.settings.auctionBudget,
        waiverType: imported.league.settings.waiverType,
        faabBudget: imported.league.settings.faabBudget,
        playoffTeamCount: imported.league.settings.playoffTeamCount,
        rosterSlots: imported.league.settings.rosterSlots,
        scoringRules: imported.league.settings.scoringRules,
      },
    },
    teams: imported.teams.map((team) =>
      normalizeTeam(team, imported.league.id, imported.league.season),
    ),
    provenance: {
      mode: "manual-import",
      fetchedAt,
      endpoint: null,
      artifactChecksumSha256: createHash("sha256").update(artifact, "utf8").digest("hex"),
    },
    warnings: [
      "ESPN data was supplied by a manual snapshot; recommendations must show its import time.",
    ],
  };
}
