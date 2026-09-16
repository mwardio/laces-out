import { NFL_TEAMS, canonicalNflTeamCode } from "@laces-out/domain";

import type { DecisionProjectionPlayerRow } from "./in-season-decisions.js";

export type ProjectionRosterIdentity = Pick<
  DecisionProjectionPlayerRow,
  "playerId" | "name" | "primaryPosition" | "eligiblePositions" | "nflTeam" | "status" | "gsisId"
>;

export interface ProjectionExternalIdentity {
  readonly playerId: string;
  readonly source: string;
  readonly externalId: string;
}

const teams = new Set<string>(NFL_TEAMS);

function position(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (["DST", "DEF", "D/ST"].includes(normalized)) return "DST";
  return normalized === "PK" ? "K" : normalized;
}

function team(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = canonicalNflTeamCode(value);
  return teams.has(normalized) ? normalized : undefined;
}

function name(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function providerKey(row: ProjectionExternalIdentity, leagueSeasonId: string): string | undefined {
  if (row.source === "espn-self-asserted") {
    const prefix = `${leagueSeasonId}:`;
    return row.externalId.startsWith(prefix)
      ? `espn:${row.externalId.slice(prefix.length)}`
      : undefined;
  }
  if (["espn", "sleeper-espn", "yahoo", "sleeper-yahoo"].includes(row.source)) {
    return `${row.source.replace("sleeper-", "")}:${row.externalId}`;
  }
  return undefined;
}

/**
 * Bind current roster IDs to numbers in one already-admitted release. This does not merge players,
 * publish new numbers, or change release timestamps. Direct projections win; other matches must
 * be unique and bijective across the entire current league roster. Names alone are never enough:
 * an exact name match also requires a trusted GSIS catalog record, NFL team and fantasy position.
 * An unbridged self-asserted provider ID is not a conflicting canonical identity, but a conflicting
 * provider crosswalk is. Ambiguity and genuinely missing forecasts remain uncovered.
 */
export function reconcileRosterProjectionAliases(input: {
  readonly leagueSeasonId: string;
  readonly rosterPlayers: readonly ProjectionRosterIdentity[];
  readonly projections: readonly DecisionProjectionPlayerRow[];
  readonly externalIds: readonly ProjectionExternalIdentity[];
}): DecisionProjectionPlayerRow[] {
  const projections = new Map(input.projections.map((row) => [row.playerId, row]));
  const roster = new Map(input.rosterPlayers.map((row) => [row.playerId, row]));
  const keys = new Map<string, Set<string>>();
  for (const row of input.externalIds) {
    const key = providerKey(row, input.leagueSeasonId);
    if (!key) continue;
    const values = keys.get(row.playerId) ?? new Set<string>();
    values.add(key);
    keys.set(row.playerId, values);
  }
  const canonical = [...projections.values()].filter(
    (row) => row.gsisId?.trim() || position(row.primaryPosition) === "DST",
  );
  const proposed: DecisionProjectionPlayerRow[] = [];
  for (const row of roster.values()) {
    if (projections.has(row.playerId) || row.gsisId?.trim()) continue;
    const rosterTeam = team(row.nflTeam);
    const rosterPosition = position(row.primaryPosition);
    if (!rosterTeam || !["QB", "RB", "WR", "TE", "K", "DST"].includes(rosterPosition)) continue;
    const compatible = (candidate: DecisionProjectionPlayerRow) =>
      team(candidate.nflTeam) === rosterTeam &&
      position(candidate.primaryPosition) === rosterPosition;
    const rosterKeys = keys.get(row.playerId) ?? new Set<string>();
    const linked = canonical.filter((candidate) =>
      [...(keys.get(candidate.playerId) ?? [])].some((key) => rosterKeys.has(key)),
    );
    const matches =
      linked.length > 0
        ? linked
        : canonical.filter(
            (candidate) =>
              compatible(candidate) &&
              (rosterPosition === "DST" ||
                (name(row.name).length > 0 && name(candidate.name) === name(row.name))),
          );
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    if (!compatible(match) || roster.has(match.playerId)) continue;
    const candidateKeys = keys.get(match.playerId) ?? new Set<string>();
    const conflict = ["espn:", "yahoo:"].some((prefix) => {
      const rosterProviderKeys = [...rosterKeys].filter((key) => key.startsWith(prefix));
      const candidateProviderKeys = [...candidateKeys].filter((key) => key.startsWith(prefix));
      return (
        rosterProviderKeys.length > 0 &&
        candidateProviderKeys.length > 0 &&
        !rosterProviderKeys.some((key) => candidateKeys.has(key))
      );
    });
    if (conflict) continue;
    proposed.push({
      ...match,
      ...row,
      projectionPlayerId: match.playerId,
    });
  }
  const uses = new Map<string, number>();
  for (const row of proposed) {
    const id = row.projectionPlayerId!;
    uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return proposed.filter((row) => uses.get(row.projectionPlayerId!) === 1);
}
