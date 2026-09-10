import { z } from "zod";

import { freshnessSchema, providerSchema } from "./decision-primitives.js";

export const playerExposureLeagueSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    provider: providerSchema.nullable(),
    season: z.number().int().nullable(),
    teamId: z.uuid().nullable(),
    teamName: z.string().nullable(),
    status: z.enum([
      "included",
      "archived",
      "other-season",
      "no-season",
      "team-unclaimed",
      "roster-missing",
    ]),
    rosterUpdatedAt: z.iso.datetime().nullable(),
    week: z.number().int().nullable(),
    freshness: freshnessSchema.nullable(),
  })
  .strict();
export type PlayerExposureLeague = z.infer<typeof playerExposureLeagueSchema>;

export const playerExposurePlayerSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    position: z.string(),
    nflTeam: z.string().nullable(),
    leagueIds: z.array(z.uuid()).min(1),
    starterLeagueIds: z.array(z.uuid()),
    /** Rounded whole percentage of included leagues, including explicitly empty rosters. */
    rosterPercentage: z.number().int().min(0).max(100),
  })
  .strict();
export type PlayerExposurePlayer = z.infer<typeof playerExposurePlayerSchema>;

export const playerExposureResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    /** Most recent season among this account's nonarchived accessible leagues. */
    season: z.number().int().nullable(),
    leagues: z.array(playerExposureLeagueSchema),
    players: z.array(playerExposurePlayerSchema),
  })
  .strict()
  .superRefine((response, context) => {
    const included = new Set(
      response.leagues.filter((league) => league.status === "included").map((league) => league.id),
    );
    if (new Set(response.leagues.map((league) => league.id)).size !== response.leagues.length) {
      context.addIssue({ code: "custom", path: ["leagues"], message: "League IDs must be unique" });
    }
    if (new Set(response.players.map((player) => player.id)).size !== response.players.length) {
      context.addIssue({ code: "custom", path: ["players"], message: "Player IDs must be unique" });
    }
    response.players.forEach((player, index) => {
      if (
        new Set(player.leagueIds).size !== player.leagueIds.length ||
        new Set(player.starterLeagueIds).size !== player.starterLeagueIds.length ||
        player.leagueIds.some((id) => !included.has(id)) ||
        player.starterLeagueIds.some((id) => !player.leagueIds.includes(id)) ||
        player.rosterPercentage !== Math.round((player.leagueIds.length / included.size) * 100)
      ) {
        context.addIssue({
          code: "custom",
          path: ["players", index],
          message: "Exposure must refer to unique included leagues with matching percentages",
        });
      }
    });
  });
export type PlayerExposureResponse = z.infer<typeof playerExposureResponseSchema>;
