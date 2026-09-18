// Conformance-only import of the canonical wire contract, mirroring the pattern
// `apps/api/src/ros-release-status.test.ts` uses against the same package. Keeps this module's known
// reason list from silently drifting from the one `packages/contracts/src/ros-release-status.ts` pins.
import { ROS_WITHHOLDING_REASONS as CONTRACT_ROS_WITHHOLDING_REASONS } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import {
  ROS_WITHHOLDING_REASONS,
  describeRosRelease,
  describeRosLeagueReadiness,
  parseRosReleaseStatus,
  type RosReleaseStatus,
} from "./ros-release-status";

const profile = {
  profileId: "laces-out-historical-ros-full-ppr",
  label: "Full PPR",
  scoringProfileKey: '[{"statId":"receptions","points":1,"bonuses":[]}]',
  digest: "dd74455ddb551d53f68ba9420f4446aebf63e3e8ea34efd24119cc780c47a484",
};

const admittedStatus: RosReleaseStatus = {
  season: 2026,
  modelVersion: "laces-ros-distribution-v7",
  admittedArtifacts: {
    state: "admitted",
    artifacts: [
      {
        scoringProfile: profile,
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
  scoringProfiles: { supported: [profile], unsupported: [] },
  leagueReadiness: [
    {
      leagueSeasonId: "league-1",
      leagueName: "Daragely",
      state: "ready",
      reasons: [],
      scoringProfile: profile,
      positions: [],
    },
  ],
  cellGates: { state: "none", evaluatedAt: null, cells: [] },
  publishedSets: [],
  shadowAudit: { state: "none", latestRun: null },
};

const mixedStatus: RosReleaseStatus = {
  ...admittedStatus,
  cellGates: {
    state: "evaluated",
    evaluatedAt: "2026-10-10T01:00:00.000Z",
    cells: [
      { position: "QB", bucket: "nine-plus", decision: "released", reasons: [] },
      { position: "RB", bucket: "nine-plus", decision: "released", reasons: [] },
      { position: "WR", bucket: "nine-plus", decision: "released", reasons: [] },
      { position: "TE", bucket: "nine-plus", decision: "released", reasons: [] },
      { position: "DST", bucket: "nine-plus", decision: "released", reasons: [] },
      {
        position: "K",
        bucket: "nine-plus",
        decision: "withheld",
        reasons: ["interval-coverage-gate-failed"],
      },
    ],
  },
  publishedSets: [
    {
      projectionSetId: "set-1",
      leagueSeasonId: "league-1",
      leagueName: "Daragely",
      scoringProfile: profile,
      season: 2026,
      playerCount: 210,
      windowStartWeek: 7,
      windowEndWeek: 17,
      asOfWeek: 6,
      fetchedAt: "2026-10-10T01:00:00.000Z",
      inputChecksum: "b".repeat(64),
      championArtifactChecksum: "c".repeat(64),
      retainedFromEarlierRun: true,
    },
  ],
};

describe("league-specific ROS readiness explanations", () => {
  it("shows a never-published league while its exact scoring validation is running", () => {
    const league = {
      ...admittedStatus.leagueReadiness[0]!,
      scoringValidation: {
        state: "validating" as const,
        requestedAt: "2026-09-17T12:00:00Z",
        blockers: [],
      },
    };
    const parsed = parseRosReleaseStatus({ ...admittedStatus, leagueReadiness: [league] });
    expect(parsed?.leagueReadiness[0]?.scoringValidation?.state).toBe("validating");
    expect(describeRosLeagueReadiness(league, false)).toMatchObject({
      heading: "Checking your scoring rules",
      showConnections: false,
    });
  });

  it("shows the affected position and actual unsupported rule without exposing an internal mismatch code", () => {
    const description = describeRosLeagueReadiness(
      {
        ...admittedStatus.leagueReadiness[0]!,
        positions: [
          {
            position: "DST",
            decision: "withheld",
            reasons: ["position-unsupported", "Individual tackles cannot be scored yet."],
          },
          { position: "K", decision: "withheld", reasons: ["scoring-profile-position-mismatch"] },
        ],
      },
      false,
    );
    expect(description.positionMessages).toContain(
      "D/ST: Individual tackles cannot be scored yet.",
    );
    expect(description.positionMessages.join(" ")).not.toContain(
      "scoring-profile-position-mismatch",
    );
  });

  it("keeps another league's failed run from changing this league's readiness copy", () => {
    const description = describeRosLeagueReadiness(admittedStatus.leagueReadiness[0]!, false);
    expect(description.heading).toBe("Waiting for first forecast");
    expect(description.messages.join(" ")).not.toContain("stable results");
  });

  it("directs an account with no synced league to connections and explains retained output honestly", () => {
    const missing = describeRosLeagueReadiness(
      { ...admittedStatus.leagueReadiness[0]!, reasons: ["no-league-synced"], state: "withheld" },
      false,
    );
    expect(missing.showConnections).toBe(true);
    const retained = describeRosLeagueReadiness(
      { ...admittedStatus.leagueReadiness[0]!, reasons: ["stale-source"], state: "withheld" },
      true,
    );
    expect(retained.heading).toBe("Latest approved forecast retained");
    expect(retained.messages.join(" ")).toContain("NFL inputs");
  });
});

describe("shared ROS history preparation", () => {
  const preparation = {
    state: "waiting-source" as const,
    updatedAt: "2026-09-18T12:00:00.000Z",
    nextAttemptAt: "2026-09-18T12:15:00.000Z",
  };
  const waiting = {
    ...admittedStatus.leagueReadiness[0]!,
    scoringValidation: {
      state: "pending" as const,
      requestedAt: preparation.updatedAt,
      blockers: ["shared_corpus_preparing"],
      historyPreparation: preparation,
    },
  };

  it.each([
    ["pending", "Forecast preparation queued"],
    ["building", "Preparing forecast history"],
    ["retry-wait", "Forecast preparation will retry"],
    ["waiting-source", "Waiting for historical data"],
    ["blocked-integrity", "Forecast preparation needs repair"],
    ["ready", "Scoring validation queued"],
  ] as const)("explains %s independently from scoring support", (state, heading) => {
    const league = {
      ...waiting,
      scoringValidation: {
        ...waiting.scoringValidation,
        historyPreparation: { ...preparation, state },
      },
    };
    const parsed = parseRosReleaseStatus({ ...admittedStatus, leagueReadiness: [league] });
    expect(parsed?.leagueReadiness[0]?.scoringValidation?.historyPreparation?.state).toBe(state);
    expect(describeRosLeagueReadiness(parsed!.leagueReadiness[0]!, false)).toMatchObject({
      heading,
      showConnections: false,
    });
    if (state === "waiting-source" || state === "retry-wait") {
      expect(describeRosLeagueReadiness(league, false).messages.join(" ")).toContain(
        "Next automatic retry",
      );
    }
  });

  it("drops malformed additive history details while preserving the league status", () => {
    const parsed = parseRosReleaseStatus({
      ...admittedStatus,
      leagueReadiness: [
        {
          ...waiting,
          scoringValidation: {
            ...waiting.scoringValidation,
            historyPreparation: { ...preparation, nextAttemptAt: "invalid" },
          },
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.leagueReadiness[0]?.scoringValidation?.historyPreparation).toBeUndefined();
  });

  it("does not mislabel a statistical rejection as an operational retry", () => {
    const rejected = {
      ...waiting,
      scoringValidation: { ...waiting.scoringValidation, state: "withheld" as const },
    };
    const description = describeRosLeagueReadiness(rejected, false);
    expect(description.heading).toBe("Scoring validation has not passed");
    expect(description.messages.join(" ")).not.toContain("retry");
  });
});

describe("describeRosRelease", () => {
  it("recognizes an approved exact league profile without a catalog scoring family", () => {
    const exactProfile = { ...profile, profileId: "exact", label: "Exact league scoring" };
    const description = describeRosRelease({
      ...admittedStatus,
      admittedArtifacts: {
        state: "admitted",
        artifacts: [
          { ...admittedStatus.admittedArtifacts.artifacts[0]!, scoringProfile: exactProfile },
        ],
      },
      scoringProfiles: { supported: [exactProfile], unsupported: [] },
    });
    expect(description.artifactHeadline).toBe("Ready for Exact league scoring");
    expect(description.supportedProfileSummary).toContain("1 additional league format");
    expect(description.supportedProfileSummary).not.toContain("No scoring formats");
  });

  it("never calls an admitted, release-capable artifact globally shadow-only", () => {
    const description = describeRosRelease({
      ...admittedStatus,
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

    expect(description.artifactHeadline).toBe("Ready for Full PPR scoring");
    expect(JSON.stringify(description)).not.toMatch(/shadow|globally disabled|fail-closed/iu);
  });

  it("shows the retained last good set when a new cell is withheld", () => {
    const description = describeRosRelease(mixedStatus);

    expect(description.retainedSetNotice).toBe(
      "Some positions did not clear the latest check, so your league keeps the last forecast that did.",
    );
    expect(description.cellSummary).toBe("5 of 6 position groups released");
  });

  it("does not claim a retained set when everything released", () => {
    const description = describeRosRelease({
      ...mixedStatus,
      cellGates: {
        ...mixedStatus.cellGates,
        cells: mixedStatus.cellGates.cells.map((cell) => ({
          ...cell,
          decision: "released" as const,
          reasons: [],
        })),
      },
      publishedSets: mixedStatus.publishedSets.map((set) => ({
        ...set,
        retainedFromEarlierRun: false,
      })),
    });

    expect(description.retainedSetNotice).toBeNull();
    expect(description.cellSummary).toBe("6 of 6 position groups released");
  });

  it("names unsupported scoring profiles instead of implying full coverage", () => {
    const description = describeRosRelease({
      ...admittedStatus,
      scoringProfiles: {
        supported: [profile],
        unsupported: [
          {
            profile: { ...profile, profileId: "standard", label: "Standard (non-PPR)" },
            blockers: ["no_admitted_artifact"],
            evidenceReport: null,
          },
        ],
      },
    });

    expect(description.supportedProfileSummary).toBe("Covers Full PPR scoring");
    expect(description.unsupportedProfileSummary).toBe("Does not cover Standard (non-PPR)");
  });

  it("collapses validated scoring variants into three readable families", () => {
    const description = describeRosRelease({
      ...admittedStatus,
      scoringProfiles: {
        supported: [
          profile,
          { ...profile, profileId: "half-ppr", label: "Half PPR" },
          { ...profile, profileId: "standard", label: "Standard (non-PPR)" },
          {
            ...profile,
            profileId: "espn-standard-2pt",
            label: "Standard + 2-pt, split kicker brackets, XP-missed penalty",
          },
          {
            ...profile,
            profileId: "espn-standard-2pt-nxm",
            label: "Standard + 2-pt, split kicker brackets, no XP-missed penalty",
          },
        ],
        unsupported: [],
      },
    });

    expect(description.supportedProfileSummary).toBe("Covers Half/Full PPR and Standard scoring");
  });

  it("reports no validated model without implying the rail is broken", () => {
    const description = describeRosRelease({
      ...admittedStatus,
      admittedArtifacts: { state: "none", artifacts: [] },
      scoringProfiles: { supported: [], unsupported: [] },
    });

    expect(description.artifactHeadline).toBe("Not ready for this season yet");
    expect(description.supportedProfileSummary).toBe("No scoring formats ready yet");
  });
});

describe("reason list stays in sync with the canonical wire contract", () => {
  it("matches packages/contracts/src/ros-release-status.ts exactly, in order", () => {
    // The pin: the next additive reason lands in the canonical contract first, and this test fails
    // the moment it does — forcing a deliberate label/update here instead of a silent drift that
    // would only surface later as a generic "unrecognized reason" fallback in production.
    expect([...ROS_WITHHOLDING_REASONS]).toEqual([...CONTRACT_ROS_WITHHOLDING_REASONS]);
  });
});

describe("parseRosReleaseStatus", () => {
  it("accepts a well-formed payload and rejects a malformed one", () => {
    expect(parseRosReleaseStatus(JSON.parse(JSON.stringify(mixedStatus)))).not.toBeNull();
    expect(parseRosReleaseStatus(null)).toBeNull();
    expect(parseRosReleaseStatus({ ...admittedStatus, admittedArtifacts: {} })).toBeNull();
  });

  it("rejects a payload carrying the removed collapsed verdict", () => {
    expect(
      parseRosReleaseStatus({ ...admittedStatus, publication: "fail-closed-shadow" }),
    ).toBeNull();
  });

  it("parses a league reporting scoring-rules-unsupported with its per-position readiness", () => {
    const status = {
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: "league-3",
          leagueName: "Daragely",
          state: "withheld",
          reasons: ["scoring-rules-unsupported"],
          scoringProfile: null,
          positions: [
            { position: "QB", decision: "withheld", reasons: ["position-unsupported", "bad"] },
            { position: "RB", decision: "withheld", reasons: ["position-unsupported", "bad"] },
            { position: "WR", decision: "withheld", reasons: ["position-unsupported", "bad"] },
            { position: "TE", decision: "withheld", reasons: ["position-unsupported", "bad"] },
            { position: "K", decision: "withheld", reasons: ["position-unsupported", "bad"] },
            { position: "DST", decision: "withheld", reasons: ["position-unsupported", "bad"] },
          ],
        },
      ],
    };

    const parsed = parseRosReleaseStatus(JSON.parse(JSON.stringify(status)));
    expect(parsed).not.toBeNull();
    expect(parsed?.leagueReadiness[0]?.reasons).toEqual(["scoring-rules-unsupported"]);
    expect(parsed?.leagueReadiness[0]?.positions).toHaveLength(6);
    expect(parsed?.leagueReadiness[0]?.positions.every((p) => p.decision === "withheld")).toBe(
      true,
    );

    // The whole payload (every other league, every other fact) is intact too, not just this league.
    expect(parsed?.admittedArtifacts.state).toBe("admitted");
  });

  it("does not blank the payload when a league reports a reason this module does not yet recognize", () => {
    // Proves genuine forward compatibility: an additive reason value from a newer API that this
    // module has not been updated for yet must not reject the league, or the payload.
    const status = {
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: "league-4",
          leagueName: "Daragely",
          state: "withheld",
          reasons: ["some-brand-new-reason-added-later"],
          scoringProfile: null,
          positions: [],
        },
      ],
    };

    const parsed = parseRosReleaseStatus(JSON.parse(JSON.stringify(status)));
    expect(parsed).not.toBeNull();
    expect(parsed?.leagueReadiness[0]?.reasons).toEqual(["some-brand-new-reason-added-later"]);
  });

  it("drops a malformed position entry instead of rejecting the league or the payload", () => {
    const status = {
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: "league-5",
          leagueName: "Daragely",
          state: "ready",
          reasons: [],
          scoringProfile: profile,
          positions: [
            { position: "QB", decision: "ready", reasons: [] },
            // Malformed: not a recognized position value.
            { position: "PUNTER", decision: "ready", reasons: [] },
            // Malformed: not a recognized decision value.
            { position: "K", decision: "maybe", reasons: [] },
            // Malformed: not an object at all.
            "not-an-object",
          ],
        },
      ],
    };

    const parsed = parseRosReleaseStatus(JSON.parse(JSON.stringify(status)));
    expect(parsed).not.toBeNull();
    expect(parsed?.leagueReadiness[0]?.positions).toEqual([
      { position: "QB", decision: "ready", reasons: [] },
    ]);
  });

  it("defaults positions to [] when the field is entirely absent (an older payload shape)", () => {
    const status = {
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: "league-6",
          leagueName: "Daragely",
          state: "ready",
          reasons: [],
          scoringProfile: profile,
        },
      ],
    };

    const parsed = parseRosReleaseStatus(JSON.parse(JSON.stringify(status)));
    expect(parsed).not.toBeNull();
    expect(parsed?.leagueReadiness[0]?.positions).toEqual([]);
  });
});
