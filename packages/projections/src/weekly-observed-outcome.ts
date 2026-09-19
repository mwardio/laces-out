import {
  firstPartyProjectionComponentsForPosition,
  firstPartyTeamDefenseProjectionComponents,
  firstPartyTeamDefenseRealizedAllowedBuckets,
} from "./first-party.js";
import {
  normalizeHistoricalPlayerStatComponents,
  projectionScoringProfileKey,
  scoreProjectionStatComponents,
  SCORING_LONG_TOUCHDOWN_COMPONENTS,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "./scoring.js";

export const WEEKLY_OBSERVED_SCORING_VERSION = "complete-realized-weekly-components-v1";
const defenseComponents = new Set(firstPartyTeamDefenseProjectionComponents());
const playerComponents = new Set([
  ...["QB", "RB", "WR", "TE", "K"].flatMap(firstPartyProjectionComponentsForPosition),
  "field_goals_made_50_plus",
  "field_goals_missed_50_plus",
  "field_goals_missed_0_39",
]);

export type WeeklyObservedScoringResult = {
  readonly version: typeof WEEKLY_OBSERVED_SCORING_VERSION;
  readonly scoringProfileKey: string;
  readonly requiredComponents: readonly string[];
  readonly inapplicableComponents: readonly string[];
  readonly missingComponents: readonly string[];
  readonly invalidComponents: readonly string[];
  readonly conflictingComponents: readonly string[];
} & (
  | {
      readonly state: "scored";
      readonly points: number;
      readonly components: ProjectionStatComponents;
    }
  | { readonly state: "unavailable"; readonly points: null }
);

/**
 * Scores realized components only after completeness is established. This does not establish
 * game finality, source authenticity or participation; the weekly evaluator must establish those
 * independently. Missing source rows cannot enter this function as manufactured zero records.
 * Entity scope excludes team-defense rules from individuals and player-only rules from defenses;
 * it never excludes a player for an unknown published fantasy role.
 */
export function scoreObservedWeeklyComponents(input: {
  readonly kind: "player" | "team-defense";
  readonly profile: ProjectionScoringProfile;
  readonly components: ProjectionStatComponents;
}): WeeklyObservedScoringResult {
  if (input.kind !== "player" && input.kind !== "team-defense")
    throw new TypeError("Unknown weekly observed entity kind");
  if (input.profile.rules.length > 1024) throw new RangeError("Weekly scoring rules exceed bound");
  const scoringProfileKey = projectionScoringProfileKey(input.profile);
  const raw = input.components;
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null) ||
    Object.keys(raw).length > 1024
  )
    throw new TypeError("Weekly observed components must be a bounded plain record");
  const invalid = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]{0,127}$/u.test(key) || !Number.isFinite(value)) invalid.add(key);
    if (key.endsWith("_probability") && value !== 0 && value !== 1) invalid.add(key);
  }
  const validRaw = Object.fromEntries(Object.entries(raw).filter(([key]) => !invalid.has(key)));
  const normalized =
    input.kind === "player"
      ? { ...normalizeHistoricalPlayerStatComponents(validRaw) }
      : { ...validRaw };
  const conflicts = new Set<string>();
  for (const [key, value] of Object.entries(validRaw)) {
    if (!Object.hasOwn(normalized, key) || normalized[key] === value) continue;
    const canonicalMisses = normalized[key]!;
    // PAT's persisted raw pat_missed excludes blocks. The observed attempt/make difference
    // supplies the canonical total. Older FG records have the same documented distinction;
    // modern FG records explicitly preserve *_missed_unblocked and already canonicalize misses.
    const documentedKickTransform =
      Number.isSafeInteger(value) &&
      value >= 0 &&
      Number.isSafeInteger(canonicalMisses) &&
      canonicalMisses >= value &&
      (key === "extra_points_missed" ||
        (key === "field_goals_missed" &&
          !Object.hasOwn(validRaw, "field_goals_missed_unblocked") &&
          Number.isSafeInteger(validRaw.field_goals_blocked) &&
          validRaw.field_goals_blocked! >= 0 &&
          value + validRaw.field_goals_blocked! === canonicalMisses));
    if (!documentedKickTransform) conflicts.add(key);
  }
  if (input.kind === "player") {
    for (const prefix of ["field_goals", "extra_points"] as const) {
      const attempted = validRaw[`${prefix}_attempted`],
        made = validRaw[`${prefix}_made`];
      if (attempted !== undefined && (!Number.isSafeInteger(attempted) || attempted < 0))
        invalid.add(`${prefix}_attempted`);
      if (made !== undefined && (!Number.isSafeInteger(made) || made < 0))
        invalid.add(`${prefix}_made`);
      if (attempted !== undefined && made !== undefined && made > attempted)
        conflicts.add(`${prefix}_made`);
    }
    // A raw PAT miss total alone cannot rule out blocked attempts; unlike modern FG rows, the
    // current source adapter does not carry a canonical PAT-miss field separately.
    if (
      Object.hasOwn(normalized, "extra_points_missed") &&
      (!Object.hasOwn(validRaw, "extra_points_attempted") ||
        !Object.hasOwn(validRaw, "extra_points_made"))
    )
      delete normalized.extra_points_missed;
  }
  if (input.kind === "player") {
    for (const group of SCORING_LONG_TOUCHDOWN_COMPONENTS) {
      if (normalized[group.total] === 0) {
        if (!Object.hasOwn(normalized, group.fortyPlus)) normalized[group.fortyPlus] = 0;
        if (!Object.hasOwn(normalized, group.fiftyPlus)) normalized[group.fiftyPlus] = 0;
      }
      if (normalized[group.fortyPlus] === 0 && !Object.hasOwn(normalized, group.fiftyPlus))
        normalized[group.fiftyPlus] = 0;
      const total = normalized[group.total],
        forty = normalized[group.fortyPlus],
        fifty = normalized[group.fiftyPlus];
      for (const [key, count] of [
        [group.total, total],
        [group.fortyPlus, forty],
        [group.fiftyPlus, fifty],
      ] as const)
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) invalid.add(key);
      if (total !== undefined && forty !== undefined && forty > total)
        conflicts.add(group.fortyPlus);
      if (forty !== undefined && fifty !== undefined && fifty > forty)
        conflicts.add(group.fiftyPlus);
      if (total !== undefined && fifty !== undefined && fifty > total)
        conflicts.add(group.fiftyPlus);
    }
  } else {
    // Derive only the requested family's indicators from its observed total. The other family's
    // placeholder is never exposed as evidence or used for scoring a missing observed total.
    for (const family of ["points_allowed", "yards_allowed"] as const) {
      const value = normalized[family];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) {
        invalid.add(family);
        continue;
      }
      const buckets = firstPartyTeamDefenseRealizedAllowedBuckets({
        pointsAllowed: family === "points_allowed" ? value : 0,
        yardsAllowed: family === "yards_allowed" ? value : 0,
      });
      for (const [key, derived] of Object.entries(buckets)) {
        if (!key.startsWith(`${family}_`)) continue;
        if (Object.hasOwn(normalized, key) && normalized[key] !== derived) conflicts.add(key);
        normalized[key] = derived;
      }
    }
  }
  const required: string[] = [],
    inapplicable: string[] = [];
  const rules = input.profile.rules.filter((rule) => {
    if (rule.points === 0 && !(rule.bonuses ?? []).some((bonus) => bonus.points !== 0))
      return false;
    const wrongEntity =
      input.kind === "player"
        ? defenseComponents.has(rule.statId) && !playerComponents.has(rule.statId)
        : playerComponents.has(rule.statId) && !defenseComponents.has(rule.statId);
    if (wrongEntity) {
      inapplicable.push(rule.statId);
      return false;
    }
    required.push(rule.statId);
    return true;
  });
  const missing = required.filter((key) => !Object.hasOwn(normalized, key));
  for (const key of required) {
    const value = normalized[key];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || (key.endsWith("_probability") && value !== 0 && value !== 1))
    )
      invalid.add(key);
  }
  const base = {
    version: WEEKLY_OBSERVED_SCORING_VERSION,
    scoringProfileKey,
    requiredComponents: required.sort(),
    inapplicableComponents: inapplicable.sort(),
    missingComponents: missing.sort(),
    invalidComponents: [...invalid].sort(),
    conflictingComponents: [...conflicts].sort(),
  } as const;
  if (missing.length || invalid.size || conflicts.size)
    return { ...base, state: "unavailable", points: null };
  const components = Object.fromEntries(required.map((key) => [key, normalized[key]!]));
  // A profile with no rules applicable to this entity has an explicit structural zero. The
  // evaluator still requires a real observed record and final game; this does not synthesize DNP.
  const points =
    rules.length === 0 ? 0 : scoreProjectionStatComponents(components, { ...input.profile, rules });
  if (!Number.isFinite(points))
    return {
      ...base,
      state: "unavailable",
      points: null,
      invalidComponents: [...base.invalidComponents, "scored-total-overflow"],
    };
  return { ...base, state: "scored", points, components };
}
