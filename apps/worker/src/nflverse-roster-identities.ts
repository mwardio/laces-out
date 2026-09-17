import { playerExternalIds, players, type Database } from "@laces-out/db";
import { canonicalNflTeamCode, NFL_TEAMS } from "@laces-out/domain";
import type { NflverseWeeklyRosterPlayer } from "@laces-out/source-nflverse";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export const NFLVERSE_ROSTER_IDENTITY_LOCK = "nflverse-roster-identities";
export const NFLVERSE_ESB_ID_SOURCE = "nflverse-esb";
export const NFLVERSE_SMART_ID_SOURCE = "nflverse-smart";
const FALLBACK_SOURCES = [NFLVERSE_ESB_ID_SOURCE, NFLVERSE_SMART_ID_SOURCE];
const teams = new Set<string>(NFL_TEAMS);
const positions = new Set(["QB", "RB", "FB", "WR", "TE", "K"]);

function identities(row: NflverseWeeklyRosterPlayer): readonly [string, string][] {
  return [
    ...(row.gsisId ? [["gsis", row.gsisId] as [string, string]] : []),
    ...(row.esbId ? [[NFLVERSE_ESB_ID_SOURCE, row.esbId] as [string, string]] : []),
    ...(row.smartId ? [[NFLVERSE_SMART_ID_SOURCE, row.smartId] as [string, string]] : []),
  ];
}

const key = (source: string, id: string) => `${source}:${id}`;
const nameKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const positionKey = (position: string) => (position === "FB" ? "RB" : position);

/**
 * NFL roster ESB/SMART identifiers are authoritative even before a rookie has a GSIS ID.
 * Resolve connected exact-ID evidence, never names. Names/positions only guard admission and
 * continuity of a fallback identity; conflicts remain unmatched for the publication gate.
 */
export async function resolveNflverseRosterIdentities(
  database: Database,
  observations: readonly NflverseWeeklyRosterPlayer[],
  now: Date,
): Promise<ReadonlyMap<NflverseWeeklyRosterPlayer, string>> {
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let current = id;
    while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)!;
    parent.set(id, current);
    return current;
  };
  for (const row of observations) {
    const ids = identities(row).map(([source, id]) => key(source, id));
    const first = ids[0];
    if (!first) continue;
    for (const id of ids) parent.set(root(id), root(first));
  }
  return database.transaction(async (transaction) => {
    // Current and historical roster refreshes share these namespaces. Serialize their read/create
    // cycle so concurrent observations cannot mint two canonical players for the same NFL ID.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${NFLVERSE_ROSTER_IDENTITY_LOCK}))`,
    );
    const catalog = await transaction
      .select({
        id: players.id,
        gsisId: players.gsisId,
        fullName: players.fullName,
        primaryPosition: players.primaryPosition,
      })
      .from(players);
    const external = await transaction
      .select()
      .from(playerExternalIds)
      .where(inArray(playerExternalIds.source, FALLBACK_SOURCES));
    const catalogById = new Map(catalog.map((row) => [row.id, row]));
    const known = new Map<string, string>([
      ...catalog.flatMap((row): [string, string][] =>
        row.gsisId ? [[key("gsis", row.gsisId), row.id]] : [],
      ),
      ...external.map((row): [string, string] => [key(row.source, row.externalId), row.playerId]),
    ]);
    // Separate source rows can reference different aliases of one existing player. Join those
    // components before any write so competing new GSIS IDs reject the entire identity group,
    // independently of row order.
    const observedIdentityByPlayer = new Map<string, string>();
    for (const [identity, playerId] of known) {
      if (!parent.has(identity)) continue;
      const previous = observedIdentityByPlayer.get(playerId);
      if (previous) parent.set(root(identity), root(previous));
      else observedIdentityByPlayer.set(playerId, identity);
    }
    const groups = new Map<string, NflverseWeeklyRosterPlayer[]>();
    for (const row of observations) {
      const first = identities(row)[0];
      if (!first) continue;
      const id = root(key(...first));
      const rows = groups.get(id) ?? [];
      rows.push(row);
      groups.set(id, rows);
    }
    const resolved = new Map<NflverseWeeklyRosterPlayer, string>();
    const aliases = new Map<string, typeof playerExternalIds.$inferInsert>();
    for (const rows of groups.values()) {
      const evidence = new Map(
        rows
          .flatMap((row) => identities(row))
          .map(([source, id]) => [key(source, id), [source, id] as const]),
      );
      const gsisIds = [...evidence.values()]
        .filter(([source]) => source === "gsis")
        .map(([, id]) => id);
      if (gsisIds.length > 1) continue;
      const knownIds = new Set(
        [...evidence.keys()].flatMap((id) => (known.has(id) ? [known.get(id)!] : [])),
      );
      if (knownIds.size > 1) continue;
      let playerId = [...knownIds][0];
      const existing = playerId ? catalogById.get(playerId) : undefined;
      const gsisId = gsisIds[0] ?? null;
      if (existing?.gsisId && gsisId && existing.gsisId !== gsisId) continue;
      const latest = [...rows].sort((a, b) => b.season - a.season || b.week - a.week)[0]!;
      const continuityRows = existing?.gsisId ? rows.filter((row) => !row.gsisId) : rows;
      if (continuityRows.length > 0) {
        if (
          continuityRows.some(
            (row) =>
              !nameKey(row.fullName) ||
              row.fullName.length > 160 ||
              !positions.has(row.position) ||
              !teams.has(canonicalNflTeamCode(row.team)),
          ) ||
          new Set(continuityRows.map((row) => nameKey(row.fullName))).size !== 1 ||
          new Set(continuityRows.map((row) => positionKey(row.position))).size !== 1 ||
          (existing &&
            continuityRows.some(
              (row) =>
                nameKey(existing.fullName) !== nameKey(row.fullName) ||
                positionKey(existing.primaryPosition) !== positionKey(row.position),
            ))
        )
          continue;
      }
      if (!playerId) {
        const [created] = await transaction
          .insert(players)
          .values({
            gsisId,
            fullName: latest.fullName.trim(),
            firstName: latest.firstName,
            lastName: latest.lastName,
            nflTeam: canonicalNflTeamCode(latest.team),
            primaryPosition: latest.position,
            eligiblePositions: [latest.position],
            status: latest.status,
            rookieSeason: latest.rookieYear,
            lastSeason: latest.season,
            updatedAt: now,
          })
          .returning({ id: players.id });
        if (!created) throw new Error("NFL roster identity could not be created");
        playerId = created.id;
      } else if (gsisId && existing?.gsisId === null) {
        // A newly supplied GSIS ID strengthens the existing canonical identity. A conflicting
        // catalog owner was rejected above; the unique index also protects concurrent ingestion.
        const attached = await transaction
          .update(players)
          .set({ gsisId, updatedAt: now })
          .where(and(eq(players.id, playerId), isNull(players.gsisId)))
          .returning({ id: players.id });
        if (attached.length !== 1)
          throw new Error("NFL roster identity changed during GSIS attachment");
      }
      for (const [identity, [source, externalId]] of evidence) {
        known.set(identity, playerId);
        if (source !== "gsis")
          aliases.set(identity, { playerId, source, externalId, confidence: "1", verified: true });
      }
      for (const row of rows) resolved.set(row, playerId);
    }
    const aliasRows = [...aliases.values()];
    for (let index = 0; index < aliasRows.length; index += 500) {
      await transaction
        .insert(playerExternalIds)
        .values(aliasRows.slice(index, index + 500))
        .onConflictDoNothing();
    }
    return resolved;
  });
}
