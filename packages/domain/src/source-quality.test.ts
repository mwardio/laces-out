import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOURCE_MATCH_RATE,
  isArchivedNflverseSource,
  isReusableArchivedSourceArtifact,
  sourceMatchRateThreshold,
} from "./source-quality.js";

describe("sourceMatchRateThreshold", () => {
  it("keeps the production 0.95 threshold for GSIS-keyed nflverse datasets", () => {
    expect(DEFAULT_SOURCE_MATCH_RATE).toBe(0.95);
    expect(sourceMatchRateThreshold("nflverse.stats-player-week.2026").minimumMatchRate).toBe(0.95);
    expect(sourceMatchRateThreshold("nflverse.weekly-rosters.2024").minimumMatchRate).toBe(0.95);
    expect(sourceMatchRateThreshold("nflverse.injuries.2026").minimumMatchRate).toBe(0.95);
    expect(sourceMatchRateThreshold("ffc.adp.2026.ppr.12").minimumMatchRate).toBe(0.95);
  });

  it("gives PFR-keyed snap counts their own lower documented threshold", () => {
    const snaps = sourceMatchRateThreshold("nflverse.snap-counts.2026");

    expect(snaps.minimumMatchRate).toBe(0.9);
    expect(snaps.rationale).toMatch(/PFR/u);
  });

  it("matches on the stable key prefix so a new season needs no registry entry", () => {
    expect(sourceMatchRateThreshold("nflverse.stats-player-week.2099")).toEqual(
      sourceMatchRateThreshold("nflverse.stats-player-week.2026"),
    );
  });

  it("falls back to the default rather than leaving an unknown source ungated", () => {
    const unknown = sourceMatchRateThreshold("some.future.source.2026");

    expect(unknown.minimumMatchRate).toBe(DEFAULT_SOURCE_MATCH_RATE);
    expect(unknown.rationale).toMatch(/no source-specific threshold/iu);
  });

  it("never throws on hostile input", () => {
    expect(() => sourceMatchRateThreshold("")).not.toThrow();
    expect(sourceMatchRateThreshold("").minimumMatchRate).toBe(DEFAULT_SOURCE_MATCH_RATE);
  });

  it("keeps every registered threshold inside the publishable range", () => {
    for (const key of [
      "nflverse.stats-player-week.2026",
      "nflverse.stats-team-week.2026",
      "nflverse.weekly-rosters.2026",
      "nflverse.snap-counts.2026",
      "nflverse.injuries.2026",
      "nflverse.schedules.2026",
      "ffc.adp.2026.ppr.12",
    ]) {
      const threshold = sourceMatchRateThreshold(key);

      expect(threshold.minimumMatchRate).toBeGreaterThanOrEqual(0.5);
      expect(threshold.minimumMatchRate).toBeLessThanOrEqual(1);
      expect(threshold.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("completed-season source lifecycle", () => {
  const metadata = {
    season: 2025,
    sourceSchemaVersion: 2,
    availability: "available",
    publishable: true,
  } as const;

  it("archives only completed nflverse seasons", () => {
    expect(isArchivedNflverseSource("nflverse.stats-player-week.2025", metadata, 2026)).toBe(true);
    expect(
      isArchivedNflverseSource(
        "nflverse.stats-player-week.2026",
        { ...metadata, season: 2026 },
        2026,
      ),
    ).toBe(false);
    expect(isArchivedNflverseSource("ffc.adp.2025.ppr.12", metadata, 2026)).toBe(false);
  });

  it("reuses an admitted snapshot until its parser schema changes", () => {
    const input = {
      sourceKey: "nflverse.stats-player-week.2025",
      metadata,
      lastChecksum: "a".repeat(64),
      activeSeason: 2026,
      sourceSchemaVersion: 2,
    } as const;

    expect(isReusableArchivedSourceArtifact(input)).toBe(true);
    expect(isReusableArchivedSourceArtifact({ ...input, sourceSchemaVersion: 3 })).toBe(false);
    expect(isReusableArchivedSourceArtifact({ ...input, lastChecksum: null })).toBe(false);
  });
});
