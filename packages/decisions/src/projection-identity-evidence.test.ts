import type { Database } from "@laces-out/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { loadProjectionIdentityEvidence } from "./projection-identity-evidence.js";
import type { ProjectionExternalIdentity } from "./projection-roster-aliases.js";

type EvidenceRow = ProjectionExternalIdentity & { readonly catalogGsisId?: string | null };

function fakeDatabase(initial: readonly EvidenceRow[], bridges: readonly EvidenceRow[] = []) {
  const results = [initial, bridges];
  const calls: { fields: unknown; where?: SQL; joins: number; limit?: number }[] = [];
  const select = vi.fn((fields: unknown) => {
    const index = calls.length;
    const call: (typeof calls)[number] = { fields, joins: 0 };
    calls.push(call);
    const query = {
      from: () => query,
      innerJoin: () => {
        call.joins += 1;
        return query;
      },
      where: (predicate: SQL) => {
        call.where = predicate;
        return query;
      },
      limit: (limit: number) => {
        call.limit = limit;
        if (index >= results.length) throw new Error("Unexpected extra query");
        return Promise.resolve(results[index]!.slice(0, limit));
      },
    };
    return query;
  });
  return { database: { select } as unknown as Pick<Database, "select">, calls };
}

const yahoo: EvidenceRow = { playerId: "roster", source: "yahoo", externalId: "470.p.26686" };
const outside: EvidenceRow = {
  playerId: "outside-pool",
  source: "sleeper-yahoo",
  externalId: "26686",
  catalogGsisId: "00-0000001",
};

describe("bounded projection identity evidence", () => {
  it("closes a Yahoo bridge outside the requested pool in exactly two batched reads", async () => {
    const fixture = fakeDatabase([yahoo], [outside]);
    const evidence = await loadProjectionIdentityEvidence(fixture.database, [
      "roster",
      "candidate",
      "roster",
    ]);
    expect(evidence).toEqual({ complete: true, externalIds: [yahoo, outside] });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map((call) => call.limit)).toEqual([20_481, 50_001]);
    expect(fixture.calls.map((call) => call.joins)).toEqual([0, 1]);
    const dialect = new PgDialect();
    const initial = dialect.sqlToQuery(fixture.calls[0]!.where!);
    expect(initial.params).toEqual([
      "candidate",
      "roster",
      "espn-self-asserted",
      "espn",
      "yahoo",
      "sleeper-espn",
      "sleeper-yahoo",
    ]);
    const global = dialect.sqlToQuery(fixture.calls[1]!.where!);
    expect(global.params).toEqual(["espn", "sleeper-espn", "sleeper-yahoo", "yahoo"]);
    expect(global.sql).toContain('"players"."gsis_id" is not null');
    expect(fixture.calls[1]!.fields).toHaveProperty("catalogGsisId");
  });

  it("retains every normalized-key collision rather than making one target look unique", async () => {
    const competing = { ...outside, playerId: "other-outside", externalId: "nfl.p.26686" };
    const duplicateTarget = { ...outside, externalId: "469.p.26686" };
    const irrelevant = { ...outside, playerId: "unrequested", externalId: "99999" };
    for (const rows of [
      [outside, competing, duplicateTarget, irrelevant],
      [irrelevant, duplicateTarget, competing, outside],
    ]) {
      const fixture = fakeDatabase([yahoo], rows);
      const evidence = await loadProjectionIdentityEvidence(fixture.database, ["roster"]);
      expect(evidence.complete).toBe(true);
      expect(evidence.externalIds).toHaveLength(4);
      expect(evidence.externalIds).toEqual(
        expect.arrayContaining([yahoo, outside, competing, duplicateTarget]),
      );
    }
  });

  it("keeps a legacy scoped ESPN target without catalog GSIS as stronger outside-pool evidence", async () => {
    const scoped = {
      playerId: "roster",
      source: "espn-self-asserted",
      externalId: "league:provider-7",
    };
    const direct = {
      playerId: "outside-espn",
      source: "espn",
      externalId: "provider-7",
      catalogGsisId: null,
    };
    const sleeper = { ...direct, playerId: "outside-sleeper", source: "sleeper-espn" };
    const fixture = fakeDatabase([scoped], [direct, sleeper]);
    expect(await loadProjectionIdentityEvidence(fixture.database, ["roster"])).toEqual({
      complete: true,
      externalIds: [scoped, direct, sleeper],
    });
  });

  it("captures structurally valid scopes without deciding which league may use them", async () => {
    const rows = [
      { playerId: "roster", source: "espn-self-asserted", externalId: "other-league:123" },
      { playerId: "roster", source: "espn-self-asserted", externalId: " :456" },
      { playerId: "roster", source: "espn-self-asserted", externalId: ":789" },
      { playerId: "roster", source: "espn-self-asserted", externalId: "league:" },
    ];
    const bridges = ["123", "456", "789"].map((externalId) => ({
      playerId: `outside-${externalId}`,
      source: "espn",
      externalId,
      catalogGsisId: null,
    }));
    const fixture = fakeDatabase(rows, bridges);
    expect(await loadProjectionIdentityEvidence(fixture.database, ["roster"])).toEqual({
      complete: true,
      externalIds: [...rows, bridges[0]!],
    });
  });

  it("excludes unrelated untrusted Yahoo aliases while retaining trusted direct Yahoo facts", async () => {
    const otherAlias = {
      ...outside,
      playerId: "other-league-alias",
      source: "yahoo",
      catalogGsisId: null,
    };
    const trusted = { ...otherAlias, playerId: "trusted-yahoo", catalogGsisId: "00-0000002" };
    const fixture = fakeDatabase([yahoo], [otherAlias, trusted, outside]);
    expect(await loadProjectionIdentityEvidence(fixture.database, ["roster"])).toEqual({
      complete: true,
      externalIds: [yahoo, trusted, outside],
    });
  });

  it("preserves malformed and different provider facts on the original identities", async () => {
    const bad = { playerId: "candidate", source: "yahoo", externalId: "nba.p.26686" };
    const differing = { playerId: "candidate", source: "espn", externalId: "another-id" };
    const fixture = fakeDatabase([yahoo, bad, differing], [outside]);
    expect(await loadProjectionIdentityEvidence(fixture.database, ["roster", "candidate"])).toEqual(
      {
        complete: true,
        externalIds: [yahoo, bad, differing, outside],
      },
    );
  });

  it("preserves string identifiers and whitespace normalization without numeric coercion", async () => {
    const initial = [
      { ...yahoo, externalId: "470.p.0026686" },
      { playerId: "long", source: "espn", externalId: " 9007199254740993 " },
    ];
    const expected = [
      { ...outside, externalId: "nfl.p.0026686" },
      {
        ...outside,
        playerId: "long-outside",
        source: "sleeper-espn",
        externalId: "9007199254740993",
      },
    ];
    const fixture = fakeDatabase(initial, [...expected, outside]);
    expect(await loadProjectionIdentityEvidence(fixture.database, ["roster", "long"])).toEqual({
      complete: true,
      externalIds: [...initial, ...expected],
    });
  });

  it("enriches an already present row with catalog provenance instead of duplicating it", async () => {
    const initial = { playerId: "canonical", source: "sleeper-yahoo", externalId: "26686" };
    const joined = { ...initial, catalogGsisId: "00-0000001" };
    const fixture = fakeDatabase([yahoo, initial], [joined]);
    expect(await loadProjectionIdentityEvidence(fixture.database, ["roster", "canonical"])).toEqual(
      {
        complete: true,
        externalIds: [yahoo, joined],
      },
    );
  });

  it("accepts the exact identity bound and refuses overflow before querying", async () => {
    const ids = Array.from({ length: 5_120 }, (_, index) => `player-${index}`);
    const fixture = fakeDatabase([]);
    expect(await loadProjectionIdentityEvidence(fixture.database, [...ids, ids[0]!])).toEqual({
      complete: true,
      externalIds: [],
    });
    expect(fixture.calls).toHaveLength(1);
    const overflow = fakeDatabase([]);
    expect(await loadProjectionIdentityEvidence(overflow.database, [...ids, "extra"])).toEqual({
      complete: false,
      externalIds: [],
    });
    expect(overflow.calls).toHaveLength(0);
  });

  it("does not query for empty input or a bridge collection with no valid requested key", async () => {
    const empty = fakeDatabase([]);
    expect(await loadProjectionIdentityEvidence(empty.database, [])).toEqual({
      complete: true,
      externalIds: [],
    });
    expect(empty.calls).toHaveLength(0);
    const invalid = { ...yahoo, externalId: "nba.p.26686" };
    const fixture = fakeDatabase([invalid]);
    expect(await loadProjectionIdentityEvidence(fixture.database, ["roster"])).toEqual({
      complete: true,
      externalIds: [invalid],
    });
    expect(fixture.calls).toHaveLength(1);
  });

  it("rejects an overflowing initial collection without returning a truncated identity set", async () => {
    const atLimit = Array.from({ length: 20_480 }, (_, index) => ({
      playerId: "roster",
      source: "espn",
      externalId: String(index),
    }));
    const accepted = fakeDatabase(atLimit);
    expect((await loadProjectionIdentityEvidence(accepted.database, ["roster"])).complete).toBe(
      true,
    );
    expect(accepted.calls).toHaveLength(2);
    const overflow = fakeDatabase([...atLimit, { ...yahoo, source: "espn", externalId: "extra" }]);
    expect(await loadProjectionIdentityEvidence(overflow.database, ["roster"])).toEqual({
      complete: false,
      externalIds: [],
    });
    expect(overflow.calls).toHaveLength(1);
  });

  it("rejects global overflow without accepting even a matching prefix as complete evidence", async () => {
    const atLimit = Array.from({ length: 50_000 }, (_, index) => ({
      ...outside,
      playerId: `outside-${index}`,
      externalId: String(100_000 + index),
    }));
    const accepted = fakeDatabase([yahoo], atLimit);
    expect(await loadProjectionIdentityEvidence(accepted.database, ["roster"])).toEqual({
      complete: true,
      externalIds: [yahoo],
    });
    const overflow = fakeDatabase([yahoo], [outside, ...atLimit]);
    expect(await loadProjectionIdentityEvidence(overflow.database, ["roster"])).toEqual({
      complete: false,
      externalIds: [yahoo],
    });
    expect(overflow.calls).toHaveLength(2);
  });

  it("fails closed on unexpected sources rather than treating them as absence of evidence", async () => {
    const unknown = { ...outside, source: "unrecognized-provider" };
    const initial = fakeDatabase([yahoo, unknown]);
    expect(await loadProjectionIdentityEvidence(initial.database, ["roster"])).toEqual({
      complete: false,
      externalIds: [],
    });
    expect(initial.calls).toHaveLength(1);
    const global = fakeDatabase([yahoo], [outside, unknown]);
    expect(await loadProjectionIdentityEvidence(global.database, ["roster"])).toEqual({
      complete: false,
      externalIds: [yahoo],
    });
  });
});
