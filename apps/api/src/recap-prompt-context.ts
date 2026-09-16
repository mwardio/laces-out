import { leagueWeeklyAwardsSectionSchema } from "@laces-out/contracts";

import { objectValue } from "./ai-bounded-text.js";

/** A recap uses only evidence from its completed week, never today's lineup or matchups. */
export function buildRecapPromptContext(analytics: unknown, requestedWeek?: number) {
  if (
    requestedWeek !== undefined &&
    (!Number.isInteger(requestedWeek) || requestedWeek < 1 || requestedWeek > 30)
  ) {
    return { state: "unavailable" as const, message: "The requested recap week is invalid." };
  }

  const snapshot = objectValue(analytics);
  const parsed = leagueWeeklyAwardsSectionSchema.safeParse(snapshot?.weeklyAwards);
  if (!parsed.success) {
    return {
      state: "unavailable" as const,
      message: "The weekly awards could not be validated. Refresh the league before trying again.",
    };
  }
  const section = parsed.data;
  if (section.state !== "available") {
    return {
      state: "unavailable" as const,
      message: section.reasons.map((reason) => reason.message.slice(0, 200)).join(" "),
    };
  }
  if (requestedWeek !== undefined && requestedWeek !== section.week) {
    return {
      state: "unavailable" as const,
      message: `Week ${requestedWeek} cannot be recapped because the available awards are for Week ${section.week}.`,
    };
  }

  const league = objectValue(snapshot?.league);
  const leagueName =
    typeof league?.name === "string" && league.name.trim()
      ? league.name.trim().slice(0, 200)
      : "League";
  const season =
    typeof league?.season === "number" &&
    Number.isInteger(league.season) &&
    league.season >= 2000 &&
    league.season <= 2200
      ? league.season
      : null;

  return {
    state: "available" as const,
    leagueName,
    week: section.week,
    sections: {
      league: { name: leagueName, season, week: section.week },
      weeklyAwards: {
        state: "available" as const,
        week: section.week,
        // Flat evidence keeps opponents and scores inside the shared serializer's depth limit.
        // Contract limits cap each list at ten, below its default twelve-item array limit.
        awards: section.awards.map((award) => ({
          id: award.id,
          label: award.label,
          definition: award.definition.slice(0, 300),
          teamName: award.team.name,
          value: award.value,
          unit: award.unit,
          opponentTeamName: award.detail.opponentTeam?.name ?? null,
          teamPoints: award.detail.teamPoints,
          opponentPoints: award.detail.opponentPoints,
          allPlayWins: award.detail.allPlayWins,
          allPlayGames: award.detail.allPlayGames,
        })),
        withheld: section.withheld.map((award) => ({
          id: award.id,
          label: award.label,
          reasons: award.reasons.map((reason) => ({
            code: reason.code,
            message: reason.message.slice(0, 200),
          })),
        })),
      },
    },
  };
}
