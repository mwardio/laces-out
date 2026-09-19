import { playerExternalIds, players, type Database } from "@laces-out/db";
import { providerPlayerCrosswalkId } from "@laces-out/domain";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import type { ProjectionExternalIdentity } from "./projection-roster-aliases.js";

const MAX_IDENTITY_PLAYERS = 5_120;
const MAX_INITIAL_ROWS = 20_480;
const MAX_BRIDGE_ROWS = 50_000;
const SOURCES = ["espn-self-asserted", "espn", "yahoo", "sleeper-espn", "sleeper-yahoo"] as const;
const sourceSet = new Set<string>(SOURCES);
const bridgeSourceSet = new Set(["espn", "yahoo", "sleeper-espn", "sleeper-yahoo"]);

export interface ProjectionIdentityEvidence {
  readonly externalIds: readonly ProjectionExternalIdentity[];
  /** False means no inferred alias is authorized; callers retain direct numbers/own identities. */
  readonly complete: boolean;
}

/**
 * Close one explicit-provider hop independently of the available forecast/health pool. No player
 * is selected here. In particular an outside-pool ESPN record without GSIS remains evidence,
 * while another league/season's untrusted Yahoo alias is not a canonical target. Callers enforce
 * the actual self-asserted league prefix; requesting a superset of structurally valid scoped IDs
 * here cannot itself authorize an alias. Use the caller's read snapshot, never a global cache.
 */
export async function loadProjectionIdentityEvidence(
  database: Pick<Database, "select">,
  identityPlayerIds: readonly string[],
): Promise<ProjectionIdentityEvidence> {
  const ids = [...new Set(identityPlayerIds)].sort();
  if (ids.length === 0) return { externalIds: [], complete: true };
  if (ids.length > MAX_IDENTITY_PLAYERS) return { externalIds: [], complete: false };
  const initial = await database
    .select({
      playerId: playerExternalIds.playerId,
      source: playerExternalIds.source,
      externalId: playerExternalIds.externalId,
    })
    .from(playerExternalIds)
    .where(
      and(
        inArray(playerExternalIds.playerId, ids),
        inArray(playerExternalIds.source, [...SOURCES]),
      ),
    )
    .limit(MAX_INITIAL_ROWS + 1);
  if (initial.length > MAX_INITIAL_ROWS || initial.some((row) => !sourceSet.has(row.source))) {
    return { externalIds: [], complete: false };
  }

  const requested = new Set<string>();
  for (const row of initial) {
    if (row.source === "espn-self-asserted") {
      const separator = row.externalId.indexOf(":");
      if (separator <= 0 || !row.externalId.slice(0, separator).trim()) continue;
      const id = providerPlayerCrosswalkId("espn", row.externalId.slice(separator + 1));
      if (id !== undefined) requested.add(`espn:${id}`);
    } else {
      const id = providerPlayerCrosswalkId(row.source, row.externalId);
      if (id !== undefined) requested.add(`${row.source.replace(/^sleeper-/u, "")}:${id}`);
    }
  }
  if (requested.size === 0) return { externalIds: initial, complete: true };

  // One bounded source-filtered read, not a query per roster player. Normalization stays in the
  // shared JS helper so qualified Yahoo keys, whitespace, and string IDs have identical rules.
  const bridges = await database
    .select({
      playerId: playerExternalIds.playerId,
      source: playerExternalIds.source,
      externalId: playerExternalIds.externalId,
      catalogGsisId: players.gsisId,
    })
    .from(playerExternalIds)
    .innerJoin(players, eq(players.id, playerExternalIds.playerId))
    .where(
      or(
        inArray(playerExternalIds.source, ["espn", "sleeper-espn", "sleeper-yahoo"]),
        and(eq(playerExternalIds.source, "yahoo"), isNotNull(players.gsisId)),
      ),
    )
    .limit(MAX_BRIDGE_ROWS + 1);
  if (bridges.length > MAX_BRIDGE_ROWS || bridges.some((row) => !bridgeSourceSet.has(row.source))) {
    // The initial collection is complete, but a truncated bridge collection cannot prove that
    // any alias is unique. Do not leak any partial bridge rows into the returned evidence.
    return { externalIds: initial, complete: false };
  }
  const relevant = bridges.filter((row) => {
    if (row.source === "yahoo" && !row.catalogGsisId?.trim()) return false;
    const id = providerPlayerCrosswalkId(row.source, row.externalId);
    return id !== undefined && requested.has(`${row.source.replace(/^sleeper-/u, "")}:${id}`);
  });
  // Preserve raw IDs and catalog provenance; normalized collisions must reach the resolver as
  // distinct evidence. Prefer the joined copy when a row also occurred in the initial collection.
  const merged = new Map<string, ProjectionExternalIdentity>();
  for (const row of [...initial, ...relevant]) {
    merged.set(JSON.stringify([row.playerId, row.source, row.externalId]), row);
  }
  return { externalIds: [...merged.values()], complete: true };
}
