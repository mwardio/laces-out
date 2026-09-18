import { createHash } from "node:crypto";

import {
  playerSnapCountObservations,
  playerWeeklyStatObservations,
  players,
  type Database,
} from "@laces-out/db";
import { and, eq, inArray } from "drizzle-orm";

import { rosSourceVersionPredicate } from "./first-party-ros-source-versions.js";

interface HistoricalCatalogRole {
  readonly playerId: string;
  readonly position: string;
}

/** Immutable observation checksums do not describe the mutable catalog roles joined at read time. */
export function rosHistoryCatalogRolesChecksum(rows: readonly HistoricalCatalogRole[]): string {
  const members = [
    ...new Set(rows.map((row) => JSON.stringify([row.playerId, row.position]))),
  ].sort();
  return createHash("sha256")
    .update(JSON.stringify({ version: "live-ros-history-catalog-roles-v1", members }))
    .digest("hex");
}

/** Read inside the same short repeatable-read snapshot as the other live candidate inputs. */
export async function readRosHistoryCatalogRolesChecksum(
  database: Pick<Database, "selectDistinctOn">,
  seasons: readonly number[],
  sources: ReadonlyMap<string, { readonly id: string; readonly checksum: string }>,
): Promise<string> {
  const selected = (kind: string) =>
    seasons.flatMap((season) => {
      const source = sources.get(`nflverse.${kind}.${season}`);
      return source ? [source] : [];
    });
  const weeklyVersion = rosSourceVersionPredicate(
    selected("stats-player-week"),
    playerWeeklyStatObservations.sourceId,
    playerWeeklyStatObservations.inputChecksum,
  );
  const snapVersion = rosSourceVersionPredicate(
    selected("snap-counts"),
    playerSnapCountObservations.sourceId,
    playerSnapCountObservations.inputChecksum,
  );
  const fields = { playerId: players.id, position: players.primaryPosition };
  const [weekly, snaps] = await Promise.all([
    weeklyVersion
      ? database
          .selectDistinctOn([players.id], fields)
          .from(playerWeeklyStatObservations)
          .innerJoin(players, eq(players.id, playerWeeklyStatObservations.playerId))
          .where(
            and(
              weeklyVersion,
              inArray(playerWeeklyStatObservations.season, [...seasons]),
              eq(playerWeeklyStatObservations.seasonType, "REG"),
            ),
          )
          .orderBy(players.id)
      : [],
    snapVersion
      ? database
          .selectDistinctOn([players.id], fields)
          .from(playerSnapCountObservations)
          .innerJoin(players, eq(players.id, playerSnapCountObservations.playerId))
          .where(
            and(
              snapVersion,
              inArray(playerSnapCountObservations.season, [...seasons]),
              eq(playerSnapCountObservations.seasonType, "REG"),
            ),
          )
          .orderBy(players.id)
      : [],
  ]);
  return rosHistoryCatalogRolesChecksum([...weekly, ...snaps]);
}
