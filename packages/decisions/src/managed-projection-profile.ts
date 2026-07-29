import { leagueSeasons, scoringRules, type Database } from "@fantasy/db";
import {
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  firstPartyProjectionComponentsForPosition,
  firstPartyTeamDefenseProjectionComponents,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  type LeagueScoringPositionSupport,
} from "@fantasy/projections";
import { eq } from "drizzle-orm";

const positions = ["QB", "RB", "WR", "TE", "K"] as const;
export const MANAGED_PROJECTION_SCORING_RULE_LIMIT = 257;

const availableComponents = [
  ...new Set([
    ...positions.flatMap((position) => firstPartyProjectionComponentsForPosition(position)),
    "field_goals_made_50_plus",
    ...firstPartyTeamDefenseProjectionComponents(),
  ]),
].sort();

/**
 * The managed (`laces-out-first-party`) weekly projection profile for a league, plus per-position
 * support detail so a caller can explain a `null` key instead of treating it as an opaque failure.
 */
export interface ManagedProjectionProfile {
  /** Null when no position of this league's scoring rules is supported for a managed forecast. */
  readonly key: string | null;
  /**
   * Every position's support, in `normalizeLeagueScoringProfile`'s fixed order. Null only at the
   * bounded-read sentinel, where the rule set was never even normalized.
   */
  readonly positions: readonly LeagueScoringPositionSupport[] | null;
}

/**
 * Reads and normalizes a league's stored scoring rules against the managed forecast's available
 * components, bounded at `MANAGED_PROJECTION_SCORING_RULE_LIMIT`. Both `currentManagedProjectionProfileKey`
 * and `currentManagedProjectionProfile` share this single bounded read so they can never disagree.
 */
export async function currentManagedProjectionProfile(
  database: Database,
  leagueSeasonId: string,
): Promise<ManagedProjectionProfile> {
  const [league] = await database
    .select({ provider: leagueSeasons.provider })
    .from(leagueSeasons)
    .where(eq(leagueSeasons.id, leagueSeasonId))
    .limit(1);
  // No stored season to read rules for. Normalized through the same empty-rules path a real read
  // with zero rows would take, rather than a bespoke null, so `positions` stays non-null here too —
  // "null positions" is reserved for the bounded-read sentinel below, where nothing was normalized.
  if (!league) {
    const empty = normalizeLeagueScoringProfile({
      id: `league:${leagueSeasonId}`,
      label: "League scoring",
      version: LEAGUE_SCORING_NORMALIZATION_VERSION,
      rows: [],
      availableStatIds: availableComponents,
    });
    return { key: null, positions: empty.positions };
  }
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
    .where(eq(scoringRules.leagueSeasonId, leagueSeasonId))
    .limit(MANAGED_PROJECTION_SCORING_RULE_LIMIT);
  // The bound was hit: the rule set was truncated, so it is never normalized as if it were
  // complete. `positions` stays null here specifically so a caller can tell this apart from a rule
  // set that was fully read and simply supports nothing.
  if (rules.length >= MANAGED_PROJECTION_SCORING_RULE_LIMIT) return { key: null, positions: null };
  const normalized = normalizeLeagueScoringProfile({
    id: `league:${leagueSeasonId}`,
    label: "League scoring",
    version: LEAGUE_SCORING_NORMALIZATION_VERSION,
    rows: rules.map((rule) => ({ provider: league.provider, ...rule })),
    availableStatIds: availableComponents,
  });
  return {
    key: normalized.state === "available" ? projectionScoringProfileKey(normalized.profile) : null,
    positions: normalized.positions,
  };
}

/**
 * Thin wrapper over `currentManagedProjectionProfile` retained so existing call sites that only
 * need the compatibility key are untouched. Null covers both "nothing normalizes" and the bounded-
 * read sentinel; callers that need to tell those apart (or see per-position reasons) should call
 * `currentManagedProjectionProfile` directly instead.
 */
export async function currentManagedProjectionProfileKey(
  database: Database,
  leagueSeasonId: string,
): Promise<string | null> {
  return (await currentManagedProjectionProfile(database, leagueSeasonId)).key;
}
