import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
  evaluateFirstPartyRosEvidenceGate,
  firstPartyRosLiveChecksum,
  firstPartyRosShadowIdempotencyKey,
  firstPartyRosWindow,
  planFirstPartyRosShadow,
  type FirstPartyRosWeeklyPin,
  type FirstPartyRosWindow,
} from "./first-party-ros-projections.js";

const futureKickoff = new Date("2026-10-11T17:00:00.000Z");
const now = new Date("2026-10-06T12:00:00.000Z");

function scheduled(week: number, kickoffAt = futureKickoff) {
  return {
    week,
    kickoffAt,
    status: "scheduled" as const,
    awayScore: null,
    homeScore: null,
  };
}

function final(week: number) {
  return {
    week,
    kickoffAt: new Date("2026-10-04T17:00:00.000Z"),
    status: "final" as const,
    awayScore: 17,
    homeScore: 24,
  };
}

const window: FirstPartyRosWindow = {
  currentWeek: 6,
  currentWeekStarted: true,
  asOfWeek: 6,
  windowStartWeek: 7,
  windowEndWeek: 18,
};

function pin(
  week: number,
  checksum = String(week).repeat(64).slice(0, 64),
): FirstPartyRosWeeklyPin {
  return {
    week,
    inputChecksum: checksum,
    qualityState: "publishable",
    playersPublished: 250,
    observationCount: 250,
    sourceAsOf: new Date(`2026-10-${String(Math.min(week, 28)).padStart(2, "0")}T12:00:00.000Z`),
    createdAt: new Date(`2026-10-${String(Math.min(week, 28)).padStart(2, "0")}T12:05:00.000Z`),
  };
}

describe("first-party ROS shadow window", () => {
  it("opens the full regular-season window before Week 1", () => {
    expect(
      firstPartyRosWindow([scheduled(1), scheduled(18)], new Date("2026-08-03T12:00:00Z")),
    ).toEqual({
      currentWeek: 1,
      currentWeekStarted: false,
      asOfWeek: 0,
      windowStartWeek: 1,
      windowEndWeek: 18,
    });
  });

  it("begins with the current week before any game kicks off", () => {
    expect(firstPartyRosWindow([final(1), scheduled(2)], now)).toEqual({
      currentWeek: 2,
      currentWeekStarted: false,
      asOfWeek: 1,
      windowStartWeek: 2,
      windowEndWeek: 18,
    });
  });

  it("moves the window to next week after the first current-week kickoff", () => {
    expect(
      firstPartyRosWindow(
        [
          final(4),
          { ...scheduled(5), kickoffAt: new Date("2026-10-05T00:00:00.000Z") },
          scheduled(5),
          scheduled(6),
        ],
        now,
      ),
    ).toEqual({
      currentWeek: 5,
      currentWeekStarted: true,
      asOfWeek: 5,
      windowStartWeek: 6,
      windowEndWeek: 18,
    });
  });

  it("does not treat a postponed game's stale kickoff as played", () => {
    expect(
      firstPartyRosWindow(
        [
          {
            ...scheduled(7),
            status: "postponed",
            kickoffAt: new Date("2026-10-05T00:00:00.000Z"),
          },
        ],
        now,
      ),
    ).toMatchObject({ windowStartWeek: 7, currentWeekStarted: false, asOfWeek: 6 });
  });

  it("returns no ROS window after Week 18 starts or the season completes", () => {
    expect(
      firstPartyRosWindow(
        [{ ...scheduled(18), kickoffAt: new Date("2026-10-05T00:00:00.000Z") }],
        now,
      ),
    ).toBeNull();
    expect(firstPartyRosWindow([final(18)], now)).toBeNull();
  });
});

describe("first-party ROS shadow evidence", () => {
  it("requires held-out seasons, batches, samples, and calibrated intervals", () => {
    expect(
      evaluateFirstPartyRosEvidenceGate({
        heldOutSeasons: 2,
        batches: 29,
        samples: 299,
        calibratedIntervals: false,
      }),
    ).toMatchObject({
      cleared: false,
      reasons: [
        "held_out_seasons_below_minimum",
        "held_out_batches_below_minimum",
        "held_out_samples_below_minimum",
        "prediction_intervals_not_calibrated",
      ],
    });
    expect(
      evaluateFirstPartyRosEvidenceGate({
        heldOutSeasons: 3,
        batches: 30,
        samples: 300,
        calibratedIntervals: true,
      }).cleared,
    ).toBe(true);
  });

  it("keeps the service shadow-only even when the evidence gate clears", () => {
    const weeklyPins = Array.from({ length: 12 }, (_, index) => pin(index + 7));
    expect(
      planFirstPartyRosShadow({
        window,
        scheduleFresh: true,
        weeklySourcePresent: true,
        weeklySourceFresh: true,
        weeklyPins,
        evidence: {
          heldOutSeasons: 3,
          batches: 30,
          samples: 300,
          calibratedIntervals: true,
        },
        candidatePairsPersisted: true,
      }),
    ).toMatchObject({
      qualityState: "degraded",
      canEvaluatePlayers: true,
      canPublish: false,
      missingWeeks: [],
      diagnostics: ["shadow_publication_disabled"],
    });
  });

  it("fails closed with actionable diagnostics instead of inventing missing candidates", () => {
    const plan = planFirstPartyRosShadow({
      window,
      scheduleFresh: true,
      weeklySourcePresent: true,
      weeklySourceFresh: true,
      weeklyPins: [pin(7)],
      evidence: {
        heldOutSeasons: 0,
        batches: 0,
        samples: 0,
        calibratedIntervals: false,
      },
      candidatePairsPersisted: false,
    });
    expect(plan).toMatchObject({
      qualityState: "degraded",
      canEvaluatePlayers: false,
      canPublish: false,
      missingWeeks: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    });
    for (const diagnostic of [
      "weekly_projection_window_incomplete",
      "weekly_candidate_pairs_not_persisted",
      "held_out_seasons_below_minimum",
      "prediction_intervals_not_calibrated",
      "shadow_publication_disabled",
    ]) {
      expect(plan.diagnostics).toContain(diagnostic);
    }
  });
});

describe("first-party ROS live checksum", () => {
  it("is deterministic across weekly pin order and changes with a pinned input", () => {
    const base = {
      season: 2026,
      window,
      schedule: { sourceKey: "nflverse.schedules.2026", checksum: "a".repeat(64) },
      weeklySource: {
        sourceKey: "laces-out.projections.first-party",
        checksum: "b".repeat(64),
      },
      weeklyPins: [pin(8), pin(7)],
      championArtifacts: [
        { scoringProfileKey: "profile-b", artifactChecksum: "d".repeat(64) },
        { scoringProfileKey: "profile-a", artifactChecksum: "c".repeat(64) },
      ],
      publicationScopeChecksum: "e".repeat(64),
      candidateProviderChecksum: "f".repeat(64),
      evidence: {
        heldOutSeasons: 0,
        batches: 0,
        samples: 0,
        calibratedIntervals: false,
      },
      gateInputs: {
        scheduleFresh: true,
        candidateSourceFresh: true,
        weeklySourcePresent: true,
        weeklySourceFresh: true,
        candidatePairsPersisted: false,
      },
    } as const;
    const checksum = firstPartyRosLiveChecksum(base);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstPartyRosLiveChecksum({ ...base, weeklyPins: [...base.weeklyPins].reverse() })).toBe(
      checksum,
    );
    expect(
      firstPartyRosLiveChecksum({
        ...base,
        championArtifacts: [...base.championArtifacts].reverse(),
      }),
    ).toBe(checksum);
    expect(
      firstPartyRosLiveChecksum({
        ...base,
        weeklyPins: [pin(7), pin(8, "c".repeat(64))],
      }),
    ).not.toBe(checksum);
    expect(
      firstPartyRosLiveChecksum({
        ...base,
        gateInputs: { ...base.gateInputs, candidatePairsPersisted: true },
      }),
    ).not.toBe(checksum);
    expect(
      firstPartyRosLiveChecksum({
        ...base,
        championArtifacts: [
          ...base.championArtifacts.slice(0, 1),
          { ...base.championArtifacts[1], artifactChecksum: "f".repeat(64) },
        ],
      }),
    ).not.toBe(checksum);
    expect(
      firstPartyRosLiveChecksum({ ...base, publicationScopeChecksum: "0".repeat(64) }),
    ).not.toBe(checksum);
    expect(
      firstPartyRosLiveChecksum({ ...base, candidateProviderChecksum: "1".repeat(64) }),
    ).not.toBe(checksum);
    expect(
      firstPartyRosShadowIdempotencyKey({ season: 2026, window, inputChecksum: checksum }),
    ).toContain(":rest-of-season:2026:7-18:asof-6:");
    expect(FIRST_PARTY_ROS_SHADOW_MODEL_VERSION).toContain("shadow-rail");
  });
});
