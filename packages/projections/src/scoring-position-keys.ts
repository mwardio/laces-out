import { leagueScoringPositionComponents, type LeagueScoringPosition } from "./league-scoring.js";
import {
  canonicalProjectionScoringRules,
  projectionScoringProfileKey,
  validateProjectionScoringProfile,
  type ProjectionScoringProfile,
  type ProjectionScoringRule,
} from "./scoring.js";

/**
 * Position-scoped scoring identity. Separate from `scoring.ts` because the position vocabularies
 * come from the first-party projection engine, which imports `scoring.ts` itself.
 *
 * `projectionScoringProfileKey` (whole profile) stays the artifact's immutable identity; these keys
 * are the per-position matching gate a partially supported league is compared on.
 */

/** A zero-point rule with no bonuses is scoring-behavior-identical to no rule at all. */
function isScoringNoop(rule: ProjectionScoringRule): boolean {
  return rule.points === 0 && (rule.bonuses ?? []).length === 0;
}

/**
 * The canonical key of the rules that can affect one position's score: the profile's rules
 * restricted to that position's component vocabulary, canonicalized exactly as the whole-profile
 * key is. Rules outside the vocabulary contribute 0 to that position by construction, so byte
 * equality here means byte-identical scoring behavior for the position.
 *
 * Scoring no-ops are dropped so a stored key that carries an explicit zero-point rule still matches
 * a league whose normalization discarded it — the whole-profile key cannot do this, and the gap is
 * pinned as a defect by `apps/api/src/ros-projection-status.pg.test.ts`.
 *
 * A position the profile prices nothing for yields `"[]"`, which every such profile produces. A
 * matching gate must therefore also require the league to report that position as supported, and
 * must never read `"[]" === "[]"` as a match on its own.
 */
export function projectionScoringProfileKeyForPosition(
  profile: ProjectionScoringProfile,
  position: LeagueScoringPosition,
): string {
  validateProjectionScoringProfile(profile);
  const vocabulary = leagueScoringPositionComponents(position);
  const scoped = profile.rules.filter(
    (rule) => vocabulary.has(rule.statId) && !isScoringNoop(rule),
  );
  return JSON.stringify(canonicalProjectionScoringRules(scoped));
}

function invalidKey(key: string): never {
  throw new TypeError(
    `Value is not a canonical scoring profile key: ${key.slice(0, 120)}${key.length > 120 ? "…" : ""}`,
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Recovers a rule list from a stored whole-profile key. The key IS the canonical JSON, so an
 * admitted artifact's position keys can be derived from what is already persisted, with no schema
 * change.
 *
 * The recovered rules must re-serialize to the exact input string, so nothing can be lost in the
 * round trip: a malformed key, a non-canonical one (unsorted, `-0`, unnormalized bonuses), or one
 * carrying a field this code does not know about all refuse. That last case is the load-bearing
 * one — if `ProjectionScoringRule` ever gains a field, every stored key would silently shed it here
 * and a league that does not price it would produce a byte-equal, falsely matching position key.
 */
export function projectionScoringRulesFromProfileKey(
  key: string,
): readonly ProjectionScoringRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    invalidKey(key);
  }
  if (!Array.isArray(parsed)) invalidKey(key);

  const rules = parsed.map((entry): ProjectionScoringRule => {
    if (typeof entry !== "object" || entry === null) invalidKey(key);
    const candidate = entry as Record<string, unknown>;
    const { statId, points, bonuses } = candidate;
    if (typeof statId !== "string" || statId.trim() === "") invalidKey(key);
    if (!finiteNumber(points)) invalidKey(key);
    if (bonuses !== undefined && !Array.isArray(bonuses)) invalidKey(key);
    const parsedBonuses = (bonuses ?? []).map((bonus: unknown) => {
      if (typeof bonus !== "object" || bonus === null) invalidKey(key);
      const { atLeast, points: bonusPoints } = bonus as Record<string, unknown>;
      if (!finiteNumber(atLeast) || !finiteNumber(bonusPoints)) invalidKey(key);
      return { atLeast, points: bonusPoints };
    });
    return parsedBonuses.length === 0
      ? { statId, points }
      : { statId, points, bonuses: parsedBonuses };
  });

  // Validates (empty list, duplicate statId, non-finite points) and proves the round trip is lossless.
  if (projectionScoringProfileKey({ id: "recovered-scoring-profile", rules }) !== key) {
    invalidKey(key);
  }
  return rules;
}
