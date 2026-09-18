import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
} from "@laces-out/projections";
import { describe, expect, it } from "vitest";

import {
  canonicalRosLiveRows,
  rosLivePhysicalIdentity,
  type RosLivePhysicalIdentityInput,
} from "./ros-live-physical-identity.js";

function fixture(): RosLivePhysicalIdentityInput {
  return {
    season: 2026,
    window: { asOfWeek: 2, windowStartWeek: 3, windowEndWeek: 18 },
    sources: [
      { key: "nflverse.schedules.2026", id: "schedule-source", checksum: "a".repeat(64) },
      { key: "nflverse.injuries.2026", id: null, checksum: null },
    ],
    rows: {
      schedules: [
        { week: 3, kickoffAt: new Date("2026-09-27T17:00:00Z"), status: "scheduled" },
        { week: 4, kickoffAt: new Date("2026-10-04T17:00:00Z"), status: "scheduled" },
      ],
      weekly: [{ playerId: "a", position: "WR", components: { receptions: 4 }, advanced: {} }],
      snaps: [{ playerId: "a", position: "WR", offenseShare: "0.9" }],
      rosters: [{ externalPlayerId: "unresolved", playerId: null, position: "WR" }],
      injuries: [],
      teams: [{ team: "KC", components: { defensive_sacks: 2 } }],
    },
  };
}

describe("live ROS physical identity", () => {
  it("ignores row, source, family and nested object key order", () => {
    const original = fixture();
    const reordered = {
      ...original,
      sources: [...original.sources].reverse(),
      rows: Object.fromEntries(
        Object.entries(original.rows)
          .reverse()
          .map(([key, rows]) => [
            key,
            [...rows]
              .reverse()
              .map((row) => Object.fromEntries(Object.entries(row as object).reverse())),
          ]),
      ),
    };
    expect(rosLivePhysicalIdentity(reordered)).toBe(rosLivePhysicalIdentity(original));
    expect(rosLivePhysicalIdentity(original)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(["schedules", "weekly", "snaps", "rosters", "injuries", "teams"])(
    "invalidates when the captured %s family changes",
    (family) => {
      const original = fixture();
      const changed = {
        ...original,
        rows: { ...original.rows, [family]: [...original.rows[family]!, { changed: true }] },
      };
      expect(rosLivePhysicalIdentity(changed)).not.toBe(rosLivePhysicalIdentity(original));
    },
  );

  it("includes mutable historical roles and unresolved-to-resolved roster identities", () => {
    const original = fixture();
    for (const [family, changed] of [
      ["weekly", { playerId: "a", position: "TE", components: { receptions: 4 }, advanced: {} }],
      ["snaps", { playerId: "a", position: "TE", offenseShare: "0.9" }],
      ["rosters", { externalPlayerId: "unresolved", playerId: "a", position: "WR" }],
    ] as const) {
      expect(
        rosLivePhysicalIdentity({ ...original, rows: { ...original.rows, [family]: [changed] } }),
      ).not.toBe(rosLivePhysicalIdentity(original));
    }
  });

  it("includes source identity, checksum and explicit absence", () => {
    const original = fixture();
    const present = original.sources[0]!;
    for (const sources of [
      [{ ...present, id: "replacement-source" }, original.sources[1]!],
      [{ ...present, checksum: "b".repeat(64) }, original.sources[1]!],
      [present, { key: "nflverse.injuries.2026", id: "injuries", checksum: "c".repeat(64) }],
      [present],
    ]) {
      expect(rosLivePhysicalIdentity({ ...original, sources })).not.toBe(
        rosLivePhysicalIdentity(original),
      );
    }
  });

  it("uses numerical engine defaults and includes each window/scenario setting", () => {
    const original = fixture();
    expect(
      rosLivePhysicalIdentity({
        ...original,
        scenarioCount: FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
        convergenceReferenceScenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
      }),
    ).toBe(rosLivePhysicalIdentity(original));
    for (const changed of [
      { season: 2027 },
      { window: { ...original.window, asOfWeek: 1 } },
      { window: { ...original.window, windowStartWeek: 4 } },
      { window: { ...original.window, windowEndWeek: 17 } },
      { scenarioCount: 128 },
      { convergenceReferenceScenarioCount: FIRST_PARTY_ROS_DEFAULT_SCENARIOS },
    ]) {
      expect(rosLivePhysicalIdentity({ ...original, ...changed })).not.toBe(
        rosLivePhysicalIdentity(original),
      );
    }
  });

  it("retains duplicate facts and distinguishes missing families from captured empty families", () => {
    const original = fixture();
    expect(
      rosLivePhysicalIdentity({
        ...original,
        rows: { ...original.rows, weekly: [...original.rows.weekly!, ...original.rows.weekly!] },
      }),
    ).not.toBe(rosLivePhysicalIdentity(original));
    const { injuries: ignored, ...rows } = original.rows;
    void ignored;
    expect(rosLivePhysicalIdentity({ ...original, rows })).not.toBe(
      rosLivePhysicalIdentity(original),
    );
  });

  it("does not admit wall-clock, league or policy metadata into football identity", () => {
    const original = fixture();
    const publication = {
      ...original,
      now: new Date("2030-01-01"),
      leagueSeasonId: "new-league",
      scoringProfile: { receptions: 2 },
      artifactChecksum: "new-policy",
    };
    expect(rosLivePhysicalIdentity(publication)).toBe(rosLivePhysicalIdentity(original));
  });

  it("rejects ambiguous source manifests and invalid scenario settings", () => {
    const original = fixture();
    expect(() =>
      rosLivePhysicalIdentity({
        ...original,
        sources: [...original.sources, original.sources[0]!],
      }),
    ).toThrow("source manifest");
    expect(() =>
      rosLivePhysicalIdentity({
        ...original,
        sources: [{ key: "feed", id: null, checksum: "hash" }],
      }),
    ).toThrow("source manifest");
    expect(() => rosLivePhysicalIdentity({ ...original, scenarioCount: 129 })).toThrow("scenario");
    expect(() =>
      rosLivePhysicalIdentity({ ...original, convergenceReferenceScenarioCount: 128 }),
    ).toThrow("shorter");
  });
});

describe("canonical captured live rows", () => {
  it("sorts canonical JSON without mutating rows, preserving duplicates and nested array order", () => {
    const a = { z: { b: 2, a: 1 }, a: [1, 2] };
    const same = { a: [1, 2], z: { a: 1, b: 2 } };
    const different = { a: [2, 1], z: { a: 1, b: 2 } };
    const rows = [different, a, same, a];
    const before = [...rows];
    expect(canonicalRosLiveRows(rows)).toEqual(canonicalRosLiveRows([...rows].reverse()));
    expect(canonicalRosLiveRows(rows)).toHaveLength(4);
    expect(rows).toEqual(before);
    expect(canonicalRosLiveRows(rows).filter((row) => row === a)).toHaveLength(2);
  });

  it("serializes distinct rows once rather than once per sort comparison", () => {
    let reads = 0;
    const rows = Array.from({ length: 1_024 }, (_, index) => ({
      get value() {
        reads += 1;
        return index;
      },
    }));
    const sorted = canonicalRosLiveRows(rows);
    expect(sorted).toHaveLength(rows.length);
    expect(reads).toBe(rows.length);
  });

  it("represents Date values as ISO strings and rejects information-losing inputs", () => {
    const date = new Date("2026-09-17T00:00:00Z");
    const original = fixture();
    expect(rosLivePhysicalIdentity({ ...original, rows: { dates: [{ date }] } })).toBe(
      rosLivePhysicalIdentity({ ...original, rows: { dates: [{ date: date.toISOString() }] } }),
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [NaN, Infinity, undefined, cycle, new Map(), new Date("invalid")]) {
      expect(() => canonicalRosLiveRows([value])).toThrow();
    }
  });
});
