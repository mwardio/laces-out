import { describe, expect, it } from "vitest";

import { admittedSourceContract, type AdmittedSourceRow } from "./admitted-source.js";
import {
  DATA_QUALITY_LIMITS,
  DataQualityService,
  type DataQualityRepository,
  unresolvedIdentityView,
} from "./data-quality.js";

const week = (season: number, weekNumber: number, unresolvedRows: number) => ({
  season,
  week: weekNumber,
  unresolvedRows,
});

const sampleRow = (weekNumber: number, externalPlayerId: string) => ({
  season: 2026,
  week: weekNumber,
  externalPlayerId,
  team: "KC",
  position: "WR",
});

describe("unresolvedIdentityView", () => {
  it("reports unresolved counts by season and week", () => {
    const view = unresolvedIdentityView({
      weeksRead: [week(2026, 1, 3), week(2026, 2, 1)],
      sampleRead: [sampleRow(1, "00-0033873"), sampleRow(2, "00-0031234")],
    });

    expect(view.weeks.state).toBe("available");
    expect(view.weeks.rows).toEqual([week(2026, 1, 3), week(2026, 2, 1)]);
    expect(view.sample.state).toBe("available");
    expect(view.sample.rows).toHaveLength(2);
  });

  it("withholds the week breakdown instead of truncating it at the cap", () => {
    const weeksRead = Array.from({ length: DATA_QUALITY_LIMITS.unresolvedWeeks }, (_, index) =>
      week(2026, (index % 25) + 1, 1),
    );

    const view = unresolvedIdentityView({ weeksRead, sampleRead: [] });

    expect(view.weeks).toEqual({
      state: "unavailable",
      reason: `The bounded read reached its ${DATA_QUALITY_LIMITS.unresolvedWeeks - 1} row safety limit, so this dataset was withheld.`,
      rows: [],
    });
  });

  it("withholds the sample instead of truncating it at the cap", () => {
    const sampleRead = Array.from({ length: DATA_QUALITY_LIMITS.sampleRows }, (_, index) =>
      sampleRow(1, `00-00${String(index).padStart(5, "0")}`),
    );

    const view = unresolvedIdentityView({ weeksRead: [], sampleRead });

    expect(view.sample.state).toBe("unavailable");
    expect(view.sample.rows).toEqual([]);
  });

  it("reports an unaffected dataset as available with no rows and no reason", () => {
    const view = unresolvedIdentityView({ weeksRead: [], sampleRead: [] });

    expect(view.weeks).toEqual({ state: "available", reason: null, rows: [] });
    expect(view.sample).toEqual({ state: "available", reason: null, rows: [] });
  });

  it("withholds one section without withholding the other", () => {
    const view = unresolvedIdentityView({
      weeksRead: [week(2026, 1, 3)],
      sampleRead: Array.from({ length: DATA_QUALITY_LIMITS.sampleRows }, (_, index) =>
        sampleRow(1, `00-00${String(index).padStart(5, "0")}`),
      ),
    });

    expect(view.weeks.state).toBe("available");
    expect(view.weeks.rows).toHaveLength(1);
    expect(view.sample.state).toBe("unavailable");
  });
});

const sourceRow = (
  key: string,
  matchRate: number,
  publishable: boolean,
  minimumPublishableMatchRate = 0.95,
): AdmittedSourceRow => ({
  id: `id-${key}`,
  key,
  name: key,
  attribution: "nflverse",
  attributionUrl: "https://github.com/nflverse/nflverse-data",
  lastSuccessfulAt: new Date("2026-07-27T06:00:00.000Z"),
  lastChecksum: "a".repeat(64),
  metadata: {
    season: 2026,
    matchRate,
    publishable,
    minimumPublishableMatchRate,
    rowsRead: 1200,
    rowsRejected: 0,
    rowsUnmatched: 216,
  },
});

function repositoryOf(rows: readonly AdmittedSourceRow[]): DataQualityRepository {
  return {
    listSources: () => Promise.resolve(rows),
    findSource: (key) => Promise.resolve(rows.find((row) => row.key === key)),
    listUnresolvedWeeks: () =>
      Promise.resolve([{ season: 2026, week: 3, unresolvedRows: 216 }] as const),
    listUnresolvedSample: () =>
      Promise.resolve([
        { season: 2026, week: 3, externalPlayerId: "00-0033873", team: "KC", position: null },
      ] as const),
  };
}

const now = () => new Date("2026-07-27T12:00:00.000Z");

describe("DataQualityService", () => {
  it("separates a below-threshold source from an admitted one", async () => {
    const service = new DataQualityService(
      repositoryOf([
        sourceRow("nflverse.stats-player-week.2026", 0.82, false),
        sourceRow("nflverse.weekly-rosters.2026", 0.99, true),
      ]),
      now,
    );

    const result = await service.getSourceQuality();

    expect(result.algorithmVersion).toBe("data-quality-v1");
    expect(result.generatedAt).toBe("2026-07-27T12:00:00.000Z");
    expect(result.availability).toEqual({ state: "available", reason: null });
    const [degraded, healthy] = result.sources;
    expect(degraded?.admission).toBe("quarantined");
    expect(degraded?.meetsThreshold).toBe(false);
    expect(degraded?.checksumSha256).toBeNull();
    expect(degraded?.affectedAnalysis.length).toBeGreaterThan(0);
    expect(healthy?.admission).toBe("available");
    expect(healthy?.lifecycle).toBe("active");
    expect(healthy?.meetsThreshold).toBe(true);
    expect(result.degradedSourceKeys).toEqual(["nflverse.stats-player-week.2026"]);
  });

  it("labels completed nflverse datasets as archived snapshots", async () => {
    const completed = sourceRow("nflverse.stats-player-week.2025", 0.99, true);
    const service = new DataQualityService(
      repositoryOf([{ ...completed, metadata: { ...completed.metadata, season: 2025 } }]),
      now,
    );

    const [source] = (await service.getSourceQuality()).sources;

    expect(source?.lifecycle).toBe("archived");
  });

  it("reports the snap threshold that was in force at ingestion, not today's registry value", async () => {
    const service = new DataQualityService(
      repositoryOf([sourceRow("nflverse.snap-counts.2026", 0.92, false, 0.95)]),
      now,
    );

    const [snaps] = (await service.getSourceQuality()).sources;

    expect(snaps?.minimumMatchRate).toBe(0.95);
    expect(snaps?.meetsThreshold).toBe(false);
    expect(snaps?.thresholdRationale).toMatch(/PFR/u);
  });

  it("withholds the whole summary rather than truncating it at the source cap", async () => {
    const rows = Array.from({ length: DATA_QUALITY_LIMITS.sources }, (_, index) =>
      sourceRow(`nflverse.injuries.${2000 + index}`, 0.99, true),
    );
    const service = new DataQualityService(repositoryOf(rows), now);

    const result = await service.getSourceQuality();

    expect(result.availability).toEqual({
      state: "unavailable",
      reason: `The bounded read reached its ${DATA_QUALITY_LIMITS.sources - 1} row safety limit, so source quality was withheld.`,
    });
    expect(result.sources).toEqual([]);
    expect(result.degradedSourceKeys).toEqual([]);
  });

  it("returns undefined for an unknown source key", async () => {
    const service = new DataQualityService(repositoryOf([]), now);

    await expect(
      service.getUnresolvedIdentities("nflverse.injuries.2026"),
    ).resolves.toBeUndefined();
  });

  it("surfaces an unresolved identity with its source and week, redacted", async () => {
    const service = new DataQualityService(
      repositoryOf([sourceRow("nflverse.stats-player-week.2026", 0.82, false)]),
      now,
    );

    const result = await service.getUnresolvedIdentities("nflverse.stats-player-week.2026");

    expect(result?.source.key).toBe("nflverse.stats-player-week.2026");
    expect(result?.weeks.rows).toEqual([{ season: 2026, week: 3, unresolvedRows: 216 }]);
    expect(result?.sample.rows).toEqual([
      { season: 2026, week: 3, externalPlayerId: "00-0033873", team: "KC", position: null },
    ]);
  });

  it("withholds both sections when the source never recorded a season to pin the index", async () => {
    const row = sourceRow("nflverse.stats-player-week.2026", 0.82, false);
    const service = new DataQualityService(
      repositoryOf([{ ...row, metadata: { ...row.metadata, season: null } }]),
      now,
    );

    const result = await service.getUnresolvedIdentities("nflverse.stats-player-week.2026");

    expect(result?.source.season).toBeNull();
    expect(result?.weeks.state).toBe("unavailable");
    expect(result?.sample.state).toBe("unavailable");
    expect(result?.weeks.rows).toEqual([]);
  });
});

describe("match-rate threshold participates in admission", () => {
  const row = (matchRate: number, publishable: boolean): AdmittedSourceRow => ({
    id: "22222222-2222-4222-8222-222222222222",
    key: "nflverse.stats-player-week.2026",
    name: "NFL weekly player stats 2026",
    attribution: "nflverse",
    attributionUrl: "https://github.com/nflverse/nflverse-data",
    lastSuccessfulAt: new Date("2026-07-27T06:00:00.000Z"),
    lastChecksum: "a".repeat(64),
    metadata: { matchRate, publishable, minimumPublishableMatchRate: 0.95, rowsRead: 1200 },
  });

  it("withholds the checksum when the source is below its threshold", () => {
    const contract = admittedSourceContract(
      "weekly-stats",
      "nflverse.stats-player-week.2026",
      "NFL weekly player stats 2026",
      row(0.82, false),
    );

    expect(contract.state).toBe("quarantined");
    expect(contract.checksumSha256).toBeNull();
    expect(contract.reason).toMatch(/identity-quality/u);
  });

  it("admits the source once it clears its threshold", () => {
    const contract = admittedSourceContract(
      "weekly-stats",
      "nflverse.stats-player-week.2026",
      "NFL weekly player stats 2026",
      row(0.99, true),
    );

    expect(contract.state).toBe("available");
    expect(contract.checksumSha256).toBe("a".repeat(64));
  });
});
