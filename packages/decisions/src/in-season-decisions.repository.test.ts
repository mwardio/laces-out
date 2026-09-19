import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  playerExternalIds,
  playerProjections,
  players,
  projectionSets,
  type Database,
} from "@laces-out/db";

import {
  DrizzleInSeasonDecisionRepository,
  restOfSeasonProjectionSetOrderBy,
} from "./in-season-decisions.js";

function compiledOrderBy(managedProfileKey: string | null): string {
  return new PgDialect().sqlToQuery(
    sql`select 1 order by ${sql.join(restOfSeasonProjectionSetOrderBy(managedProfileKey), sql`, `)}`,
  ).sql;
}

describe("restOfSeasonProjectionSetOrderBy", () => {
  it("does not emit PostgreSQL's invalid positional ORDER BY 0 without a managed profile", () => {
    const query = compiledOrderBy(null);

    expect(query).not.toMatch(/order by\s+0(?:\s|,|$)/u);
    expect(query).toContain('order by "projection_sets"."as_of_week" desc');
  });

  it("prefers an exact scoring profile when one is available", () => {
    const query = compiledOrderBy('[{"statId":"receptions","points":1,"bonuses":[]}]');

    expect(query).toContain("order by case when");
    expect(query).toContain(`"projection_sets"."metadata"->>'scoringProfileKey'`);
  });
});

describe("approved projection alias lookup", () => {
  const canonical = {
    playerId: "canonical",
    gsisId: "00-0036970",
    name: "Kyle Pitts",
    primaryPosition: "TE",
    eligiblePositions: ["TE"],
    nflTeam: "ATL",
    status: "ACT",
    meanPoints: "80",
    floorPoints: "40",
    ceilingPoints: "120",
  };
  const alias = { ...canonical, playerId: "alias", gsisId: null, name: "Kyle Pitts Sr." };
  const yahoo = { playerId: alias.playerId, source: "yahoo", externalId: "470.p.33392" };
  function harness(input: { bridges?: readonly unknown[]; direct?: boolean } = {}) {
    let projectionReads = 0;
    let externalReads = 0;
    const transactionOptions: unknown[] = [];
    let inSnapshot = false;
    const database = {
      transaction: async (fn: (db: Database) => Promise<unknown>, options: unknown) => {
        transactionOptions.push(options);
        inSnapshot = true;
        try {
          return await fn(database);
        } finally {
          inSnapshot = false;
        }
      },
      select: () => {
        expect(inSnapshot).toBe(true);
        let table: unknown;
        const query = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          innerJoin: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (resolve: (value: unknown) => unknown) => {
            if (table === playerProjections)
              return Promise.resolve(
                resolve(++projectionReads === 1 ? (input.direct ? [alias] : []) : [canonical]),
              );
            if (table === projectionSets)
              return Promise.resolve(
                resolve([
                  {
                    leagueSeasonId: "league",
                    source: "laces-out-first-party-ros",
                    horizon: "rest-of-season",
                  },
                ]),
              );
            if (table === players) return Promise.resolve(resolve([alias]));
            if (table === playerExternalIds)
              return Promise.resolve(
                resolve(++externalReads === 1 ? [yahoo] : (input.bridges ?? [])),
              );
            throw new Error("Unexpected table in alias lookup");
          },
        };
        return query;
      },
    } as unknown as Database;
    return {
      repository: new DrizzleInSeasonDecisionRepository(database),
      externalReads: () => externalReads,
      transactionOptions,
    };
  }

  it("loads complete bridge evidence before resolving an observed suffix spelling", async () => {
    const h = harness();
    expect(await h.repository.listProjectionPlayersByIds("set", [alias.playerId])).toEqual([
      { ...canonical, ...alias, projectionPlayerId: canonical.playerId },
    ]);
    expect(h.externalReads()).toBe(2);
    expect(h.transactionOptions).toEqual([
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ]);
  });

  it("does not substitute a name when the Yahoo bridge points outside the admitted release", async () => {
    const h = harness({
      bridges: [
        {
          playerId: "outside",
          source: "sleeper-yahoo",
          externalId: "33392",
          catalogGsisId: "00-other",
        },
      ],
    });
    expect(await h.repository.listProjectionPlayersByIds("set", [alias.playerId])).toEqual([]);
    expect(h.externalReads()).toBe(2);
  });

  it("does not accept a truncated bridge catalog as proof that a suffix match is unique", async () => {
    const h = harness({
      bridges: Array.from({ length: 50_001 }, () => ({
        playerId: "outside",
        source: "sleeper-yahoo",
        externalId: "other",
      })),
    });
    expect(await h.repository.listProjectionPlayersByIds("set", [alias.playerId])).toEqual([]);
  });

  it("preserves direct approved forecasts without querying the bridge catalog", async () => {
    const h = harness({ direct: true });
    expect(await h.repository.listProjectionPlayersByIds("set", [alias.playerId])).toEqual([alias]);
    expect(h.externalReads()).toBe(0);
  });
});
