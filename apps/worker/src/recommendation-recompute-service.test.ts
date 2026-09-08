import { describe, expect, it, vi } from "vitest";

import type { InSeasonDecisionSnapshot, WaiverDecisionSection } from "@laces-out/contracts";
import type { InSeasonDecisionService, RecommendationRunInsert } from "@laces-out/decisions";
import type { Database } from "@laces-out/db";

import type { RecommendationJob } from "./jobs.js";
import {
  DecisionRecommendationSnapshotSource,
  DrizzleRecommendationRunWriter,
  type DrizzleClaimedTeamReader,
  RecommendationRecomputeService,
  waiverEntriesFrom,
} from "./recommendation-recompute-service.js";

const job: RecommendationJob = { leagueSeasonId: "league-season-1", kinds: ["lineup", "waiver"] };

function context(signal = new AbortController().signal) {
  return { jobId: "recommendation-recompute-test", signal } as const;
}

type AvailableWaivers = Extract<WaiverDecisionSection, { state: "available" }>;
type WaiverPlayer = AvailableWaivers["dropCandidates"][number];
type WaiverMove = AvailableWaivers["recommendations"][number];

const weeklyDrop: WaiverPlayer = {
  id: "70000000-0000-4000-8000-000000000001",
  name: "Weekly Drop",
  positions: ["RB"],
  nflTeam: "CHI",
  status: "ACTIVE",
  projectedPoints: 6.2,
};

const rosDrop: WaiverPlayer = {
  id: "70000000-0000-4000-8000-000000000002",
  name: "ROS Drop",
  positions: ["WR"],
  nflTeam: "DET",
  status: "ACTIVE",
  projectedPoints: 91.4,
};

const weeklyMove: WaiverMove = {
  add: {
    id: "70000000-0000-4000-8000-000000000003",
    name: "Weekly Add",
    positions: ["RB"],
    nflTeam: "GB",
    status: "ACTIVE",
    projectedPoints: 12.8,
  },
  drop: weeklyDrop,
  weightedGain: 5.98,
  lineupGain: 4.1,
  faab: { low: 4, recommended: 6, high: 8 },
  market: null,
  rationale: "Weekly rationale stays attached to the weekly action.",
  dropComparisons: [
    {
      dropPlayerId: weeklyDrop.id,
      weightedGain: 5.98,
      lineupGain: 4.1,
      faab: { low: 4, recommended: 6, high: 8 },
    },
  ],
};

const rosMove: WaiverMove = {
  add: {
    id: "70000000-0000-4000-8000-000000000004",
    name: "ROS Add",
    positions: ["WR"],
    nflTeam: "MIN",
    status: "QUESTIONABLE",
    projectedPoints: 171.3,
  },
  drop: rosDrop,
  weightedGain: 47.25,
  lineupGain: 18.75,
  faab: { low: 7, recommended: 10, high: 13 },
  market: null,
  rationale: "ROS rationale stays attached to the aggregate-window action.",
  dropComparisons: [
    {
      dropPlayerId: rosDrop.id,
      weightedGain: 47.25,
      lineupGain: 18.75,
      faab: { low: 7, recommended: 10, high: 13 },
    },
  ],
};

const availableWaivers = {
  state: "available",
  candidateCount: 24,
  evaluatedMoveCount: 96,
  dropCandidates: [weeklyDrop],
  recommendations: [weeklyMove],
  execution: {
    mode: "provider-required",
    provider: "espn",
    label: "Open ESPN to verify and apply manually",
    url: "https://fantasy.espn.com/football/",
  },
  notes: [],
  restOfSeason: {
    state: "available",
    label: "Rest of season · Weeks 3–18",
    windowStartWeek: 3,
    windowEndWeek: 18,
    projectionSet: {
      id: "60000000-0000-4000-8000-000000000002",
      source: "laces-out-first-party-ros",
      version: "2026-3-18-v1",
      horizon: "rest-of-season",
      sourceObservedAt: "2026-09-22T10:00:00.000Z",
      sourceObservedAtStatus: "verified",
      importedAt: "2026-09-22T10:05:00.000Z",
    },
    projectionFreshness: {
      state: "fresh",
      observedAt: "2026-09-22T10:00:00.000Z",
      label: "Updated within the hour",
    },
    candidateCount: 24,
    evaluatedMoveCount: 88,
    dropCandidates: [rosDrop],
    recommendations: [rosMove],
    notes: ["ROS FAAB is normalized across the modeled window."],
  },
} satisfies AvailableWaivers;

const weeklyProjectionSetId = "60000000-0000-4000-8000-000000000001";
const rosProjectionSetId = availableWaivers.restOfSeason.projectionSet.id;

function decisionSnapshot(waivers: WaiverDecisionSection): InSeasonDecisionSnapshot {
  return {
    generatedAt: "2026-09-22T12:00:00.000Z",
    league: {
      id: "20000000-0000-4000-8000-000000000001",
      name: "Fourth and Long",
      season: 2026,
      week: 3,
      provider: "espn",
    },
    team: {
      id: "40000000-0000-4000-8000-000000000001",
      name: "The Snowflakes",
      faabRemaining: 82,
    },
    provenance: {
      algorithmVersion: "in-season-decisions-v3",
      inputChecksum: "a".repeat(64),
      leagueLastSyncedAt: "2026-09-22T11:30:00.000Z",
      rosterEffectiveAt: "2026-09-22T11:25:00.000Z",
      projectionSet: {
        id: weeklyProjectionSetId,
        source: "laces-out-first-party",
        version: "2026-w03-v1",
        horizon: "week",
        sourceObservedAt: "2026-09-22T10:00:00.000Z",
        sourceObservedAtStatus: "verified",
        importedAt: "2026-09-22T10:05:00.000Z",
      },
      projectionFreshness: {
        state: "fresh",
        observedAt: "2026-09-22T10:00:00.000Z",
        label: "Updated 2h ago",
      },
    },
    providerVerification: {
      lockCoverage: "unavailable",
      storedTrueLocksHonored: true,
      storedFalseMeansUnlocked: false,
      storedLockedPlayerCount: 0,
      actionWarning: "Verify the transaction with the provider.",
    },
    coverage: {
      leagueTeams: 12,
      teamsWithRosters: 12,
      leagueRosteredPlayers: 192,
      claimedRosterPlayers: 16,
      claimedRosterProjected: 16,
      claimedRosterProjectionRatio: 1,
      projectionSetPlayers: 450,
      projectionQueryLimited: false,
    },
    lineup: {
      state: "unavailable",
      reasons: [{ code: "ENGINE_INFEASIBLE", message: "Not needed by this fixture." }],
    },
    waivers,
    trades: {
      state: "unavailable",
      reasons: [{ code: "OPPONENT_DATA_MISSING", message: "Not needed by this fixture." }],
    },
  };
}

function snapshotSource(snapshot: InSeasonDecisionSnapshot) {
  const queryResults: readonly (readonly unknown[])[] = [[{ settings: {} }], [], [], [], []];
  let queryIndex = 0;
  const select = () => {
    const rows = queryResults[queryIndex++] ?? [];
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => Promise.resolve(rows),
    };
    return query;
  };
  const database = {
    select,
    selectDistinctOn: select,
  } as unknown as Database;
  const decisions = {
    getSnapshot: () => Promise.resolve(snapshot),
  } as unknown as InSeasonDecisionService;
  const claimedTeams = {
    listClaimedTeams: () =>
      Promise.resolve([
        {
          fantasyTeamId: "40000000-0000-4000-8000-000000000001",
          userId: "10000000-0000-4000-8000-000000000001",
          leagueId: "20000000-0000-4000-8000-000000000001",
        },
      ]),
  } as unknown as DrizzleClaimedTeamReader;
  return new DecisionRecommendationSnapshotSource({ database, decisions, claimedTeams });
}

const snapshotRequest = {
  leagueSeasonId: "30000000-0000-4000-8000-000000000001",
  fantasyTeamId: "40000000-0000-4000-8000-000000000001",
  visibility: "league-only",
  signal: new AbortController().signal,
} as const;

describe("RecommendationRecomputeService", () => {
  it("recomputes only the claimed teams of the affected league season", async () => {
    const recompute = vi.fn(() =>
      Promise.resolve({ leagueSeasonId: job.leagueSeasonId, runs: [], skipped: [] }),
    );
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute,
    });

    await service.recomputeRecommendations(job, context());

    expect(recompute).toHaveBeenCalledWith(
      expect.objectContaining({
        leagueSeasonId: "league-season-1",
        kinds: ["lineup", "waiver"],
        claimedTeamIds: ["team-1"],
      }),
    );
  });

  it("completes as a stated no-op when no team in the league season is claimed", async () => {
    const recompute = vi.fn(() => Promise.reject(new Error("must not be called")));
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve([]),
      recompute,
    });

    await expect(service.recomputeRecommendations(job, context())).resolves.toBeUndefined();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("does not start an aborted job", async () => {
    const controller = new AbortController();
    controller.abort();
    const listClaimedTeamIds = vi.fn(() => Promise.resolve(["team-1"]));
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds,
      recompute: () => Promise.reject(new Error("must not be called")),
    });

    await expect(service.recomputeRecommendations(job, context(controller.signal))).rejects.toThrow(
      "aborted during shutdown",
    );
    expect(listClaimedTeamIds).not.toHaveBeenCalled();
  });

  it("passes the job's abort signal through so a shutdown stops between teams", async () => {
    const controller = new AbortController();
    const recompute = vi.fn(() =>
      Promise.resolve({ leagueSeasonId: job.leagueSeasonId, runs: [], skipped: [] }),
    );
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute,
    });

    await service.recomputeRecommendations(job, context(controller.signal));

    expect(recompute).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it("propagates a failure so pg-boss retries and finally dead-letters", async () => {
    const failure = new Error("projection read failed");
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute: () => Promise.reject(failure),
    });

    await expect(service.recomputeRecommendations(job, context())).rejects.toBe(failure);
  });

  it("rejects an unsupported kind by name rather than ignoring it", async () => {
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute: () => Promise.reject(new Error("Unsupported recommendation kind: draft")),
    });

    await expect(
      service.recomputeRecommendations(
        { leagueSeasonId: "league-season-1", kinds: ["draft"] },
        context(),
      ),
    ).rejects.toThrow("Unsupported recommendation kind: draft");
  });
});

describe("waiverEntriesFrom", () => {
  it("persists independent Week and ROS actions with explicit horizons and unique sequential ranks", () => {
    const provenance = decisionSnapshot(availableWaivers).provenance;
    const entries = waiverEntriesFrom(availableWaivers, provenance);

    expect(entries.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(new Set(entries.map((entry) => entry.rank)).size).toBe(entries.length);
    expect(entries[0]).toEqual({
      rank: 1,
      action: {
        horizon: "week",
        horizonRank: 1,
        projectionSet: provenance.projectionSet,
        projectionFreshness: provenance.projectionFreshness,
        move: weeklyMove,
      },
      explanation: weeklyMove.rationale,
      expectedValueDelta: weeklyMove.weightedGain,
    });
    expect(entries[1]).toEqual({
      rank: 2,
      action: {
        horizon: "rest-of-season",
        horizonRank: 1,
        windowStartWeek: 3,
        windowEndWeek: 18,
        projectionSet: availableWaivers.restOfSeason.projectionSet,
        projectionFreshness: availableWaivers.restOfSeason.projectionFreshness,
        move: rosMove,
      },
      explanation: rosMove.rationale,
      expectedValueDelta: rosMove.weightedGain,
    });
  });

  it("does not invent a persisted ROS action when that view is unavailable", () => {
    const provenance = decisionSnapshot(availableWaivers).provenance;
    const entries = waiverEntriesFrom(
      {
        ...availableWaivers,
        restOfSeason: {
          state: "unavailable",
          reasons: [
            {
              code: "PROJECTIONS_MISSING",
              message: "No admitted ROS release is available.",
            },
          ],
        },
      },
      provenance,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toEqual({
      horizon: "week",
      horizonRank: 1,
      projectionSet: provenance.projectionSet,
      projectionFreshness: provenance.projectionFreshness,
      move: weeklyMove,
    });
  });
});

describe("DrizzleRecommendationRunWriter", () => {
  it("writes numeric recommendation fields into their canonical database columns", async () => {
    const recommendationValues = vi.fn(() => Promise.resolve());
    const runMutation = {
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ runId: "run-1" }])),
        })),
      })),
    };
    const recommendationMutation = { values: recommendationValues };
    const transaction = {
      insert: vi.fn().mockReturnValueOnce(runMutation).mockReturnValueOnce(recommendationMutation),
    };
    const database = {
      transaction: <T>(operation: (value: typeof transaction) => Promise<T>) =>
        operation(transaction),
    } as unknown as Database;
    const input = {
      identity: {
        leagueSeasonId: "league-season-1",
        fantasyTeamId: "fantasy-team-1",
        kind: "waiver",
        algorithmVersion: "in-season-decisions-v3",
        inputChecksum: "b".repeat(64),
      },
      provenance: {
        algorithmVersion: "in-season-decisions-v3",
        inputChecksum: "b".repeat(64),
        randomSeed: null,
        inputs: {
          week: 3,
          scoringRulesChecksum: null,
          slotRulesChecksum: null,
          rosterSnapshotIds: [],
          projectionSetIds: [],
          marketSignalAsOf: null,
          availabilityAsOf: null,
          sourceSnapshotChecksum: "a".repeat(64),
          leagueLastSyncedAt: null,
          rosterEffectiveAt: null,
          freshness: {
            state: "fresh",
            observedAt: "2026-09-22T10:00:00.000Z",
            label: "Updated within the hour",
          },
        },
        warnings: ["PRIVATE_PROJECTION_SETS_EXCLUDED"],
      },
      entries: [
        {
          rank: 1,
          action: { horizon: "week" },
          explanation: "Weekly move",
          expectedValueDelta: 5.98,
          confidence: 0.8125,
        },
        {
          rank: 2,
          action: { horizon: "rest-of-season" },
          explanation: "ROS move",
          expectedValueDelta: null,
          confidence: null,
        },
      ],
    } satisfies RecommendationRunInsert;

    await expect(new DrizzleRecommendationRunWriter(database).insertRun(input)).resolves.toEqual({
      runId: "run-1",
      inserted: true,
    });
    expect(recommendationValues).toHaveBeenCalledWith([
      {
        runId: "run-1",
        rank: 1,
        action: { horizon: "week" },
        expectedValueDelta: "5.98",
        confidence: "0.8125",
        explanation: "Weekly move",
        warnings: ["PRIVATE_PROJECTION_SETS_EXCLUDED"],
      },
      {
        runId: "run-1",
        rank: 2,
        action: { horizon: "rest-of-season" },
        expectedValueDelta: null,
        confidence: null,
        explanation: "ROS move",
        warnings: ["PRIVATE_PROJECTION_SETS_EXCLUDED"],
      },
    ]);
  });
});

describe("DecisionRecommendationSnapshotSource projection identity", () => {
  it("includes the independent ROS projection set only when the ROS view is available", async () => {
    const available = await snapshotSource(decisionSnapshot(availableWaivers)).buildSnapshot(
      snapshotRequest,
    );
    const unavailable = await snapshotSource(
      decisionSnapshot({
        ...availableWaivers,
        restOfSeason: {
          state: "unavailable",
          reasons: [
            {
              code: "PROJECTION_COVERAGE_INCOMPLETE",
              message: "The admitted ROS release does not cover the active roster.",
            },
          ],
        },
      }),
    ).buildSnapshot(snapshotRequest);

    expect(available?.projectionSetIds).toEqual([weeklyProjectionSetId, rosProjectionSetId]);
    expect(unavailable?.projectionSetIds).toEqual([weeklyProjectionSetId]);
  });
});
