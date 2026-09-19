/** Include in publication input identity when these name-matching rules affect row selection. */
export const PLAYER_NAME_IDENTITY_POLICY_VERSION = "player-name-identity-v1" as const;

export type PlayerNameSuffix = "jr" | "sr" | "ii" | "iii" | "iv" | "v";

export interface PlayerNameIdentityParts {
  readonly exact: string;
  readonly base: string;
  readonly suffix: PlayerNameSuffix | null;
}

/**
 * Preserve the existing exact comparison and separately describe one terminal generational
 * suffix. No initials, punctuation, diacritics, interior whitespace, or middle words are erased.
 * The suffix must be separated by spaces; NFKC normalizes compatibility spaces first.
 */
export function playerNameIdentityParts(value: string): PlayerNameIdentityParts {
  const exact = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const match = / +(jr|sr|ii|iii|iv|v)\.?$/u.exec(exact);
  if (!match) return { exact, base: exact, suffix: null };
  return {
    exact,
    base: exact.slice(0, match.index),
    suffix: match[1] as PlayerNameSuffix,
  };
}

/**
 * A spelling compatibility check, not an identity resolver. Before using a suffix fallback,
 * the caller must establish one unique base-name/team/role candidate with trusted identity,
 * reject conflicting explicit IDs, and enforce a one-to-one roster mapping. An ambiguous exact
 * cohort must never be retried as a suffix match or pruned into apparent uniqueness.
 */
export function playerNameIdentitiesCompatible(
  left: PlayerNameIdentityParts,
  right: PlayerNameIdentityParts,
): boolean {
  if (!left.exact || !right.exact || !left.base || !right.base) return false;
  if (left.exact === right.exact) return true;
  return (
    left.base === right.base &&
    (left.suffix === null || right.suffix === null || left.suffix === right.suffix)
  );
}
