import { describe, expect, it } from "vitest";

import {
  weeklyHistoricalRolesChecksum,
  weeklySourceManifest,
  weeklyPublicationBudget,
} from "./weekly-input-snapshot.js";

const historicalRole = {
  playerId: "player-one",
  season: 2030,
  week: 3,
  gameId: "2030_03_CHI_GB",
  position: "QB",
} as const;
const sourceUniverse = {
  required: ["nflverse.players", "nflverse.weekly-rosters.2030"],
  optional: ["nflverse.weekly-rosters.2031"],
} as const;
const selectedSources = [
  {
    id: "catalog-source",
    key: "nflverse.players",
    checksum: "a".repeat(64),
    lastSuccessfulAt: new Date("2031-09-01T12:00:00.000Z"),
  },
  {
    id: "historical-roster-source",
    key: "nflverse.weekly-rosters.2030",
    checksum: "b".repeat(64),
    lastSuccessfulAt: new Date("2031-09-01T12:00:00.000Z"),
  },
] as const;

describe("weekly historical role identity", () => {
  it("distinguishes changed historical fallback roles even when the current forecast remains WR", () => {
    // Both assemblies can resolve the player's current roster role to WR. The earlier game's
    // catalog fallback is still a model input and must invalidate reuse independently of it.
    const earlier = weeklyHistoricalRolesChecksum({ weekly: [historicalRole], snaps: [] });
    const revised = weeklyHistoricalRolesChecksum({
      weekly: [{ ...historicalRole, position: "TE" }],
      snaps: [],
    });
    expect(revised).not.toBe(earlier);
  });

  it("includes snap-only historical roles", () => {
    const earlier = weeklyHistoricalRolesChecksum({ weekly: [], snaps: [historicalRole] });
    const revised = weeklyHistoricalRolesChecksum({
      weekly: [],
      snaps: [{ ...historicalRole, position: "TE" }],
    });
    expect(revised).not.toBe(earlier);
  });

  it("is stable when the same weekly and snap evidence arrives in another order", () => {
    const other = { ...historicalRole, playerId: "player-two", week: 4, gameId: "2030_04_CHI_DET" };
    expect(
      weeklyHistoricalRolesChecksum({
        weekly: [historicalRole, other],
        snaps: [other, historicalRole],
      }),
    ).toBe(
      weeklyHistoricalRolesChecksum({
        weekly: [other, historicalRole],
        snaps: [historicalRole, other],
      }),
    );
  });

  it.each([
    { playerId: "different-player" },
    { season: 2029 },
    { week: 4 },
    { gameId: "different-game" },
  ])("does not alias a different historical identity: %j", (changed) => {
    expect(
      weeklyHistoricalRolesChecksum({ weekly: [{ ...historicalRole, ...changed }], snaps: [] }),
    ).not.toBe(weeklyHistoricalRolesChecksum({ weekly: [historicalRole], snaps: [] }));
  });
});

describe("weekly admitted source manifest", () => {
  it("changes when a previously missing optional source first arrives", () => {
    const missing = weeklySourceManifest(sourceUniverse, selectedSources);
    const arrived = weeklySourceManifest(sourceUniverse, [
      ...selectedSources,
      {
        id: "current-roster-source",
        key: "nflverse.weekly-rosters.2031",
        checksum: "c".repeat(64),
        lastSuccessfulAt: new Date("2031-09-01T12:10:00.000Z"),
      },
    ]);
    expect(arrived.checksum).not.toBe(missing.checksum);
  });

  it("keeps semantic identity stable when unchanged sources are checked again", () => {
    const earlier = weeklySourceManifest(sourceUniverse, selectedSources);
    const checkedAgain = weeklySourceManifest(
      sourceUniverse,
      selectedSources.map((source) => ({
        ...source,
        lastSuccessfulAt: new Date("2031-09-01T13:00:00.000Z"),
      })),
    );
    expect(checkedAgain.checksum).toBe(earlier.checksum);
  });

  it("is stable across source and universe ordering", () => {
    const earlier = weeklySourceManifest(sourceUniverse, selectedSources);
    const reordered = weeklySourceManifest(
      {
        required: [...sourceUniverse.required].reverse(),
        optional: [...sourceUniverse.optional].reverse(),
      },
      [...selectedSources].reverse(),
    );
    expect(reordered.checksum).toBe(earlier.checksum);
    expect(reordered.sources).toEqual(earlier.sources);
  });

  it.each([{ id: "replacement-catalog-source" }, { checksum: "d".repeat(64) }])(
    "distinguishes changed source identity or content: %j",
    (changed) => {
      const earlier = weeklySourceManifest(sourceUniverse, selectedSources);
      const revised = weeklySourceManifest(sourceUniverse, [
        { ...selectedSources[0], ...changed },
        selectedSources[1],
      ]);
      expect(revised.checksum).not.toBe(earlier.checksum);
    },
  );

  it("records absent optional keys as part of the source universe", () => {
    const earlier = weeklySourceManifest(sourceUniverse, selectedSources);
    const otherUniverse = weeklySourceManifest(
      {
        ...sourceUniverse,
        optional: ["nflverse.injuries.2031"],
      },
      selectedSources,
    );
    expect(otherUniverse.checksum).not.toBe(earlier.checksum);
  });
});

describe("weekly publication deadline", () => {
  it("stops a sequence of otherwise fast queries once the total lock budget is consumed", () => {
    let monotonicNow = 1000;
    const budget = weeklyPublicationBudget(() => monotonicNow);
    for (let query = 0; query < 7; query += 1) {
      monotonicNow += 1000;
      expect(() => budget.check()).not.toThrow();
    }
    monotonicNow += 1000;
    expect(() => budget.check()).toThrow(
      expect.objectContaining({ code: "PROJECTION_PUBLICATION_TIMEOUT" }),
    );
  });
});
