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

function finiteNonnegativeComponent(components: ProjectionStatComponents, key: string): number {
  const value = components[key];
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Adds the canonical aggregate component names used by league scoring to an nflverse player row.
 * The source's original fields remain intact so callers can audit every derived total.
 */
export function normalizeHistoricalPlayerStatComponents(
  components: ProjectionStatComponents,
): ProjectionStatComponents {
  return {
    ...components,
    fumbles_lost: finiteNonnegativeComponent(components, "fumbles_lost_total"),
    turnovers:
      finiteNonnegativeComponent(components, "passing_interceptions") +
      finiteNonnegativeComponent(components, "fumbles_lost_total"),
    two_point_conversions:
      finiteNonnegativeComponent(components, "passing_two_point_conversions") +
      finiteNonnegativeComponent(components, "rushing_two_point_conversions") +
      finiteNonnegativeComponent(components, "receiving_two_point_conversions"),
    field_goals_made_0_39:
      finiteNonnegativeComponent(components, "field_goals_made_0_19") +
      finiteNonnegativeComponent(components, "field_goals_made_20_29") +
      finiteNonnegativeComponent(components, "field_goals_made_30_39"),
    field_goals_made_50_plus:
      finiteNonnegativeComponent(components, "field_goals_made_50_59") +
      finiteNonnegativeComponent(components, "field_goals_made_60_plus"),
    return_yards:
      finiteNonnegativeComponent(components, "punt_return_yards") +
      finiteNonnegativeComponent(components, "kickoff_return_yards"),
    return_touchdowns: finiteNonnegativeComponent(components, "special_teams_touchdowns"),
  };
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

/** Scores a projected stat line under a league's explicit scoring rules. */
export function scoreProjectionStatComponents(
  components: ProjectionStatComponents,
  profile: ProjectionScoringProfile,
): number {
  validateProjectionScoringProfile(profile);

  for (const [statId, value] of Object.entries(components)) {
    assertNonEmpty(statId, "projection component statId");
    assertFinite(value, `projection component ${statId}`);
  }

  let total = 0;
  for (const rule of normalizedScoringRules(profile)) {
    const value = components[rule.statId] ?? 0;
    total += value * rule.points;
    for (const bonus of rule.bonuses ?? []) {
      if (value >= bonus.atLeast) total += bonus.points;
    }
  }

  return normalizedNumber(total);
}
