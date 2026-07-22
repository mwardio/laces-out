import { describe, expect, it } from "vitest";

import {
  deriveRunAudit,
  derivePublication,
  latestPublishedSetPerLeague,
  type RosModelRunRow,
} from "./ros-projection-status.js";

function shadowRun(overrides: Partial<RosModelRunRow> = {}): RosModelRunRow {
  return {
    sourceSyncRunId: "20000000-0000-4000-8000-000000000001",
    qualityState: "degraded",
    season: 2026,
    windowStartWeek: 6,
    windowEndWeek: 18,
    asOfWeek: 5,
    asOfAt: new Date("2026-10-10T00:00:00.000Z"),
    playersEvaluated: 0,
    playersPublished: 0,
    inputChecksum: "c".repeat(64),
    configuration: { mode: "shadow" },
    metrics: {
      diagnostics: ["weekly_projection_window_incomplete", "shadow_publication_disabled"],
      gate: { cleared: false },
    },
    sourceAsOf: new Date("2026-10-09T00:00:00.000Z"),
    createdAt: new Date("2026-10-10T01:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveRunAudit", () => {
  it("surfaces shadow diagnostics as reasons and never permits publication", () => {
    const audit = deriveRunAudit(shadowRun());
    expect(audit.mode).toBe("shadow");
    expect(audit.canPublish).toBe(false);
    expect(audit.reasons).toContain("shadow_publication_disabled");
    expect(audit.evidenceGate).toEqual({ cleared: false });
    expect(audit.asOfAt).toBe("2026-10-10T00:00:00.000Z");
  });

  it("reads withheld reasons from a release run and only publishes a populated release", () => {
    const audit = deriveRunAudit(
      shadowRun({
        qualityState: "publishable",
        playersPublished: 200,
        playersEvaluated: 200,
        configuration: { mode: "release" },
        metrics: { withheldReasons: ["ros_release_gate_withheld"], releasingBuckets: 3 },
      }),
    );
    expect(audit.mode).toBe("release");
    expect(audit.canPublish).toBe(true);
    expect(audit.reasons).toEqual(["ros_release_gate_withheld"]);
  });

  it("does not publish a release with zero published players", () => {
    const audit = deriveRunAudit(
      shadowRun({
        qualityState: "publishable",
        playersPublished: 0,
        configuration: { mode: "release" },
        metrics: {},
      }),
    );
    expect(audit.canPublish).toBe(false);
    expect(audit.reasons).toEqual([]);
  });
});

describe("derivePublication", () => {
  it("is fail-closed shadow with no publishable run and no sets", () => {
    expect(derivePublication({ latestRun: null, publishedSetCount: 0 })).toBe("fail-closed-shadow");
    expect(
      derivePublication({ latestRun: deriveRunAudit(shadowRun()), publishedSetCount: 0 }),
    ).toBe("fail-closed-shadow");
  });

  it("is publishable when a set exists or the latest run released", () => {
    expect(derivePublication({ latestRun: null, publishedSetCount: 1 })).toBe("publishable");
    const released = deriveRunAudit(
      shadowRun({
        qualityState: "publishable",
        playersPublished: 5,
        configuration: { mode: "release" },
        metrics: {},
      }),
    );
    expect(derivePublication({ latestRun: released, publishedSetCount: 0 })).toBe("publishable");
  });
});

describe("latestPublishedSetPerLeague", () => {
  it("keeps only the most recent set per league and exposes provenance without values", () => {
    const older = {
      projectionSetId: "30000000-0000-4000-8000-000000000001",
      leagueSeasonId: "40000000-0000-4000-8000-000000000001",
      source: "laces-out-first-party-ros",
      version: "v-old",
      season: 2026,
      playerCount: 100,
      windowStartWeek: 5,
      windowEndWeek: 18,
      asOfWeek: 4,
      asOfAt: new Date("2026-10-03T00:00:00.000Z"),
      fetchedAt: new Date("2026-10-03T01:00:00.000Z"),
      inputChecksum: "d".repeat(64),
      metadata: { championArtifactChecksum: "a".repeat(64), scoringProfileKey: "ppr-standard" },
      createdAt: new Date("2026-10-03T01:00:00.000Z"),
    };
    const newer = {
      ...older,
      projectionSetId: "30000000-0000-4000-8000-000000000002",
      version: "v-new",
      playerCount: 213,
      fetchedAt: new Date("2026-10-10T01:00:00.000Z"),
      createdAt: new Date("2026-10-10T01:00:00.000Z"),
    };
    const otherLeague = {
      ...older,
      projectionSetId: "30000000-0000-4000-8000-000000000003",
      leagueSeasonId: "40000000-0000-4000-8000-000000000002",
      metadata: {},
    };

    const result = latestPublishedSetPerLeague([older, newer, otherLeague]);
    expect(result).toHaveLength(2);
    const primary = result.find(
      (set) => set.leagueSeasonId === "40000000-0000-4000-8000-000000000001",
    );
    expect(primary?.projectionSetId).toBe("30000000-0000-4000-8000-000000000002");
    expect(primary?.playerCount).toBe(213);
    expect(primary?.championArtifactChecksum).toBe("a".repeat(64));
    const other = result.find(
      (set) => set.leagueSeasonId === "40000000-0000-4000-8000-000000000002",
    );
    expect(other?.championArtifactChecksum).toBeNull();
    expect(other?.scoringProfileKey).toBeNull();
  });

  it("ignores rows without a league season", () => {
    const orphan = {
      projectionSetId: "30000000-0000-4000-8000-000000000009",
      leagueSeasonId: null,
      source: "laces-out-first-party-ros",
      version: "v",
      season: 2026,
      playerCount: 1,
      windowStartWeek: 6,
      windowEndWeek: 18,
      asOfWeek: 5,
      asOfAt: null,
      fetchedAt: new Date("2026-10-10T01:00:00.000Z"),
      inputChecksum: "d".repeat(64),
      metadata: null,
      createdAt: new Date("2026-10-10T01:00:00.000Z"),
    };
    expect(latestPublishedSetPerLeague([orphan])).toHaveLength(0);
  });
});
