import { describe, expect, it } from "vitest";

import type { NflversePlayerInjuryReport } from "@laces-out/source-nflverse";

import {
  datasetMetadata,
  injuryReportStateKey,
  snapCountsIdentityKey,
  uniqueSeasonWindow,
  weeklyRosterIdentityKey,
  weeklyStatsIdentityKey,
} from "./nflverse-weekly-data.js";

const metadataInput = {
  previous: {},
  season: 2026,
  rowsRejected: 0,
  coveredWeeks: [1],
  coveredSeasonTypes: ["REG"],
} as const;

describe("nflverse weekly worker helpers", () => {
  it("checks a four-season training window in chronological order", () => {
    expect(uniqueSeasonWindow(2026)).toEqual([2023, 2024, 2025, 2026]);
    expect(() => uniqueSeasonWindow(2011)).toThrow(/between 2012 and 2200/u);
  });

  it("uses stable provider identifiers rather than names for player resolution", () => {
    expect(weeklyStatsIdentityKey({ gsisId: "00-0031234" } as never)).toBe("00-0031234");
    expect(snapCountsIdentityKey({ pfrPlayerId: "PlaySc00" } as never)).toBe("PlaySc00");
    expect(
      weeklyRosterIdentityKey({
        gsisId: null,
        esbId: "PLY123",
        smartId: "10000000-0000-4000-8000-000000000123",
      } as never),
    ).toBe("PLY123");
    expect(() =>
      weeklyRosterIdentityKey({ gsisId: null, esbId: null, smartId: null } as never),
    ).toThrow(/stable player identity/u);
  });

  it("fingerprints normalized injury state rather than player names", () => {
    const observation: NflversePlayerInjuryReport = {
      season: 2025,
      week: 5,
      seasonType: "REG",
      gameType: "REG",
      team: "MIA",
      gsisId: "00-0031234",
      position: "QB",
      fullName: "Dan Marino",
      firstName: "Dan",
      lastName: "Marino",
      report: { primaryInjury: "Knee", secondaryInjury: null, status: "questionable" },
      practice: { primaryInjury: "Knee", secondaryInjury: null, status: "limited" },
      dateModified: null,
    };
    expect(injuryReportStateKey(observation)).toMatch(/^[a-f0-9]{64}$/u);
    expect(injuryReportStateKey(observation)).toBe(
      injuryReportStateKey({ ...observation, fullName: "Different Name" }),
    );
    expect(injuryReportStateKey(observation)).not.toBe(
      injuryReportStateKey({
        ...observation,
        report: { primaryInjury: "Knee", secondaryInjury: null, status: "out" },
      }),
    );
  });

  it("stores the shared registry threshold rather than a local literal", () => {
    const stats = datasetMetadata({
      ...metadataInput,
      sourceKey: "nflverse.stats-player-week.2026",
      rowsRead: 100,
      rowsUnmatched: 1,
    });
    const snaps = datasetMetadata({
      ...metadataInput,
      sourceKey: "nflverse.snap-counts.2026",
      rowsRead: 100,
      rowsUnmatched: 1,
    });

    expect(stats.minimumPublishableMatchRate).toBe(0.95);
    expect(snaps.minimumPublishableMatchRate).toBe(0.9);
  });

  it("writes qualityState beside publishable so the health job sees a degraded source", () => {
    const degraded = datasetMetadata({
      ...metadataInput,
      sourceKey: "nflverse.stats-player-week.2026",
      rowsRead: 100,
      rowsUnmatched: 18,
    });
    const admitted = datasetMetadata({
      ...metadataInput,
      sourceKey: "nflverse.stats-player-week.2026",
      rowsRead: 100,
      rowsUnmatched: 1,
    });

    expect(degraded.publishable).toBe(false);
    expect(degraded.qualityState).toBe("degraded");
    expect(admitted.publishable).toBe(true);
    expect(admitted.qualityState).toBe("publishable");
  });

  it("admits a PFR-keyed snap season that the GSIS threshold would quarantine", () => {
    const snaps = datasetMetadata({
      ...metadataInput,
      sourceKey: "nflverse.snap-counts.2026",
      rowsRead: 100,
      rowsUnmatched: 8,
    });

    expect(snaps.matchRate).toBe(0.92);
    expect(snaps.publishable).toBe(true);
    expect(snaps.qualityState).toBe("publishable");
  });
});
