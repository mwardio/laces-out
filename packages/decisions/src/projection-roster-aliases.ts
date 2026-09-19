import {
  NFL_TEAMS,
  canonicalNflTeamCode,
  playerNameIdentityParts,
  playerNameIdentitiesCompatible,
  providerPlayerCrosswalkId,
} from "@laces-out/domain";

import type { DecisionProjectionPlayerRow } from "./in-season-decisions.js";

export type ProjectionRosterIdentity = Pick<
  DecisionProjectionPlayerRow,
  "playerId" | "name" | "primaryPosition" | "eligiblePositions" | "nflTeam" | "status" | "gsisId"
>;

export interface ProjectionExternalIdentity {
  readonly playerId: string;
  readonly source: string;
  readonly externalId: string;
  /** Catalog evidence supplied by the bridge lookup, including targets outside the pool. */
  readonly catalogGsisId?: string | null;
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

function providerKey(row: ProjectionExternalIdentity, leagueSeasonId: string): string | undefined {
  if (row.source === "espn-self-asserted") {
    const prefix = `${leagueSeasonId}:`;
    if (!row.externalId.startsWith(prefix)) return undefined;
    const id = providerPlayerCrosswalkId("espn", row.externalId.slice(prefix.length));
    return id === undefined ? undefined : `espn:${id}`;
  }
  if (["espn", "sleeper-espn", "yahoo", "sleeper-yahoo"].includes(row.source)) {
    const id = providerPlayerCrosswalkId(row.source, row.externalId);
    return id === undefined ? undefined : `${row.source.replace("sleeper-", "")}:${id}`;
  }
  return undefined;
}

/**
 * Bind current roster IDs to numbers in one already-admitted release. This does not merge players,
 * publish new numbers, or change release timestamps. Direct projections win; other matches must
 * be unique and bijective across the entire current league roster. Names alone are never enough:
 * a name match also requires a trusted GSIS catalog record, NFL team and fantasy position.
 * A terminal suffix may differ only when the entire base-name cohort has one compatible record.
 * An unbridged self-asserted provider ID is not a conflicting canonical identity, but a conflicting
 * provider crosswalk is. Ambiguity and genuinely missing forecasts remain uncovered.
 */
export function reconcileRosterProjectionAliases(input: {
  readonly leagueSeasonId: string;
  readonly rosterPlayers: readonly ProjectionRosterIdentity[];
  readonly projections: readonly DecisionProjectionPlayerRow[];
  readonly externalIds: readonly ProjectionExternalIdentity[];
  readonly externalEvidenceComplete?: boolean;
}): DecisionProjectionPlayerRow[] {
  return reconcileRosterIdentityAliases(input);
}

/** The same conservative identity join also binds stored health observations to roster aliases. */
export function reconcileRosterIdentityAliases<T extends ProjectionRosterIdentity>(input: {
  readonly leagueSeasonId: string;
  readonly rosterPlayers: readonly ProjectionRosterIdentity[];
  readonly projections: readonly T[];
  readonly externalIds: readonly ProjectionExternalIdentity[];
  readonly externalEvidenceComplete?: boolean;
}): (T & { readonly projectionPlayerId: string })[] {
  // A truncated or unclosed provider lookup cannot establish uniqueness or permit a name match.
  // Direct projections and direct health observations are handled by the caller independently.
  if (input.externalEvidenceComplete !== true) return [];
  const projections = new Map(input.projections.map((row) => [row.playerId, row]));
  const roster = new Map(input.rosterPlayers.map((row) => [row.playerId, row]));
  const keys = new Map<string, Set<string>>();
  const externalByPlayer = new Map<string, ProjectionExternalIdentity[]>();
  const targetIdsBySourceKey = new Map<string, Set<string>>();
  const trustedCatalogIds = new Set(
    input.projections.filter((row) => row.gsisId?.trim()).map((row) => row.playerId),
  );
  const invalidProviderPlayers = new Set<string>();
  for (const row of input.externalIds) {
    const key = providerKey(row, input.leagueSeasonId);
    const applicableSource =
      ["espn", "sleeper-espn", "yahoo", "sleeper-yahoo"].includes(row.source) ||
      (row.source === "espn-self-asserted" &&
        row.externalId.startsWith(`${input.leagueSeasonId}:`));
    if (applicableSource && key === undefined) {
      invalidProviderPlayers.add(row.playerId);
    }
    if (!key) continue;
    if (row.catalogGsisId?.trim()) trustedCatalogIds.add(row.playerId);
    const evidence = externalByPlayer.get(row.playerId) ?? [];
    evidence.push(row);
    externalByPlayer.set(row.playerId, evidence);
    const values = keys.get(row.playerId) ?? new Set<string>();
    values.add(key);
    keys.set(row.playerId, values);
    if (row.source === "espn-self-asserted") continue;
    // Unrelated Yahoo roster aliases can share a numeric player suffix. Only a catalog GSIS
    // record establishes a direct Yahoo canonical target; Sleeper and legacy ESPN bridges
    // still count as explicit evidence when their target has no forecast or no catalog GSIS.
    if (
      row.source === "yahoo" &&
      !row.catalogGsisId?.trim() &&
      !projections.get(row.playerId)?.gsisId?.trim()
    )
      continue;
    const sourceKey = `${row.source}:${key.slice(key.indexOf(":") + 1)}`;
    const targets = targetIdsBySourceKey.get(sourceKey) ?? new Set<string>();
    targets.add(row.playerId);
    targetIdsBySourceKey.set(sourceKey, targets);
  }
  const canonical = [...projections.values()].filter(
    (row) => row.gsisId?.trim() || position(row.primaryPosition) === "DST",
  );
  const proposed: (T & { readonly projectionPlayerId: string })[] = [];
  const canonicalById = new Map(canonical.map((row) => [row.playerId, row]));
  for (const row of roster.values()) {
    if (projections.has(row.playerId) || row.gsisId?.trim()) continue;
    if (invalidProviderPlayers.has(row.playerId)) continue;
    const rosterTeam = team(row.nflTeam);
    const rosterPosition = position(row.primaryPosition);
    if (!rosterTeam || !["QB", "RB", "WR", "TE", "K", "DST"].includes(rosterPosition)) continue;
    const compatible = (candidate: ProjectionRosterIdentity) =>
      team(candidate.nflTeam) === rosterTeam &&
      position(candidate.primaryPosition) === rosterPosition;
    const rosterKeys = keys.get(row.playerId) ?? new Set<string>();
    if (
      ["espn:", "yahoo:"].some(
        (prefix) => [...rosterKeys].filter((key) => key.startsWith(prefix)).length > 1,
      )
    )
      continue;
    const linkedIds = new Set<string>();
    for (const external of externalByPlayer.get(row.playerId) ?? []) {
      const key = providerKey(external, input.leagueSeasonId)!;
      const id = key.slice(key.indexOf(":") + 1);
      if (external.source === "espn-self-asserted") {
        const sleeperTargets = targetIdsBySourceKey.get(`sleeper-espn:${id}`);
        if (sleeperTargets?.size) {
          for (const targetId of sleeperTargets) linkedIds.add(targetId);
          // A null-GSIS legacy provider row may represent the same player under an older UUID.
          // A different catalog GSIS owner is a contradiction, not such a legacy fallback.
          for (const targetId of targetIdsBySourceKey.get(`espn:${id}`) ?? []) {
            if (trustedCatalogIds.has(targetId)) linkedIds.add(targetId);
          }
        } else {
          for (const targetId of targetIdsBySourceKey.get(`espn:${id}`) ?? [])
            linkedIds.add(targetId);
        }
        continue;
      }
      // The direct Yahoo index contains only catalog GSIS owners. Those are explicit targets
      // even without a Sleeper crosswalk; unrelated non-GSIS roster aliases remain excluded.
      const pairedSources =
        external.source === "yahoo"
          ? ["sleeper-yahoo", "yahoo"]
          : external.source.startsWith("sleeper-")
            ? [external.source.slice("sleeper-".length)]
            : [`sleeper-${external.source}`];
      for (const source of pairedSources) {
        for (const targetId of targetIdsBySourceKey.get(`${source}:${id}`) ?? [])
          linkedIds.add(targetId);
      }
    }
    let matches: readonly T[];
    if (linkedIds.size > 0) {
      if (linkedIds.size !== 1) continue;
      const linked = canonicalById.get([...linkedIds][0]!);
      if (!linked) continue; // Known outside-pool identity must never retry a display name.
      matches = [linked];
    } else {
      const rosterName = playerNameIdentityParts(row.name);
      const candidates = canonical.filter(compatible);
      const exact = candidates.filter(
        (candidate) =>
          rosterPosition === "DST" ||
          (rosterName.exact.length > 0 &&
            playerNameIdentityParts(candidate.name).exact === rosterName.exact),
      );
      if (exact.length > 0 || rosterPosition === "DST") matches = exact;
      else {
        // Count the whole base-name cohort before testing suffix or provider compatibility.
        const sameBase = candidates.filter(
          (candidate) =>
            rosterName.base.length > 0 &&
            playerNameIdentityParts(candidate.name).base === rosterName.base,
        );
        if (
          sameBase.length !== 1 ||
          !playerNameIdentitiesCompatible(rosterName, playerNameIdentityParts(sameBase[0]!.name))
        )
          continue;
        matches = sameBase;
      }
    }
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    if (invalidProviderPlayers.has(match.playerId)) continue;
    if (!compatible(match) || roster.has(match.playerId)) continue;
    const candidateKeys = keys.get(match.playerId) ?? new Set<string>();
    const conflict = ["espn:", "yahoo:"].some((prefix) => {
      const rosterProviderKeys = [...rosterKeys].filter((key) => key.startsWith(prefix));
      const candidateProviderKeys = [...candidateKeys].filter((key) => key.startsWith(prefix));
      return (
        candidateProviderKeys.length > 1 ||
        (rosterProviderKeys.length > 0 &&
          candidateProviderKeys.length > 0 &&
          !rosterProviderKeys.some((key) => candidateKeys.has(key)))
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
    const id = row.projectionPlayerId;
    uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return proposed.filter((row) => uses.get(row.projectionPlayerId) === 1);
}
