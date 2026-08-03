import { describe, expect, it } from "vitest";

import {
  ROS_WITHHOLDING_REASONS,
  parseRosReleaseStatus,
  rosReleaseStatusSchema,
} from "./ros-release-status.js";

const fullPprProfile = {
  profileId: "laces-out-historical-ros-full-ppr",
  label: "Full PPR",
  scoringProfileKey: '[{"statId":"receptions","points":1,"bonuses":[]}]',
  digest: "dd74455ddb551d53f68ba9420f4446aebf63e3e8ea34efd24119cc780c47a484",
};

const status = {
  season: 2026,
  modelVersion: "laces-ros-distribution-v7",
  admittedArtifacts: {
    state: "admitted",
    artifacts: [
      {
        scoringProfile: fullPprProfile,
        season: 2026,
        modelVersion: "laces-ros-distribution-v7",
        policyVersion: "season-walk-forward-block-wis-cqr-v4",
        calibrationVersion: "season-blocked-split-conformal-cqr-v1",
        evidenceThroughSeason: 2025,
        artifactChecksum: "67e7ba0945444df5b43dff75f5073721f10e3aa092c49723b88ac09d3e655d5d",
        admittedAt: "2026-07-23T13:33:21.912Z",
        sourceChecksumCount: 42,
      },
    ],
  },
  scoringProfiles: {
    supported: [fullPprProfile],
    unsupported: [
      {
        profile: {
          profileId: "laces-out-historical-ros-standard",
          label: "Standard (non-PPR)",
          scoringProfileKey: '[{"statId":"receptions","points":0,"bonuses":[]}]',
          digest: "a".repeat(64),
        },
        blockers: ["report_global_blockers_present"],
        evidenceReport: "reports/ros-validation-v8-standard-2026-07-27.json",
      },
    ],
  },
  leagueReadiness: [],
  cellGates: { state: "none", evaluatedAt: null, cells: [] },
  publishedSets: [],
  shadowAudit: { state: "none", latestRun: null },
};

describe("rosReleaseStatusSchema", () => {
  it("accepts a fully separated status", () => {
    const parsed = parseRosReleaseStatus(JSON.parse(JSON.stringify(status)));

    expect(parsed?.admittedArtifacts.state).toBe("admitted");
    expect(parsed?.admittedArtifacts.artifacts[0]?.scoringProfile.label).toBe("Full PPR");
    expect(parsed?.scoringProfiles.supported).toHaveLength(1);
    expect(parsed?.scoringProfiles.unsupported[0]?.evidenceReport).toBe(
      "reports/ros-validation-v8-standard-2026-07-27.json",
    );
    expect(parsed?.shadowAudit.state).toBe("none");
  });

  it("accepts more supported and unsupported scoring profiles than the catalog carries today", () => {
    // `deriveScoringProfileCoverage` (apps/api) splits every catalog entry into `supported` or
    // `unsupported`, so the two arrays together always equal the catalog size — a small,
    // hand-curated list that nonetheless grows over time (3 -> 5 this session alone). The bound
    // must stay generous headroom rather than tracking today's count, or catalog growth alone
    // (with no per-request or per-evidence blowup) starts rejecting real payloads.
    const manyProfiles = Array.from({ length: 20 }, (_unused, index) => ({
      ...fullPprProfile,
      profileId: `${fullPprProfile.profileId}-${index}`,
      digest: "a".repeat(64),
    }));

    const parsed = parseRosReleaseStatus({
      ...status,
      scoringProfiles: {
        supported: manyProfiles,
        unsupported: manyProfiles.map((profile) => ({
          profile,
          blockers: ["no_admitted_artifact"],
          evidenceReport: null,
        })),
      },
    });

    expect(parsed?.scoringProfiles.supported).toHaveLength(20);
    expect(parsed?.scoringProfiles.unsupported).toHaveLength(20);
  });

  it("never exposes a single collapsed release verdict", () => {
    const shape = Object.keys(rosReleaseStatusSchema.shape);

    for (const forbidden of ["publication", "released", "ready", "healthy", "state", "status"]) {
      expect(shape).not.toContain(forbidden);
    }
    expect(shape).toEqual([
      "season",
      "modelVersion",
      "admittedArtifacts",
      "scoringProfiles",
      "leagueReadiness",
      "cellGates",
      "publishedSets",
      "shadowAudit",
    ]);
  });

  it("keeps the shadow audit independent of every other field", () => {
    const parsed = parseRosReleaseStatus({
      ...JSON.parse(JSON.stringify(status)),
      shadowAudit: {
        state: "recorded",
        latestRun: {
          sourceSyncRunId: "run-1",
          mode: "shadow",
          qualityState: "degraded",
          createdAt: "2026-07-27T00:00:00.000Z",
          reasons: ["shadow_publication_disabled"],
        },
      },
    });

    expect(parsed?.shadowAudit.state).toBe("recorded");
    expect(parsed?.admittedArtifacts.state).toBe("admitted");
    expect(parsed?.admittedArtifacts.artifacts).toHaveLength(1);
  });

  it("carries mixed per-cell gate decisions with their own reasons", () => {
    const parsed = parseRosReleaseStatus({
      ...JSON.parse(JSON.stringify(status)),
      cellGates: {
        state: "evaluated",
        evaluatedAt: "2026-07-27T00:00:00.000Z",
        cells: [
          { position: "RB", bucket: "one-to-four", decision: "released", reasons: [] },
          {
            position: "K",
            bucket: "one-to-four",
            decision: "withheld",
            reasons: ["non-converged-cell"],
          },
        ],
      },
    });

    expect(parsed?.cellGates.cells.map((cell) => cell.decision)).toEqual(["released", "withheld"]);
    expect(parsed?.cellGates.cells[1]?.reasons).toEqual(["non-converged-cell"]);
  });

  it("marks a published set that is retained from an earlier good run", () => {
    const parsed = parseRosReleaseStatus({
      ...JSON.parse(JSON.stringify(status)),
      publishedSets: [
        {
          projectionSetId: "set-1",
          leagueSeasonId: "league-1",
          leagueName: "Daragely",
          scoringProfile: fullPprProfile,
          season: 2026,
          playerCount: 210,
          windowStartWeek: 7,
          windowEndWeek: 17,
          asOfWeek: 6,
          fetchedAt: "2026-10-01T00:00:00.000Z",
          inputChecksum: "b".repeat(64),
          championArtifactChecksum: "c".repeat(64),
          retainedFromEarlierRun: true,
        },
      ],
    });

    expect(parsed?.publishedSets[0]?.retainedFromEarlierRun).toBe(true);
    expect(parsed?.publishedSets[0]?.playerCount).toBe(210);
  });

  it("enumerates exactly the eight structured withholding reasons", () => {
    expect([...ROS_WITHHOLDING_REASONS]).toEqual([
      "scoring-rules-unsupported",
      "no-admitted-scoring-profile",
      "incomplete-schedule",
      "missing-roster-snapshot",
      "insufficient-candidate-inputs",
      "non-converged-cell",
      "stale-source",
      "no-league-synced",
    ]);
  });

  it("returns null on a malformed payload instead of throwing", () => {
    expect(parseRosReleaseStatus(null)).toBeNull();
    expect(parseRosReleaseStatus("not an object")).toBeNull();
    expect(parseRosReleaseStatus({ ...status, season: 1900 })).toBeNull();
    expect(
      parseRosReleaseStatus({
        ...status,
        leagueReadiness: [
          {
            leagueSeasonId: "league-1",
            leagueName: "Daragely",
            state: "withheld",
            reasons: ["invented-reason"],
            scoringProfile: null,
            positions: [],
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects an unbounded collection rather than truncating it", () => {
    expect(
      parseRosReleaseStatus({
        ...status,
        leagueReadiness: Array.from({ length: 65 }, (_unused, index) => ({
          leagueSeasonId: `league-${index}`,
          leagueName: `League ${index}`,
          state: "ready",
          reasons: [],
          scoringProfile: null,
          positions: [],
        })),
      }),
    ).toBeNull();
  });
});
