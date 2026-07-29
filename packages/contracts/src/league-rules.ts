import { z } from "zod";

/**
 * The typed reader for the whole-blob `league_seasons.settings` jsonb column, which stores a
 * provider-normalized `NormalizedLeagueSettings` verbatim. Every consumer of league rules should
 * come through here rather than reaching into the blob, so that "the provider never told us" is a
 * first-class answer instead of a plausible-looking default.
 */
export interface LeagueRules {
  readonly teamCount: number;
  readonly playoffTeamCount: number | null;
  readonly regularSeasonMatchupPeriods: number | null;
  readonly playoffMatchupPeriodLength: number | null;
  readonly medianGameEnabled: boolean | null;
  readonly keeperCount: number | null;
  readonly tradeDeadlineAt: string | null;
  readonly divisions: readonly { readonly providerDivisionId: string; readonly name: string }[];
  /** Fields the provider did not supply, for honest UI and provenance. */
  readonly missing: readonly string[];
}

/**
 * The names that can appear in {@link LeagueRules.missing}, listed in the order they are appended.
 * `parseLeagueRules` checks fields in exactly this declaration order and never sorts afterwards, so
 * two structurally equivalent blobs always yield an identical array whatever their key order.
 */
type LeagueRuleField =
  | "teamCount"
  | "playoffTeamCount"
  | "regularSeasonMatchupPeriods"
  | "playoffMatchupPeriodLength"
  | "medianGameEnabled"
  | "keeperCount"
  | "tradeDeadlineAt"
  | "divisions";

/** Any positive count is real (a league mid-setup can have one team); the ceiling guards corruption. */
const teamCountSchema = z.number().int().min(1).max(64);
/** Two is the smallest bracket that can produce a champion; below that a playoff is not a playoff. */
const playoffTeamCountSchema = z.number().int().min(2).max(32);
/** The NFL regular season is 18 weeks, so a fantasy regular season cannot outlast week 17. */
const regularSeasonMatchupPeriodsSchema = z.number().int().min(1).max(17);
const playoffMatchupPeriodLengthSchema = z.number().int().min(1).max(10);
const medianGameEnabledSchema = z.boolean();
/** Zero keepers is a real answer ("keepers are off"), not a missing one. */
const keeperCountSchema = z.number().int().min(0).max(64);
/** Accepts a UTC instant or an explicit offset; a bare local timestamp is not an instant. */
const tradeDeadlineAtSchema = z.iso.datetime({ offset: true });
const divisionSchema = z.object({
  providerDivisionId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(200),
});

/**
 * Parses stored league settings into typed rules. This function never throws: any input at all,
 * including `null`, a primitive, or a deeply malformed object, yields a `LeagueRules` whose
 * unreadable fields are `null` and named in `missing`. No field is ever defaulted to a plausible
 * value — an unknown `playoffTeamCount` stays `null` so callers withhold playoff odds instead of
 * assuming six.
 */
export function parseLeagueRules(settings: unknown): LeagueRules {
  const root = asRecord(settings);
  const operationalRules = asRecord(readField(root, "operationalRules"));
  const missing: LeagueRuleField[] = [];

  const teamCount = validated(teamCountSchema, readField(root, "teamCount"));
  if (teamCount === null) {
    missing.push("teamCount");
  }

  const playoffTeamCount = validated(playoffTeamCountSchema, readField(root, "playoffTeamCount"));
  if (playoffTeamCount === null) {
    missing.push("playoffTeamCount");
  }

  const regularSeasonMatchupPeriods = validated(
    regularSeasonMatchupPeriodsSchema,
    readField(operationalRules, "regularSeasonMatchupPeriods"),
  );
  if (regularSeasonMatchupPeriods === null) {
    missing.push("regularSeasonMatchupPeriods");
  }

  const playoffMatchupPeriodLength = validated(
    playoffMatchupPeriodLengthSchema,
    readField(operationalRules, "playoffMatchupPeriodLength"),
  );
  if (playoffMatchupPeriodLength === null) {
    missing.push("playoffMatchupPeriodLength");
  }

  const medianGameEnabled = validated(
    medianGameEnabledSchema,
    readField(operationalRules, "medianGameEnabled"),
  );
  if (medianGameEnabled === null) {
    missing.push("medianGameEnabled");
  }

  const keeperCount = validated(keeperCountSchema, readField(operationalRules, "keeperCount"));
  if (keeperCount === null) {
    missing.push("keeperCount");
  }

  const tradeDeadlineAt = validated(
    tradeDeadlineAtSchema,
    readField(operationalRules, "tradeDeadlineAt"),
  );
  if (tradeDeadlineAt === null) {
    missing.push("tradeDeadlineAt");
  }

  const divisions = parseDivisions(readField(operationalRules, "divisions"));
  if (divisions === null) {
    missing.push("divisions");
  }

  return {
    // The one non-nullable field: an unreadable team count clamps to 0 and is still reported as
    // missing, so a caller can distinguish "no league" from "we were not told".
    teamCount: teamCount ?? 0,
    playoffTeamCount,
    regularSeasonMatchupPeriods,
    playoffMatchupPeriodLength,
    medianGameEnabled,
    keeperCount,
    tradeDeadlineAt,
    divisions: divisions ?? [],
    missing,
  };
}

/**
 * Returns the usable divisions, or `null` when the field is unreadable. An empty array from the
 * provider means "this league has no divisions" and is kept as a real answer, but an array whose
 * every entry is malformed is a supply failure and reports as missing. Partial entries are dropped
 * rather than emitted with a placeholder id or name.
 */
function parseDivisions(value: unknown): readonly LeagueRules["divisions"][number][] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const divisions: LeagueRules["divisions"][number][] = [];
  for (const entry of value) {
    const division = validated(divisionSchema, entry);
    if (division !== null) {
      divisions.push({ providerDivisionId: division.providerDivisionId, name: division.name });
    }
  }

  return divisions.length === 0 && value.length > 0 ? null : divisions;
}

function validated<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Property access is guarded because a stored blob can be rehydrated into an object with getters. */
function readField(source: Record<string, unknown> | null, key: string): unknown {
  if (source === null) {
    return undefined;
  }

  try {
    return source[key];
  } catch {
    return undefined;
  }
}
