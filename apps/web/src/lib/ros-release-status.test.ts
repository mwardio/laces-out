// Conformance-only import of the canonical wire contract, mirroring the pattern
// `apps/api/src/ros-release-status.test.ts` uses against the same package. Keeps this module's known
// reason list from silently drifting from the one `packages/contracts/src/ros-release-status.ts` pins.
import { ROS_WITHHOLDING_REASONS as CONTRACT_ROS_WITHHOLDING_REASONS } from "@fantasy/contracts";
import { describe, expect, it } from "vitest";

import {
  ROS_WITHHOLDING_REASONS,
  describeRosRelease,
  humanizeRosWithholdingReason,
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

const withheldStatus: RosReleaseStatus = {
  ...admittedStatus,
  leagueReadiness: [
    {
      leagueSeasonId: "league-2",
      state: "withheld",
      reasons: ["no-admitted-scoring-profile", "incomplete-schedule"],
      scoringProfile: null,
      positions: [],
    },
  ],
};

describe("describeRosRelease", () => {
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

    expect(description.artifactHeadline).toBe("Validated model in use for Full PPR scoring");
    expect(description.auditHeadline).toBe("Separate audit run, not a release signal");
    expect(JSON.stringify(description)).not.toMatch(/shadow|globally disabled|fail-closed/iu);
  });

  it("shows the retained last good set when a new cell is withheld", () => {
    const description = describeRosRelease(mixedStatus);

    expect(description.retainedSetNotice).toBe(
      "Some positions were withheld on the latest check. The last set that passed every check stays in place for your league.",
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

  it("reports withheld leagues with plain-language reasons in a stable order", () => {
    const description = describeRosRelease(withheldStatus);

    expect(description.leagueNotices).toEqual([
      "Your league's scoring rules are not one of the validated profiles.",
      "The NFL schedule for the remaining weeks is not complete yet.",
    ]);
  });

  it("says plainly when no league has been synced", () => {
    const description = describeRosRelease({
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: null,
          state: "withheld",
          reasons: ["no-league-synced"],
          scoringProfile: null,
          positions: [],
        },
      ],
    });

    expect(description.leagueNotices).toEqual([
      "No league has been synced yet, so there is nothing to forecast for.",
    ]);
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

    expect(description.supportedProfileSummary).toBe("Validated for Full PPR");
    expect(description.unsupportedProfileSummary).toBe("Not validated for Standard (non-PPR)");
  });

  it("reports no validated model without implying the rail is broken", () => {
    const description = describeRosRelease({
      ...admittedStatus,
      admittedArtifacts: { state: "none", artifacts: [] },
      scoringProfiles: { supported: [], unsupported: [] },
    });

    expect(description.artifactHeadline).toBe("No validated model for this season yet");
    expect(description.supportedProfileSummary).toBe("No scoring profile is validated yet");
  });

  it("summarizes a league's own per-position readiness, with a title only for withheld positions", () => {
    const description = describeRosRelease({
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: "league-9",
          state: "withheld",
          reasons: ["no-admitted-scoring-profile"],
          scoringProfile: null,
          positions: [
            { position: "QB", decision: "ready", reasons: [] },
            { position: "RB", decision: "ready", reasons: [] },
            { position: "WR", decision: "ready", reasons: [] },
            { position: "TE", decision: "ready", reasons: [] },
            {
              position: "K",
              decision: "withheld",
              reasons: ["position-unsupported", "No stored league scoring rules were available."],
            },
            {
              position: "DST",
              decision: "withheld",
              reasons: ["scoring-profile-position-mismatch"],
            },
          ],
        },
      ],
    });

    expect(description.leaguePositionSummaries).toEqual([
      {
        leagueSeasonId: "league-9",
        positions: [
          { position: "QB", decision: "ready", title: null },
          { position: "RB", decision: "ready", title: null },
          { position: "WR", decision: "ready", title: null },
          { position: "TE", decision: "ready", title: null },
          { position: "K", decision: "withheld", title: "position-unsupported" },
          { position: "DST", decision: "withheld", title: "scoring-profile-position-mismatch" },
        ],
      },
    ]);
  });

  it("omits a league that reported no per-position readiness at all", () => {
    // `admittedStatus`'s one league carries `positions: []` (an older payload shape, or the
    // no-league-synced placeholder) — nothing to render a chip row for.
    const description = describeRosRelease(admittedStatus);

    expect(description.leaguePositionSummaries).toEqual([]);
  });
});

describe("humanizeRosWithholdingReason", () => {
  it("renders every structured reason as a sentence", () => {
    for (const reason of ROS_WITHHOLDING_REASONS) {
      const label = humanizeRosWithholdingReason(reason);
      expect(label.endsWith(".")).toBe(true);
      expect(label).not.toMatch(/shadow|fail-closed/iu);
    }
  });

  it("renders a reason this module does not yet recognize instead of returning undefined", () => {
    // Forward compatibility: a future additive reason the API emits before this module is updated
    // for it must still render something readable, not `undefined` or an empty string.
    const label = humanizeRosWithholdingReason("some-future-reason-not-yet-named");
    expect(label).toBe("Some future reason not yet named.");
    expect(label.endsWith(".")).toBe(true);
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

    const description = describeRosRelease(parsed!);
    expect(description.leagueNotices).toEqual([
      "Your league's scoring rules could not be matched to any position at all.",
    ]);
  });

  it("does not blank the payload when a league reports a reason this module does not yet recognize", () => {
    // Proves genuine forward compatibility: an additive reason value from a newer API that this
    // module has not been updated for yet must not reject the league, or the payload.
    const status = {
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: "league-4",
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

    const description = describeRosRelease(parsed!);
    expect(description.leagueNotices).toEqual(["Some brand new reason added later."]);
  });

  it("drops a malformed position entry instead of rejecting the league or the payload", () => {
    const status = {
      ...admittedStatus,
      leagueReadiness: [
        {
          leagueSeasonId: "league-5",
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
        { leagueSeasonId: "league-6", state: "ready", reasons: [], scoringProfile: profile },
      ],
    };

    const parsed = parseRosReleaseStatus(JSON.parse(JSON.stringify(status)));
    expect(parsed).not.toBeNull();
    expect(parsed?.leagueReadiness[0]?.positions).toEqual([]);
  });
});
