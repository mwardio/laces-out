import { leagueSeasons, scoringRules, type Database } from "@fantasy/db";
import {
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  firstPartyProjectionComponentsForPosition,
  firstPartyTeamDefenseProjectionComponents,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
} from "@fantasy/projections";
import { eq } from "drizzle-orm";

const positions = ["QB", "RB", "WR", "TE", "K"] as const;

const availableComponents = [
  ...new Set([
    ...positions.flatMap((position) => firstPartyProjectionComponentsForPosition(position)),
    "field_goals_made_50_plus",
    ...firstPartyTeamDefenseProjectionComponents(),
  ]),
].sort();

/** Returns null when current league scoring cannot safely consume a managed forecast. */
export async function currentManagedProjectionProfileKey(
  database: Database,
  leagueSeasonId: string,
): Promise<string | null> {
  const [league] = await database
    .select({ provider: leagueSeasons.provider })
    .from(leagueSeasons)
    .where(eq(leagueSeasons.id, leagueSeasonId))
    .limit(1);
  if (!league) return null;
  const rules = await database
    .select({
      statKey: scoringRules.statKey,
      operation: scoringRules.operation,
      points: scoringRules.points,
      thresholdLow: scoringRules.thresholdLow,
      thresholdHigh: scoringRules.thresholdHigh,
      providerStatId: scoringRules.providerStatId,
    })
    .from(scoringRules)
    .where(eq(scoringRules.leagueSeasonId, leagueSeasonId));
  const normalized = normalizeLeagueScoringProfile({
    id: `league:${leagueSeasonId}`,
    label: "League scoring",
    version: LEAGUE_SCORING_NORMALIZATION_VERSION,
    rows: rules.map((rule) => ({ provider: league.provider, ...rule })),
    availableStatIds: availableComponents,
  });
  return normalized.state === "available" ? projectionScoringProfileKey(normalized.profile) : null;
}
