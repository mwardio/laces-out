export interface ProjectionScoringBonus {
  /** The bonus is awarded once when the projected component meets this threshold. */
  readonly atLeast: number;
  readonly points: number;
}

export interface ProjectionScoringRule {
  /** Provider-neutral stat identifier, such as `passing_yards` or `receptions`. */
  readonly statId: string;
  /** Points awarded per projected unit. Negative values model turnovers and similar penalties. */
  readonly points: number;
  /** Bonuses are cumulative, allowing an additional award at each reached threshold. */
  readonly bonuses?: readonly ProjectionScoringBonus[];
}

export interface ProjectionScoringProfile {
  /** Stable caller-owned identity retained for provenance, but not used for semantic compatibility. */
  readonly id: string;
  readonly label?: string;
  readonly version?: string;
  readonly rules: readonly ProjectionScoringRule[];
}

export type ProjectionStatComponents = Readonly<Record<string, number>>;

/** Nested per-game touchdown counts: a 50+ yard touchdown also earns the 40+ yard bonus. */
export const SCORING_LONG_TOUCHDOWN_COMPONENTS = [
  {
    total: "passing_touchdowns",
    fortyPlus: "passing_touchdowns_40_plus",
    fiftyPlus: "passing_touchdowns_50_plus",
  },
  {
    total: "rushing_touchdowns",
    fortyPlus: "rushing_touchdowns_40_plus",
    fiftyPlus: "rushing_touchdowns_50_plus",
  },
  {
    total: "receiving_touchdowns",
    fortyPlus: "receiving_touchdowns_40_plus",
    fiftyPlus: "receiving_touchdowns_50_plus",
  },
] as const;

/** Yardage can be negative in official per-game stat lines; counts and probabilities cannot. */
export const SCORING_SIGNED_YARDAGE_COMPONENTS = [
  "passing_yards",
  "rushing_yards",
  "receiving_yards",
  "punt_return_yards",
  "kickoff_return_yards",
  "return_yards",
] as const;

/** Yahoo's negative-points toggle acts on a realized game total, before taking expectations. */
export const YAHOO_NONNEGATIVE_YARDAGE_COMPONENTS = [...SCORING_SIGNED_YARDAGE_COMPONENTS].map(
  (source) => ({ component: `${source}_nonnegative`, source }),
);

/**
 * ESPN's "every N" categories score whole groups rather than a fractional share of the raw stat.
 * Each component below is therefore the realized `floor(max(0, stat) / divisor)` count in historical
 * data. The projection model learns the expected count directly; callers must never approximate
 * it by flooring a projected mean.
 */
export const ESPN_EVERY_N_FLOOR_UNIT_COMPONENTS = [
  ...[5, 10, 20, 25, 50, 100].map((divisor) => ({
    component: `passing_yards_per_${divisor}_units`,
    source: "passing_yards",
    divisor,
  })),
  ...[5, 10].map((divisor) => ({
    component: `passing_completions_per_${divisor}_units`,
    source: "passing_completions",
    divisor,
  })),
  ...[5, 10].map((divisor) => ({
    component: `passing_incompletions_per_${divisor}_units`,
    source: "passing_incompletions",
    divisor,
  })),
  ...[5, 10, 20, 25, 50, 100].map((divisor) => ({
    component: `rushing_yards_per_${divisor}_units`,
    source: "rushing_yards",
    divisor,
  })),
  ...[5, 10].map((divisor) => ({
    component: `carries_per_${divisor}_units`,
    source: "carries",
    divisor,
  })),
  ...[5, 10, 20, 25, 50, 100].map((divisor) => ({
    component: `receiving_yards_per_${divisor}_units`,
    source: "receiving_yards",
    divisor,
  })),
  ...[5, 10].map((divisor) => ({
    component: `receptions_per_${divisor}_units`,
    source: "receptions",
    divisor,
  })),
  ...[10, 25].map((divisor) => ({
    component: `kickoff_return_yards_per_${divisor}_units`,
    source: "kickoff_return_yards",
    divisor,
  })),
  ...[10, 25].map((divisor) => ({
    component: `punt_return_yards_per_${divisor}_units`,
    source: "punt_return_yards",
    divisor,
  })),
] as const;

export type EspnEveryNFloorUnitComponent = (typeof ESPN_EVERY_N_FLOOR_UNIT_COMPONENTS)[number];

export const SCORING_WHOLE_GROUP_COMPONENTS = [
  ...ESPN_EVERY_N_FLOOR_UNIT_COMPONENTS,
  ...[
    "return_yards",
    "field_goals_total_yards",
    ...YAHOO_NONNEGATIVE_YARDAGE_COMPONENTS.map(({ component }) => component),
  ].flatMap((source) =>
    [5, 10, 20, 25, 50, 100].map((divisor) => ({
      component: `${source}_per_${divisor}_units`,
      source,
      divisor,
    })),
  ),
] as const;

/** Positive-part expectation required by E[floor(max(0, X) / N)] <= E[max(0, X)] / N. */
export function scoringWholeGroupSourceExpectation(
  components: ProjectionStatComponents,
  source: string,
): number | undefined {
  if (source === "passing_incompletions") {
    const attempts = components.passing_attempts;
    const completions = components.passing_completions;
    return attempts === undefined ||
      completions === undefined ||
      !Number.isFinite(attempts) ||
      !Number.isFinite(completions) ||
      attempts < 0 ||
      completions < 0
      ? undefined
      : Math.max(0, attempts - completions);
  }
  const key = (SCORING_SIGNED_YARDAGE_COMPONENTS as readonly string[]).includes(source)
    ? `${source}_nonnegative`
    : source;
  const value = components[key];
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const ESPN_EVERY_N_FLOOR_UNIT_COMPONENT_BY_NAME = new Map(
  SCORING_WHOLE_GROUP_COMPONENTS.map((definition) => [definition.component, definition]),
);

function rawYardageValue(components: ProjectionStatComponents, source: string): number | undefined {
  if (source === "return_yards" && components.return_yards === undefined) {
    const punt = components.punt_return_yards;
    const kickoff = components.kickoff_return_yards;
    if (punt === undefined || kickoff === undefined) return undefined;
    if (!Number.isFinite(punt) || !Number.isFinite(kickoff)) return undefined;
    return punt + kickoff;
  }
  const value = components[source];
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** Exact transforms of actual observations, reusable before fitting or scoring realized scenarios. */
export function scoringDerivedComponentValue(
  components: ProjectionStatComponents,
  component: string,
): number | undefined {
  const nonnegative = YAHOO_NONNEGATIVE_YARDAGE_COMPONENTS.find(
    (item) => item.component === component,
  );
  if (nonnegative) {
    const value = rawYardageValue(components, nonnegative.source);
    return value === undefined ? undefined : Math.max(0, value);
  }
  return espnEveryNFloorUnitValue(components, component);
}

function rawEveryNSourceValue(
  components: ProjectionStatComponents,
  source: string,
): number | undefined {
  if (source === "passing_incompletions") {
    const attempts = components.passing_attempts;
    const completions = components.passing_completions;
    if (
      attempts === undefined ||
      completions === undefined ||
      !Number.isFinite(attempts) ||
      !Number.isFinite(completions) ||
      attempts < 0 ||
      completions < 0
    ) {
      return undefined;
    }
    return Math.max(0, attempts - completions);
  }
  const nonnegative = YAHOO_NONNEGATIVE_YARDAGE_COMPONENTS.find(
    (item) => item.component === source,
  );
  if (nonnegative) {
    const value = rawYardageValue(components, nonnegative.source);
    return value === undefined ? undefined : Math.max(0, value);
  }
  const value = rawYardageValue(components, source);
  if (value === undefined) return undefined;
  // ESPN's realized every-N categories omit negative yardage groups (provider zero), while
  // signed per-yard categories retain the loss. See the pinned official API evidence fixture.
  if ((SCORING_SIGNED_YARDAGE_COMPONENTS as readonly string[]).includes(source))
    return Math.max(0, value);
  return value >= 0 ? value : undefined;
}

/** Returns an exact historical whole-group count for one supported ESPN every-N component. */
export function espnEveryNFloorUnitValue(
  components: ProjectionStatComponents,
  component: string,
): number | undefined {
  const definition = ESPN_EVERY_N_FLOOR_UNIT_COMPONENT_BY_NAME.get(component);
  if (definition === undefined) return undefined;
  const source = rawEveryNSourceValue(components, definition.source);
  return source === undefined ? undefined : Math.floor(source / definition.divisor);
}

/**
 * Adds the canonical aggregate component names used by league scoring to an nflverse player row.
 * Source fields remain available except where a canonical category has a different definition:
 * missed kicks include blocks for both ESPN and Yahoo (nflverse's original miss counts exclude
 * them). Fine field-goal buckets must already include the source's exact blocked-kick distances.
 */
export function normalizeHistoricalPlayerStatComponents(
  components: ProjectionStatComponents,
): ProjectionStatComponents {
  // Absence is not evidence of a zero game. Callers with an observed zero-production appearance
  // supply explicit zeros; canonical-only rows retain values whose raw sources are not present.
  const canonical: Record<string, number> = { ...components };
  const finite = (key: string): number | undefined => {
    const value = canonical[key];
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const aggregate = (key: string, sources: readonly string[], signed = false): void => {
    const values = sources.map(finite);
    if (values.every((value): value is number => value !== undefined && (signed || value >= 0)))
      canonical[key] = values.reduce((sum, value) => sum + value, 0);
  };
  aggregate("fumbles_lost", ["fumbles_lost_total"]);
  aggregate("turnovers", ["passing_interceptions", "fumbles_lost"]);
  aggregate("two_point_conversions", [
    "passing_two_point_conversions",
    "rushing_two_point_conversions",
    "receiving_two_point_conversions",
  ]);
  aggregate("field_goals_made_0_39", [
    "field_goals_made_0_19",
    "field_goals_made_20_29",
    "field_goals_made_30_39",
  ]);
  aggregate("field_goals_made_50_plus", ["field_goals_made_50_59", "field_goals_made_60_plus"]);
  aggregate("field_goals_missed_0_39", [
    "field_goals_missed_0_19",
    "field_goals_missed_20_29",
    "field_goals_missed_30_39",
  ]);
  aggregate("field_goals_missed_50_plus", [
    "field_goals_missed_50_59",
    "field_goals_missed_60_plus",
  ]);
  aggregate("return_yards", ["punt_return_yards", "kickoff_return_yards"], true);
  aggregate("return_touchdowns", ["special_teams_touchdowns"]);
  for (const prefix of ["extra_points", "field_goals"]) {
    const attempts = finite(`${prefix}_attempted`);
    const makes = finite(`${prefix}_made`);
    if (attempts !== undefined && makes !== undefined && makes >= 0 && attempts >= makes)
      canonical[`${prefix}_missed`] = attempts - makes;
  }
  for (const { component } of SCORING_WHOLE_GROUP_COMPONENTS) {
    const value = espnEveryNFloorUnitValue(canonical, component);
    if (value !== undefined) canonical[component] = value;
  }
  for (const { component } of YAHOO_NONNEGATIVE_YARDAGE_COMPONENTS) {
    const value = scoringDerivedComponentValue(canonical, component);
    if (value !== undefined) canonical[component] = value;
  }
  // Exact realized events become learned probabilities. Never threshold an expected mean here.
  for (const [source, lower, upper] of [
    ["passing_yards", 300, 400],
    ["rushing_yards", 100, 200],
    ["receiving_yards", 100, 200],
  ] as const) {
    const raw = finite(source);
    if (raw === undefined) continue;
    canonical[`${source}_${lower}_${upper - 1}_probability`] = Number(raw >= lower && raw < upper);
    canonical[`${source}_${upper}_plus_probability`] = Number(raw >= upper);
  }
  return canonical;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function normalizedNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface CanonicalProjectionScoringRule {
  readonly statId: string;
  readonly points: number;
  readonly bonuses: readonly ProjectionScoringBonus[];
}

/**
 * The canonical rule shape every scoring key is built from: `-0` normalized, bonuses sorted by
 * threshold then points, rules sorted by `statId`. Exported so position-scoped keys canonicalize a
 * subset of the same rules byte-identically to the whole-profile key.
 */
export function canonicalProjectionScoringRules(
  rules: readonly ProjectionScoringRule[],
): readonly CanonicalProjectionScoringRule[] {
  return [...rules]
    .map((rule) => ({
      statId: rule.statId,
      points: normalizedNumber(rule.points),
      bonuses: [...(rule.bonuses ?? [])]
        .map((bonus) => ({
          atLeast: normalizedNumber(bonus.atLeast),
          points: normalizedNumber(bonus.points),
        }))
        .sort((left, right) => left.atLeast - right.atLeast || left.points - right.points),
    }))
    .sort((left, right) => compareStrings(left.statId, right.statId));
}

function normalizedScoringRules(
  profile: ProjectionScoringProfile,
): readonly CanonicalProjectionScoringRule[] {
  return canonicalProjectionScoringRules(profile.rules);
}

export function validateProjectionScoringProfile(profile: ProjectionScoringProfile): void {
  assertNonEmpty(profile.id, "scoring profile id");
  if (profile.version !== undefined) assertNonEmpty(profile.version, "scoring profile version");
  if (profile.rules.length === 0) {
    throw new RangeError("A scoring profile requires at least one rule");
  }

  const statIds = new Set<string>();
  for (const rule of profile.rules) {
    assertNonEmpty(rule.statId, "scoring rule statId");
    if (statIds.has(rule.statId)) {
      throw new Error(`Scoring profile contains duplicate statId: ${rule.statId}`);
    }
    statIds.add(rule.statId);
    assertFinite(rule.points, `points for ${rule.statId}`);

    const thresholds = new Set<number>();
    for (const bonus of rule.bonuses ?? []) {
      assertFinite(bonus.atLeast, `bonus threshold for ${rule.statId}`);
      assertFinite(bonus.points, `bonus points for ${rule.statId}`);
      if (thresholds.has(bonus.atLeast)) {
        throw new Error(
          `Scoring rule ${rule.statId} contains duplicate bonus threshold: ${bonus.atLeast}`,
        );
      }
      thresholds.add(bonus.atLeast);
    }
  }
}

/**
 * Returns a canonical semantic key. Labels, caller IDs, versions, and source rule order do not
 * affect compatibility; only the scoring behavior does.
 */
export function projectionScoringProfileKey(profile: ProjectionScoringProfile): string {
  validateProjectionScoringProfile(profile);
  return JSON.stringify(normalizedScoringRules(profile));
}

export function projectionScoringProfilesAreCompatible(
  left: ProjectionScoringProfile,
  right: ProjectionScoringProfile,
): boolean {
  return projectionScoringProfileKey(left) === projectionScoringProfileKey(right);
}

function scoreCanonicalProjectionComponents(
  components: ProjectionStatComponents,
  rules: readonly CanonicalProjectionScoringRule[],
): number {
  for (const statId of Object.keys(components)) {
    assertNonEmpty(statId, "projection component statId");
    assertFinite(components[statId]!, `projection component ${statId}`);
  }

  let total = 0;
  for (const rule of rules) {
    const value = components[rule.statId] ?? 0;
    total += value * rule.points;
    for (const bonus of rule.bonuses ?? []) {
      if (value >= bonus.atLeast) total += bonus.points;
    }
  }

  return normalizedNumber(total);
}

/**
 * Pins a validated scoring profile for repeated stat lines. The private canonical rule snapshot
 * preserves the ordinary scorer's exact addition order and cannot change if the caller later
 * edits its profile. Component names and finite values are still checked on every invocation.
 */
export function compileProjectionScorer(
  profile: ProjectionScoringProfile,
): (components: ProjectionStatComponents) => number {
  validateProjectionScoringProfile(profile);
  const rules = normalizedScoringRules(profile);
  return (components) => scoreCanonicalProjectionComponents(components, rules);
}

/** Scores a projected stat line under a league's explicit scoring rules. */
export function scoreProjectionStatComponents(
  components: ProjectionStatComponents,
  profile: ProjectionScoringProfile,
): number {
  return compileProjectionScorer(profile)(components);
}

/**
 * Completeness of an observed stat line, before the projection scorer's missing-as-zero fallback.
 * The caller supplies the entity's vocabulary: player rules must not make a D/ST row incomplete.
 * Presence is an observation requirement, not a request to manufacture zeros or drop games.
 */
export function observedScoringComponentIssues(input: {
  readonly components: ProjectionStatComponents;
  readonly profile: ProjectionScoringProfile;
  readonly applicableStatIds: readonly string[];
}): {
  readonly missingComponents: readonly string[];
  readonly invalidComponents: readonly string[];
} {
  validateProjectionScoringProfile(input.profile);
  const applicable = new Set(input.applicableStatIds);
  const missingComponents: string[] = [];
  const invalidComponents: string[] = [];
  for (const rule of input.profile.rules) {
    if (
      !applicable.has(rule.statId) ||
      (rule.points === 0 && !(rule.bonuses ?? []).some((bonus) => bonus.points !== 0))
    )
      continue;
    if (!Object.hasOwn(input.components, rule.statId)) {
      missingComponents.push(rule.statId);
      continue;
    }
    const value = input.components[rule.statId]!;
    const rareDefenseCount =
      rule.statId === "defensive_two_point_returns" || rule.statId === "one_point_safeties";
    if (
      !Number.isFinite(value) ||
      (rareDefenseCount && (!Number.isSafeInteger(value) || value < 0))
    )
      invalidComponents.push(rule.statId);
  }
  return {
    missingComponents: missingComponents.sort(),
    invalidComponents: invalidComponents.sort(),
  };
}
