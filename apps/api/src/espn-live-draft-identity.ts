/**
 * Resolving ESPN's rendered names and IDs onto Laces Out identities.
 *
 * The rule this module exists to enforce is no silent guessing. A wrong pick is worse than a
 * briefly stale board, so every resolution is either an exact, *unique* match or a held mapping
 * issue. There is no fuzzy similarity, no nearest-neighbour, no row-position inference, and no
 * owner-display-name fallback anywhere below.
 */

export interface ProviderTeamCandidate {
  readonly id: string;
  readonly name: string;
  /** ESPN's numeric team ID when the league sync captured one. */
  readonly externalKey: string | null;
}

export interface ProviderPlayerCandidate {
  readonly id: string;
  readonly name: string;
  readonly positions: readonly string[];
  readonly nflTeam: string | null;
}

export type IdentityResolution =
  | { readonly status: "resolved"; readonly id: string; readonly via: string }
  | { readonly status: "unresolved"; readonly reason: "unknown" | "ambiguous" };

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Normalizes a display name for exact comparison: strips diacritics, punctuation, generational
 * suffixes, and case. This is normalization, not fuzzy matching — two names either normalize to
 * the same string or they do not match at all.
 */
export function normalizeIdentityName(value: string): string {
  const folded = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    // Apostrophes are deleted, not spaced: "Ja'Marr" and "JaMarr" are the same player, whereas
    // hyphens and periods separate real name parts ("Amon-Ra St. Brown").
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const parts = folded.split(" ").filter((part) => part.length > 0 && !NAME_SUFFIXES.has(part));
  return parts.join(" ");
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T | null> {
  const index = new Map<string, T | null>();
  for (const value of values) {
    const normalized = key(value);
    if (normalized.length === 0) continue;
    // A second match poisons the key rather than overwriting it: ambiguity must not silently
    // resolve to whichever row happened to come last.
    index.set(normalized, index.has(normalized) ? null : value);
  }
  return index;
}

export class ProviderTeamResolver {
  readonly #byExternalKey: Map<string, ProviderTeamCandidate>;
  readonly #byName: Map<string, ProviderTeamCandidate | null>;

  constructor(candidates: readonly ProviderTeamCandidate[]) {
    this.#byExternalKey = new Map(
      candidates
        .filter((candidate) => candidate.externalKey !== null)
        .map((candidate) => [candidate.externalKey!, candidate]),
    );
    this.#byName = uniqueBy(candidates, (candidate) => normalizeIdentityName(candidate.name));
  }

  resolve(input: {
    readonly providerTeamId: string | null;
    readonly teamName: string;
  }): IdentityResolution {
    if (input.providerTeamId !== null) {
      const byId = this.#byExternalKey.get(input.providerTeamId);
      if (byId) return { status: "resolved", id: byId.id, via: "provider-team-id" };
      // An ID that the league sync does not know is a real mapping gap, not a cue to guess by name.
      if (this.#byExternalKey.size > 0) return { status: "unresolved", reason: "unknown" };
    }
    const normalized = normalizeIdentityName(input.teamName);
    if (!this.#byName.has(normalized)) return { status: "unresolved", reason: "unknown" };
    const byName = this.#byName.get(normalized);
    return byName
      ? { status: "resolved", id: byName.id, via: "unique-team-name" }
      : { status: "unresolved", reason: "ambiguous" };
  }
}

/** ESPN renders team defenses many ways; all of them carry the NFL club, which is the identity. */
function defenseKey(name: string, position: string | null): string | null {
  const normalized = normalizeIdentityName(name);
  const looksLikeDefense =
    (position !== null && ["dst", "d st", "def"].includes(normalizeIdentityName(position))) ||
    /\b(d st|dst|defense|special teams)\b/u.test(normalized);
  if (!looksLikeDefense) return null;
  return normalized
    .replace(/\b(d st|dst|defense|special teams)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export class ProviderPlayerResolver {
  readonly #byProviderId: Map<string, string>;
  readonly #byTriple: Map<string, ProviderPlayerCandidate | null>;
  readonly #byDefense: Map<string, ProviderPlayerCandidate | null>;

  constructor(
    candidates: readonly ProviderPlayerCandidate[],
    /** ESPN provider player ID to internal player ID, from the verified or league-scoped crosswalk. */
    crosswalk: ReadonlyMap<string, string>,
  ) {
    this.#byProviderId = new Map(crosswalk);
    this.#byTriple = uniqueBy(
      candidates,
      (candidate) =>
        `${normalizeIdentityName(candidate.name)}|${candidate.nflTeam?.toLowerCase() ?? ""}|${
          candidate.positions[0]?.toLowerCase() ?? ""
        }`,
    );
    this.#byDefense = uniqueBy(candidates, (candidate) => {
      if (!candidate.positions.some((position) => position.toUpperCase() === "DST")) return "";
      return candidate.nflTeam?.toLowerCase() ?? "";
    });
  }

  resolve(input: {
    readonly providerPlayerId: string | null;
    readonly playerName: string;
    readonly proTeam: string | null;
    readonly position: string | null;
  }): IdentityResolution {
    if (input.providerPlayerId !== null) {
      const mapped = this.#byProviderId.get(input.providerPlayerId);
      if (mapped) return { status: "resolved", id: mapped, via: "provider-player-id" };
    }
    const triple = `${normalizeIdentityName(input.playerName)}|${
      input.proTeam?.toLowerCase() ?? ""
    }|${input.position?.toLowerCase() ?? ""}`;
    if (this.#byTriple.has(triple)) {
      const candidate = this.#byTriple.get(triple);
      if (candidate) return { status: "resolved", id: candidate.id, via: "name-team-position" };
      return { status: "unresolved", reason: "ambiguous" };
    }
    const defense = defenseKey(input.playerName, input.position);
    if (defense !== null && input.proTeam !== null) {
      const byClub = this.#byDefense.get(input.proTeam.toLowerCase());
      if (byClub) return { status: "resolved", id: byClub.id, via: "defense-nfl-team" };
      if (this.#byDefense.has(input.proTeam.toLowerCase())) {
        return { status: "unresolved", reason: "ambiguous" };
      }
    }
    return { status: "unresolved", reason: "unknown" };
  }
}
