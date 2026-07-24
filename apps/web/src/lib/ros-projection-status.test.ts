import { describe, expect, it } from "vitest";

import {
  describeRosProjectionRail,
  humanizeRosReason,
  parseRosProjectionStatus,
  type RosProjectionStatus,
} from "./ros-projection-status";

const shadowStatus: RosProjectionStatus = {
  season: 2026,
  modelVersion: "laces-ros-distribution-v4",
  publication: "fail-closed-shadow",
  artifact: { present: false },
  latestRun: {
    sourceSyncRunId: "20000000-0000-4000-8000-000000000001",
    mode: "shadow",
    qualityState: "degraded",
    canPublish: false,
    season: 2026,
    windowStartWeek: 6,
    windowEndWeek: 18,
    asOfWeek: 5,
    asOfAt: "2026-10-10T00:00:00.000Z",
    playersEvaluated: 0,
    playersPublished: 0,
    reasons: ["weekly_projection_window_incomplete", "shadow_publication_disabled"],
    evidenceGate: { cleared: false },
    inputChecksum: "c".repeat(64),
    sourceAsOf: "2026-10-09T00:00:00.000Z",
    createdAt: "2026-10-10T01:00:00.000Z",
  },
  publishedSets: [],
};

describe("parseRosProjectionStatus", () => {
  it("accepts a well-formed shadow payload", () => {
    const parsed = parseRosProjectionStatus(JSON.parse(JSON.stringify(shadowStatus)));
    expect(parsed).not.toBeNull();
    expect(parsed?.publication).toBe("fail-closed-shadow");
    expect(parsed?.artifact.present).toBe(false);
  });

  it("accepts a present artifact and a published set", () => {
    const payload = {
      ...shadowStatus,
      publication: "publishable",
      artifact: {
        present: true,
        season: 2026,
        scoringProfileKey: "ppr-standard",
        modelVersion: "laces-ros-distribution-v4",
        policyVersion: "policy-v1",
        calibrationVersion: "calibration-v1",
        evidenceThroughSeason: 2025,
        artifactChecksum: "a".repeat(64),
        sourceChecksums: [{ key: "nflverse.schedules.2026", checksum: "b".repeat(64) }],
        admittedAt: "2026-07-01T00:00:00.000Z",
      },
      latestRun: null,
      publishedSets: [
        {
          projectionSetId: "30000000-0000-4000-8000-000000000001",
          leagueSeasonId: "40000000-0000-4000-8000-000000000001",
          source: "laces-out-first-party-ros",
          version: "v",
          season: 2026,
          playerCount: 213,
          windowStartWeek: 6,
          windowEndWeek: 18,
          asOfWeek: 5,
          asOfAt: "2026-10-10T00:00:00.000Z",
          fetchedAt: "2026-10-10T01:00:00.000Z",
          inputChecksum: "d".repeat(64),
          championArtifactChecksum: "a".repeat(64),
          scoringProfileKey: "ppr-standard",
          createdAt: "2026-10-10T01:00:00.000Z",
        },
      ],
    };
    const parsed = parseRosProjectionStatus(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.publishedSets[0]?.playerCount).toBe(213);
  });

  it("rejects malformed payloads", () => {
    expect(parseRosProjectionStatus(null)).toBeNull();
    expect(parseRosProjectionStatus({ season: 2026 })).toBeNull();
    expect(parseRosProjectionStatus({ ...shadowStatus, publication: "released" })).toBeNull();
    expect(parseRosProjectionStatus({ ...shadowStatus, latestRun: { mode: "shadow" } })).toBeNull();
  });
});

describe("describeRosProjectionRail", () => {
  it("marks the rail shadow-only with plain-language reasons when fail-closed", () => {
    const description = describeRosProjectionRail(shadowStatus);
    expect(description.isShadow).toBe(true);
    expect(description.statusLabel).toBe("Fail-closed shadow");
    expect(description.artifactPresent).toBe(false);
    expect(description.reasons.map((reason) => reason.label)).toContain(
      "Publication is intentionally disabled; shadow evidence only.",
    );
    expect(description.lastEvaluatedIso).toBe("2026-10-10T01:00:00.000Z");
    expect(description.lastPublishedIso).toBeNull();
    expect(description.publishedLeagueCount).toBe(0);
  });

  it("summarizes published counts and the newest publish time when publishable", () => {
    const description = describeRosProjectionRail({
      ...shadowStatus,
      publication: "publishable",
      latestRun: null,
      publishedSets: [
        {
          projectionSetId: "s1",
          leagueSeasonId: "l1",
          source: "laces-out-first-party-ros",
          version: "v1",
          season: 2026,
          playerCount: 100,
          windowStartWeek: 6,
          windowEndWeek: 18,
          asOfWeek: 5,
          asOfAt: null,
          fetchedAt: "2026-10-03T01:00:00.000Z",
          inputChecksum: "d".repeat(64),
          championArtifactChecksum: null,
          scoringProfileKey: null,
          createdAt: "2026-10-03T01:00:00.000Z",
        },
        {
          projectionSetId: "s2",
          leagueSeasonId: "l2",
          source: "laces-out-first-party-ros",
          version: "v2",
          season: 2026,
          playerCount: 113,
          windowStartWeek: 6,
          windowEndWeek: 18,
          asOfWeek: 5,
          asOfAt: null,
          fetchedAt: "2026-10-10T01:00:00.000Z",
          inputChecksum: "e".repeat(64),
          championArtifactChecksum: null,
          scoringProfileKey: null,
          createdAt: "2026-10-10T01:00:00.000Z",
        },
      ],
    });
    expect(description.isShadow).toBe(false);
    expect(description.statusLabel).toBe("Publishable");
    expect(description.publishedLeagueCount).toBe(2);
    expect(description.publishedPlayerCount).toBe(213);
    expect(description.lastPublishedIso).toBe("2026-10-10T01:00:00.000Z");
  });
});

describe("humanizeRosReason", () => {
  it("humanizes unknown codes", () => {
    expect(humanizeRosReason("some_new_worker_diagnostic")).toBe("Some New Worker Diagnostic");
  });
});
