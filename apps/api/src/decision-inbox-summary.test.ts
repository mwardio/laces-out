import {
  decisionInboxResponseSchema,
  decisionInboxStateRequestSchema,
  decisionInboxStateResponseSchema,
  inSeasonDecisionSnapshotSchema,
  type DecisionPlayer,
  type InSeasonDecisionSnapshot,
} from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import { buildDecisionInboxSummary } from "./decision-inbox-summary.js";

const NOW = "2026-09-15T12:00:00.000Z";
const LATER = "2026-09-15T12:05:00.000Z";
const id = (number: number) => `70000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const execution = {
  mode: "provider-required" as const,
  provider: "espn" as const,
  label: "Apply on ESPN",
  url: "https://fantasy.espn.com/football/league?leagueId=123",
};
const unavailable = {
  state: "unavailable" as const,
  reasons: [
    { code: "PROJECTIONS_MISSING" as const, message: "Compatible projections are missing." },
  ],
};

function player(number: number, projectedPoints = 12): DecisionPlayer {
  return {
    id: id(number),
    name: `Player ${number}`,
    positions: ["WR"],
    nflTeam: "CHI",
    status: "ACTIVE",
    projectedPoints,
  };
}

function lineup(): Extract<InSeasonDecisionSnapshot["lineup"], { state: "available" }> {
  return {
    state: "available",
    metric: "mean",
    feasible: true,
    currentProjectedPoints: 100,
    optimalProjectedPoints: 108,
    projectedGain: 8,
    assignments: [
      { slotId: "WR", slotLabel: "WR", player: player(1, 20), locked: false },
      { slotId: "FLEX", slotLabel: "FLEX", player: player(2, 15), locked: false },
    ],
    changes: [
      {
        slotId: "WR",
        slotLabel: "WR",
        add: player(1, 20),
        remove: player(2, 15),
        projectedPointDelta: 5,
      },
      {
        slotId: "FLEX",
        slotLabel: "FLEX",
        add: player(2, 15),
        remove: player(3, 12),
        projectedPointDelta: 3,
      },
    ],
    execution,
    notes: ["Stored true locks were honored."],
  };
}

function waivers(
  gains = [4, 7, 0, -2, 6, 5],
): Extract<InSeasonDecisionSnapshot["waivers"], { state: "available" }> {
  const drop = player(3);
  return {
    state: "available",
    candidateCount: gains.length,
    evaluatedMoveCount: gains.length,
    dropCandidates: [drop],
    recommendations: gains.map((gain, index) => ({
      add: player(20 + index),
      drop,
      weightedGain: gain,
      lineupGain: gain / 2,
      faab: { low: 2, recommended: 5, high: 8 },
      market: null,
      rationale: `Player ${20 + index} improves modeled roster value.`,
      dropComparisons: [
        {
          dropPlayerId: drop.id,
          weightedGain: gain,
          lineupGain: gain / 2,
          faab: { low: 2, recommended: 5, high: 8 },
        },
      ],
    })),
    execution,
    restOfSeason: unavailable,
    notes: ["Weekly projections only."],
  };
}

function trade(number: number, userGain = 4, partnerGain = 3) {
  return {
    id: `package-${number}`,
    partner: { id: id(50 + number), name: `Partner ${number}` },
    shape: "1-for-1",
    send: [player(1)],
    receive: [player(60 + number)],
    forcedDropsForUser: [] as DecisionPlayer[],
    forcedDropsForPartner: [] as DecisionPlayer[],
    userGain,
    partnerGain,
    totalGain: userGain + partnerGain,
    fairnessGap: Math.abs(userGain - partnerGain),
    mutuallyBeneficial: userGain > 0 && partnerGain > 0,
  };
}

function trades(): Extract<InSeasonDecisionSnapshot["trades"], { state: "available" }> {
  return {
    state: "available",
    evaluatedPackageCount: 20,
    eligibleOpponentCount: 3,
    bestForMe: [trade(1, 4), trade(2, 8), trade(3, 6), trade(4, 10, -0.5)],
    fairest: [trade(2, 8), trade(3, 6)],
    execution,
    notes: ["A bounded package search."],
  };
}

function snapshot(overrides: Partial<InSeasonDecisionSnapshot> = {}): InSeasonDecisionSnapshot {
  return {
    generatedAt: NOW,
    league: { id: id(100), name: "Test league", season: 2026, week: 2, provider: "espn" },
    team: { id: id(101), name: "My team", faabRemaining: 50 },
    provenance: {
      algorithmVersion: "in-season-decisions-v1",
      inputChecksum: "a".repeat(64),
      leagueLastSyncedAt: NOW,
      rosterEffectiveAt: NOW,
      projectionSet: {
        id: id(102),
        source: "Weekly projections",
        version: "v1",
        horizon: "Week 2",
        sourceObservedAt: NOW,
        sourceObservedAtStatus: "verified",
        importedAt: NOW,
      },
      projectionFreshness: { state: "fresh", label: "Updated now", observedAt: NOW },
    },
    providerVerification: {
      lockCoverage: "unavailable",
      storedTrueLocksHonored: true,
      storedFalseMeansUnlocked: false,
      storedLockedPlayerCount: 0,
      actionWarning: "Verify player locks on ESPN before applying changes.",
    },
    coverage: {
      leagueTeams: 4,
      teamsWithRosters: 4,
      leagueRosteredPlayers: 40,
      claimedRosterPlayers: 10,
      claimedRosterProjected: 10,
      claimedRosterProjectionRatio: 1,
      projectionSetPlayers: 200,
      projectionQueryLimited: false,
    },
    lineup: lineup(),
    waivers: waivers(),
    trades: trades(),
    ...overrides,
  };
}

describe("buildDecisionInboxSummary", () => {
  it("produces a validated bounded live inbox in decision order with original provenance", () => {
    const source = snapshot();
    expect(inSeasonDecisionSnapshotSchema.safeParse(source).success).toBe(true);
    const result = buildDecisionInboxSummary(source);

    expect(decisionInboxResponseSchema.parse(result)).toEqual(result);
    expect(result.items.map((item) => item.kind)).toEqual([
      "lineup",
      "waiver",
      "waiver",
      "waiver",
      "trade",
      "trade",
    ]);
    expect(result.items.every((item) => item.state === "open")).toBe(true);
    expect(result.items.map((item) => item.impact.value)).toEqual([8, 7, 6, 5, 8, 6]);
    expect(result.provenance).toEqual(source.provenance);
    expect(result.items.map((item) => item.href)).toEqual([
      `/decisions?league=${source.league.id}#decision-lineup`,
      ...Array.from({ length: 3 }, () => `/decisions?league=${source.league.id}#decision-waivers`),
      ...Array.from({ length: 2 }, () => `/decisions?league=${source.league.id}#decision-trades`),
    ]);
  });

  it("keeps interdependent lineup slot moves together, including a negative slot delta", () => {
    const plan = lineup();
    plan.changes[0]!.projectedPointDelta = 13;
    plan.changes[1]!.projectedPointDelta = -5;
    const result = buildDecisionInboxSummary(snapshot({ lineup: plan }));
    const lineupItems = result.items.filter((item) => item.kind === "lineup");

    expect(lineupItems).toHaveLength(1);
    expect(lineupItems[0]?.impact).toEqual({ label: "+8.00 projected points", value: 8 });
    expect(lineupItems[0]?.detail.join(" ")).toContain("-5.00 projected points");
    expect(lineupItems[0]?.detail.join(" ")).toContain("complete lineup plan together");
    expect(lineupItems[0]?.detail).toContain(
      "Verify player locks on ESPN before applying changes.",
    );
  });

  it("does not turn an equal or worse lineup into an inbox action", () => {
    for (const projectedGain of [0, -3]) {
      expect(
        buildDecisionInboxSummary(snapshot({ lineup: { ...lineup(), projectedGain } })).items.some(
          (item) => item.kind === "lineup",
        ),
      ).toBe(false);
    }
  });

  it("normalizes an infeasible lineup to an explicit unavailable section", () => {
    const result = buildDecisionInboxSummary(
      snapshot({ lineup: { ...lineup(), feasible: false } }),
    );
    expect(result.sections[0]).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "ENGINE_INFEASIBLE" }],
    });
    expect(result.items.some((item) => item.kind === "lineup")).toBe(false);
  });

  it("explains conflicting waiver alternatives and labels bench value separately from starting points", () => {
    const options = waivers([4]);
    options.recommendations[0]!.lineupGain = 0;
    options.recommendations[0]!.faab = null;
    const item = buildDecisionInboxSummary(snapshot({ waivers: options })).items.find(
      (entry) => entry.kind === "waiver",
    );

    expect(item?.impact).toEqual({ label: "+4.00 modeled roster value", value: 4 });
    expect(item?.detail.join(" ")).toContain("starting lineup change: 0.00 points");
    expect(item?.detail.join(" ")).toContain("same outgoing player or budget");
    expect(item?.detail.join(" ")).not.toContain("FAAB");
    expect(item?.summary).toContain("one move at a time");
  });

  it("deduplicates package advice across both trade lists and requires positive value for both teams", () => {
    const choices = trades();
    choices.bestForMe = [trade(1, 6), { ...trade(2, 12, -0.5), mutuallyBeneficial: true }];
    choices.fairest = [{ ...trade(1, 6), id: "same-package-different-source-id" }, trade(3, 2, 0)];
    const items = buildDecisionInboxSummary(snapshot({ trades: choices })).items.filter(
      (item) => item.kind === "trade",
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.summary).toContain("Player 61");
    expect(items[0]?.impact.label).toBe("+6.00 modeled roster value");
  });

  it("includes both teams' required drops without inventing wins or acceptance probabilities", () => {
    const choices = trades();
    choices.bestForMe = [
      { ...trade(1), forcedDropsForUser: [player(4)], forcedDropsForPartner: [player(5)] },
    ];
    choices.fairest = [];
    const item = buildDecisionInboxSummary(snapshot({ trades: choices })).items.find(
      (entry) => entry.kind === "trade",
    );

    expect(item?.detail).toContain("Your required drops: Player 4.");
    expect(item?.detail).toContain("Their required drops: Player 5.");
    expect(item?.detail.join(" ")).toContain("does not predict trade acceptance");
    expect(JSON.stringify(item)).not.toMatch(/win probability|% wins|confidence/iu);
  });

  it("keeps unsupported and missing inputs distinct from available sections without positive opportunities", () => {
    const unsupported = {
      state: "unavailable" as const,
      reasons: [
        {
          code: "SLOT_RULES_UNSUPPORTED" as const,
          message: "Stored roster slots cannot be mapped safely.",
        },
      ],
    };
    const result = buildDecisionInboxSummary(
      snapshot({
        lineup: unsupported,
        waivers: unavailable,
        trades: { ...trades(), bestForMe: [], fairest: [] },
      }),
    );

    expect(result.items).toEqual([]);
    expect(result.sections).toEqual([
      { kind: "lineup", ...unsupported },
      { kind: "waiver", ...unavailable },
      { kind: "trade", state: "available", reasons: [] },
    ]);
    expect(decisionInboxResponseSchema.safeParse(result).success).toBe(true);
  });

  it("preserves an unclaimed team's unavailable reasons and null team", () => {
    const unclaimed = {
      state: "unavailable" as const,
      reasons: [{ code: "TEAM_UNCLAIMED" as const, message: "Choose your team first." }],
    };
    const result = buildDecisionInboxSummary(
      snapshot({ team: null, lineup: unclaimed, waivers: unclaimed, trades: unclaimed }),
    );
    expect(result.team).toBeNull();
    expect(result.items).toEqual([]);
    expect(result.sections.every((section) => section.reasons[0]?.code === "TEAM_UNCLAIMED")).toBe(
      true,
    );
  });

  it("keeps IDs stable across refresh clocks, input checksum churn, and source ordering", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.generatedAt = LATER;
    after.provenance = {
      ...after.provenance,
      inputChecksum: "b".repeat(64),
      leagueLastSyncedAt: LATER,
      rosterEffectiveAt: LATER,
      projectionFreshness: { state: "fresh", label: "Updated 5m ago", observedAt: LATER },
      projectionSet: {
        ...after.provenance.projectionSet!,
        sourceObservedAt: LATER,
        importedAt: LATER,
      },
    };
    if (after.lineup.state === "available") {
      after.lineup.changes.reverse();
      after.lineup.assignments.reverse();
    }
    if (after.waivers.state === "available") after.waivers.recommendations.reverse();
    if (after.trades.state === "available") {
      after.trades.bestForMe.reverse();
      after.trades.fairest.reverse();
    }

    expect(buildDecisionInboxSummary(after).items.map((item) => item.id)).toEqual(
      buildDecisionInboxSummary(before).items.map((item) => item.id),
    );
    expect(buildDecisionInboxSummary(after).provenance.inputChecksum).toBe("b".repeat(64));
  });

  it.each(["league", "team", "week", "season", "projection", "algorithm"] as const)(
    "creates fresh advice identities for a different %s context",
    (context) => {
      const before = snapshot();
      const after = structuredClone(before);
      if (context === "league") after.league.id = id(200);
      if (context === "team") after.team!.id = id(201);
      if (context === "week") after.league.week = 3;
      if (context === "season") after.league.season = 2027;
      if (context === "projection") after.provenance.projectionSet!.version = "v2";
      if (context === "algorithm") after.provenance.algorithmVersion = "in-season-decisions-v2";
      const oldIds = new Set(buildDecisionInboxSummary(before).items.map((item) => item.id));
      expect(buildDecisionInboxSummary(after).items.every((item) => !oldIds.has(item.id))).toBe(
        true,
      );
    },
  );

  it("changes only materially revised advice IDs when a bid or required drop changes", () => {
    const before = snapshot();
    const after = structuredClone(before);
    if (after.waivers.state === "available")
      after.waivers.recommendations[1]!.faab!.recommended = 6;
    if (after.trades.state === "available") {
      for (const item of [...after.trades.bestForMe, ...after.trades.fairest]) {
        if (item.id === "package-2") item.forcedDropsForUser = [player(7)];
      }
    }
    const oldItems = buildDecisionInboxSummary(before).items;
    const newItems = buildDecisionInboxSummary(after).items;
    expect(newItems.map((item, index) => item.id === oldItems[index]?.id)).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
  });

  it("does not mutate the supplied snapshot", () => {
    const source = snapshot();
    const original = structuredClone(source);
    buildDecisionInboxSummary(source);
    expect(source).toEqual(original);
  });
});

describe("decision inbox wire validation", () => {
  it("rejects duplicate section kinds, duplicate IDs and actions in unavailable sections", () => {
    const result = buildDecisionInboxSummary(snapshot());
    expect(
      decisionInboxResponseSchema.safeParse({
        ...result,
        sections: [result.sections[0], result.sections[0], result.sections[2]],
      }).success,
    ).toBe(false);
    expect(
      decisionInboxResponseSchema.safeParse({
        ...result,
        items: [result.items[0], result.items[0]],
      }).success,
    ).toBe(false);
    expect(
      decisionInboxResponseSchema.safeParse({
        ...result,
        sections: [{ kind: "lineup", ...unavailable }, ...result.sections.slice(1)],
      }).success,
    ).toBe(false);
  });

  it("accepts only explicit review states and a valid persisted state receipt", () => {
    expect(decisionInboxStateRequestSchema.parse({ state: "reviewed" })).toEqual({
      state: "reviewed",
    });
    expect(decisionInboxStateRequestSchema.safeParse({ state: "execute" }).success).toBe(false);
    expect(
      decisionInboxStateRequestSchema.safeParse({ state: "dismissed", userId: id(10) }).success,
    ).toBe(false);
    expect(
      decisionInboxStateResponseSchema.safeParse({
        itemId: "a".repeat(64),
        state: "open",
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      decisionInboxStateResponseSchema.safeParse({
        itemId: "guessable-id",
        state: "open",
        updatedAt: NOW,
      }).success,
    ).toBe(false);
  });
});
