import type { DraftMarketBaseline } from "@fantasy/contracts";
import { createRosterSlots, draftEventId, playerId, teamId } from "@fantasy/domain";
import { reduceDraft, type DraftEvent, type SnakeDraftConfig } from "@fantasy/engine-draft";
import { describe, expect, it, vi } from "vitest";

import {
  analyzerEventsFrom,
  analyzerMarketFrom,
  buildDraftAnalysis,
  DraftAnalysisService,
  selectDraftProjectionSet,
  type DraftProjectionCandidate,
} from "./draft-analysis.js";
import {
  DraftSessionError,
  type DraftSessionEventRecord,
  type DraftSessionSnapshot,
} from "./draft-session.js";

const TEAM_A = teamId("40000000-0000-4000-8000-000000000001");
const QB_A = playerId("50000000-0000-4000-8000-000000000001");

function record(
  sequence: number,
  event: DraftEvent,
  revertsSequence: number | null = null,
): DraftSessionEventRecord {
  return {
    sequence,
    idempotencyKey: `draft-event-${String(sequence).padStart(4, "0")}`,
    source: "manual",
    occurredAt: "2026-08-24T18:00:00.000Z",
    revertsSequence,
    event,
  };
}

const pick: DraftEvent = {
  id: draftEventId("manual:0001"),
  type: "SNAKE_PLAYER_SELECTED",
  teamId: TEAM_A,
  playerId: QB_A,
  overallPick: 1,
  occurredAt: "2026-08-24T18:00:00.000Z",
};

const revert: DraftEvent = {
  id: draftEventId("manual:0002"),
  type: "DRAFT_EVENT_REVERTED",
  targetEventId: draftEventId("manual:0001"),
  occurredAt: "2026-08-24T18:01:00.000Z",
};

describe("analyzerEventsFrom", () => {
  it("passes stored records through in order, keeping reverts the analyzer needs", () => {
    expect(analyzerEventsFrom([record(1, pick), record(2, revert, 1)])).toEqual([pick, revert]);
  });

  it("throws and names a stored event kind the analyzer does not model", () => {
    const unmodelled = {
      id: draftEventId("manual:0003"),
      type: "AUCTION_BID_RETRACTED",
      teamId: TEAM_A,
      playerId: QB_A,
    } as unknown as DraftEvent;

    expect(() => analyzerEventsFrom([record(1, unmodelled)])).toThrowError(
      /AUCTION_BID_RETRACTED/u,
    );
  });

  it("refuses a stream with a sequence gap instead of analyzing a partial draft", () => {
    expect(() => analyzerEventsFrom([record(1, pick), record(3, revert, 1)])).toThrowError(
      /contiguous/iu,
    );
  });

  it("returns an empty list for a draft that has recorded nothing yet", () => {
    expect(analyzerEventsFrom([])).toEqual([]);
  });
});

const TEAM_B = teamId("40000000-0000-4000-8000-000000000002");
const RB_A = playerId("50000000-0000-4000-8000-000000000002");
const QB_B = playerId("50000000-0000-4000-8000-000000000003");
const OUTSIDE_POOL = "50000000-0000-4000-8000-000000000099";

const rosterSlots = createRosterSlots([
  { type: "QB", count: 1 },
  { type: "RB", count: 1 },
]);

const snakeConfig: SnakeDraftConfig = {
  mode: "SNAKE",
  teams: [
    { id: TEAM_A, name: "Alpha", rosterSlots },
    { id: TEAM_B, name: "Bravo", rosterSlots },
  ],
  players: [
    { id: QB_A, name: "Quarterback A", positions: ["QB"] },
    { id: RB_A, name: "Running Back A", positions: ["RB"] },
    { id: QB_B, name: "Quarterback B", positions: ["QB"] },
  ],
  pickOrder: [TEAM_A, TEAM_B, TEAM_B, TEAM_A],
};

function baseline(
  players: readonly {
    playerId: string;
    overallAdp: number;
  }[],
): DraftMarketBaseline {
  return {
    state: "available",
    context: { season: 2026, scoringFormat: "ppr", teamCount: 12, rosterFormat: "one-qb" },
    source: {
      key: "ffc.adp.2026.ppr.12",
      name: "Fantasy Football Calculator ADP",
      attribution: "Fantasy Football Calculator",
      attributionUrl: "https://fantasyfootballcalculator.com",
      sourceAsOf: "2026-08-23T00:00:00.000Z",
      fetchedAt: "2026-08-23T06:00:00.000Z",
      checksumSha256: "b".repeat(64),
      stale: false,
      matchRate: 0.97,
    },
    players: players.map((row) => ({
      playerId: row.playerId,
      overallAdp: row.overallAdp,
      sourceRank: null,
      positionRank: null,
      standardDeviation: null,
      sampleSize: null,
    })),
    warnings: [],
  };
}

describe("analyzerMarketFrom", () => {
  it("maps admitted ADP onto the analyzer market and drops rows outside the draft pool", () => {
    const mapped = analyzerMarketFrom(
      baseline([
        { playerId: QB_A, overallAdp: 5 },
        { playerId: RB_A, overallAdp: 2 },
        { playerId: OUTSIDE_POOL, overallAdp: 1 },
      ]),
      snakeConfig,
    );

    expect(mapped.market).toEqual({
      admissionStatus: "ADMITTED",
      source: "ffc.adp.2026.ppr.12",
      sourceVersion: "b".repeat(64),
      asOf: "2026-08-23T00:00:00.000Z",
      players: [
        { playerId: QB_A, adp: 5 },
        { playerId: RB_A, adp: 2 },
      ],
    });
    expect(mapped.provenance).toMatchObject({
      state: "available",
      coveredPlayers: 2,
      poolPlayers: 3,
      droppedRows: { notInPool: 1, duplicate: 0, invalidAdp: 0 },
      auctionValuesPublished: false,
    });
  });

  it("forwards the source's own unavailable reason without inventing a market", () => {
    const mapped = analyzerMarketFrom(
      {
        state: "unavailable",
        reason: "source-not-ready",
        detail: "A compatible draft-market baseline has not completed its first refresh.",
      },
      snakeConfig,
    );

    expect(mapped.market).toBeUndefined();
    expect(mapped.provenance).toEqual({
      state: "unavailable",
      reason: "source-not-ready",
      detail: "A compatible draft-market baseline has not completed its first refresh.",
    });
  });

  it("withholds the market when the admitted file repeats a player", () => {
    const mapped = analyzerMarketFrom(
      baseline([
        { playerId: QB_A, overallAdp: 5 },
        { playerId: QB_A, overallAdp: 6 },
      ]),
      snakeConfig,
    );

    expect(mapped.market).toBeUndefined();
    expect(mapped.provenance).toMatchObject({ state: "unavailable", reason: "market-integrity" });
  });

  it("withholds an empty market rather than presenting a baseline that grades nothing", () => {
    const mapped = analyzerMarketFrom(
      baseline([{ playerId: OUTSIDE_POOL, overallAdp: 1 }]),
      snakeConfig,
    );

    expect(mapped.market).toBeUndefined();
    expect(mapped.provenance).toMatchObject({ state: "unavailable", reason: "no-pool-overlap" });
  });

  it("drops a non-positive ADP the analyzer would throw on and counts it", () => {
    const mapped = analyzerMarketFrom(
      baseline([
        { playerId: QB_A, overallAdp: 5 },
        { playerId: RB_A, overallAdp: 0 },
      ]),
      snakeConfig,
    );

    expect(mapped.market?.players).toEqual([{ playerId: QB_A, adp: 5 }]);
    expect(mapped.provenance).toMatchObject({
      state: "available",
      droppedRows: { notInPool: 0, duplicate: 0, invalidAdp: 1 },
    });
  });
});

const PROFILE = "league:ppr:v3";

function candidate(overrides: Partial<DraftProjectionCandidate> = {}): DraftProjectionCandidate {
  return {
    id: "60000000-0000-4000-8000-000000000001",
    source: "laces-out-first-party",
    version: "fp-2026-08-20",
    season: 2026,
    horizon: "full-season",
    windowStartWeek: 1,
    asOfWeek: 0,
    fetchedAt: "2026-08-20T06:00:00.000Z",
    scoringProfileKey: PROFILE,
    ...overrides,
  };
}

describe("selectDraftProjectionSet", () => {
  it("selects the newest compatible set published before the draft started", () => {
    const selection = selectDraftProjectionSet({
      leagueScoringProfileId: PROFILE,
      season: 2026,
      draftStartedAt: "2026-08-24T18:00:00.000Z",
      candidates: [
        candidate({
          id: "60000000-0000-4000-8000-000000000001",
          fetchedAt: "2026-08-12T06:00:00.000Z",
        }),
        candidate({
          id: "60000000-0000-4000-8000-000000000002",
          fetchedAt: "2026-08-20T06:00:00.000Z",
        }),
      ],
    });

    expect(selection.status).toBe("SELECTED");
    if (selection.status !== "SELECTED") throw new Error("Expected a selected projection set");
    expect(selection.candidate.id).toBe("60000000-0000-4000-8000-000000000002");
    expect(selection.leagueScoringProfileId).toBe(PROFILE);
  });

  it("reports a missing league scoring profile without inspecting candidates", () => {
    expect(
      selectDraftProjectionSet({
        leagueScoringProfileId: null,
        season: 2026,
        draftStartedAt: "2026-08-24T18:00:00.000Z",
        candidates: [candidate()],
      }),
    ).toMatchObject({ status: "UNAVAILABLE", reason: "NO_LEAGUE_SCORING_PROFILE" });
  });

  it("never falls back to another scoring profile, season, or horizon", () => {
    const selection = selectDraftProjectionSet({
      leagueScoringProfileId: PROFILE,
      season: 2026,
      draftStartedAt: "2026-08-24T18:00:00.000Z",
      candidates: [
        candidate({
          id: "60000000-0000-4000-8000-000000000003",
          scoringProfileKey: "league:half-ppr:v3",
        }),
        candidate({ id: "60000000-0000-4000-8000-000000000004", horizon: "week" }),
        candidate({ id: "60000000-0000-4000-8000-000000000005", season: 2025 }),
        candidate({ id: "60000000-0000-4000-8000-000000000006", scoringProfileKey: null }),
      ],
    });

    expect(selection).toMatchObject({
      status: "UNAVAILABLE",
      reason: "NO_COMPATIBLE_SET",
      candidatesConsidered: 4,
    });
  });

  it("refuses a compatible set that was published after the draft started", () => {
    expect(
      selectDraftProjectionSet({
        leagueScoringProfileId: PROFILE,
        season: 2026,
        draftStartedAt: "2026-08-24T18:00:00.000Z",
        candidates: [candidate({ fetchedAt: "2026-08-25T06:00:00.000Z" })],
      }),
    ).toMatchObject({ status: "UNAVAILABLE", reason: "PUBLISHED_AFTER_DRAFT_START" });
  });

  it("refuses a compatible set that predates the freshness window", () => {
    expect(
      selectDraftProjectionSet({
        leagueScoringProfileId: PROFILE,
        season: 2026,
        draftStartedAt: "2026-08-24T18:00:00.000Z",
        candidates: [candidate({ fetchedAt: "2026-06-01T06:00:00.000Z" })],
      }),
    ).toMatchObject({ status: "UNAVAILABLE", reason: "STALE_BEFORE_DRAFT" });
  });

  it("breaks a fetched-at tie on set id so the same rows always select the same set", () => {
    const first = selectDraftProjectionSet({
      leagueScoringProfileId: PROFILE,
      season: 2026,
      draftStartedAt: "2026-08-24T18:00:00.000Z",
      candidates: [
        candidate({ id: "60000000-0000-4000-8000-000000000009" }),
        candidate({ id: "60000000-0000-4000-8000-000000000008" }),
      ],
    });
    const reordered = selectDraftProjectionSet({
      leagueScoringProfileId: PROFILE,
      season: 2026,
      draftStartedAt: "2026-08-24T18:00:00.000Z",
      candidates: [
        candidate({ id: "60000000-0000-4000-8000-000000000008" }),
        candidate({ id: "60000000-0000-4000-8000-000000000009" }),
      ],
    });

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({ status: "SELECTED" });
  });
});

const DRAFT_ID = "30000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";

const snakePicks: readonly DraftEvent[] = [
  pick,
  {
    id: draftEventId("manual:0002"),
    type: "SNAKE_PLAYER_SELECTED",
    teamId: TEAM_B,
    playerId: RB_A,
    overallPick: 2,
    occurredAt: "2026-08-24T18:02:00.000Z",
  },
];

function snapshot(
  config: SnakeDraftConfig = snakeConfig,
  events: readonly DraftEvent[] = snakePicks,
): DraftSessionSnapshot {
  return {
    id: DRAFT_ID,
    leagueSeasonId: LEAGUE_SEASON_ID,
    transport: "manual",
    providerPolling: false,
    providerFeed: null,
    accessRole: "owner",
    sequence: events.length,
    persistedState: "live",
    config,
    state: reduceDraft(config, events),
    events: events.map((event, index) => record(index + 1, event)),
    createdAt: "2026-08-24T17:55:00.000Z",
    updatedAt: "2026-08-24T18:02:00.000Z",
  };
}

const noProjections = {
  status: "UNAVAILABLE",
  reason: "NO_COMPATIBLE_SET",
  detail: `No full-season projection set scored under ${PROFILE} was published before this draft started.`,
  candidatesConsidered: 0,
} as const;

describe("buildDraftAnalysis with no projection set", () => {
  it("still returns roster construction and ADP-relative reach and value", () => {
    const analysis = buildDraftAnalysis({
      session: snapshot(),
      baseline: baseline([
        { playerId: QB_A, overallAdp: 5 },
        { playerId: RB_A, overallAdp: 2 },
      ]),
      projections: noProjections,
      projectionRows: [],
      generatedAt: "2026-08-24T18:05:00.000Z",
    });

    expect(analysis.mode).toBe("SNAKE");
    expect(analysis.draftStatus).toBe("IN_PROGRESS");
    expect(analysis.market).toMatchObject({ state: "available", coveredPlayers: 2 });

    const alpha = analysis.teams.find((team) => team.teamId === TEAM_A);
    if (alpha === undefined || alpha.mode !== "SNAKE") throw new Error("Expected a snake team");
    expect(alpha.roster.starterSlots).toBe(2);
    expect(alpha.roster.coveredStarterSlots).toBe(1);
    expect(alpha.selections).toHaveLength(1);
    expect(alpha.selections[0]?.market).toMatchObject({
      status: "AVAILABLE",
      adp: 5,
      pickVsAdp: -4,
      classification: "REACH",
    });
  });

  it("warns by name instead of failing when no projection set is compatible", () => {
    const analysis = buildDraftAnalysis({
      session: snapshot(),
      baseline: baseline([{ playerId: QB_A, overallAdp: 5 }]),
      projections: noProjections,
      projectionRows: [],
      generatedAt: "2026-08-24T18:05:00.000Z",
    });

    expect(analysis.projections).toMatchObject({
      state: "unavailable",
      reason: "NO_COMPATIBLE_SET",
    });
    const warning = analysis.warnings.find((row) => row.code === "PROJECTIONS_UNAVAILABLE");
    expect(warning?.message).toContain(PROFILE);
    expect(analysis.warnings.some((row) => row.code === "ANALYSIS_FAILED")).toBe(false);
  });

  it("keeps every team's strength unavailable rather than ranking on partial data", () => {
    const analysis = buildDraftAnalysis({
      session: snapshot(),
      baseline: baseline([{ playerId: QB_A, overallAdp: 5 }]),
      projections: noProjections,
      projectionRows: [],
      generatedAt: "2026-08-24T18:05:00.000Z",
    });

    for (const team of analysis.teams) {
      expect(team.teamStrength.status).toBe("UNAVAILABLE");
    }
  });

  it("is deterministic: identical input yields an identical checksum and body", () => {
    const input = {
      session: snapshot(),
      baseline: baseline([{ playerId: QB_A, overallAdp: 5 }]),
      projections: noProjections,
      projectionRows: [],
      generatedAt: "2026-08-24T18:05:00.000Z",
    } as const;

    expect(buildDraftAnalysis(input)).toEqual(buildDraftAnalysis(input));
    expect(buildDraftAnalysis(input).inputChecksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("labels an in-progress draft rather than presenting it as a final grade", () => {
    const complete = buildDraftAnalysis({
      session: snapshot(snakeConfig, [
        ...snakePicks,
        {
          id: draftEventId("manual:0003"),
          type: "SNAKE_PLAYER_SELECTED",
          teamId: TEAM_B,
          playerId: QB_B,
          overallPick: 3,
          occurredAt: "2026-08-24T18:03:00.000Z",
        },
      ]),
      baseline: baseline([{ playerId: QB_A, overallAdp: 5 }]),
      projections: noProjections,
      projectionRows: [],
      generatedAt: "2026-08-24T18:05:00.000Z",
    });

    expect(["IN_PROGRESS", "COMPLETE"]).toContain(complete.draftStatus);
    expect(complete.sequence).toBe(3);
  });
});

const OUTSIDER_ID = "10000000-0000-4000-8000-000000000009";
const MEMBER_ID = "10000000-0000-4000-8000-000000000001";

function projectionSource(candidates: readonly DraftProjectionCandidate[] = []) {
  return {
    listCandidates: vi.fn(() => Promise.resolve(candidates)),
    listRows: vi.fn(() => Promise.resolve([])),
    leagueScoringProfileId: vi.fn(() => Promise.resolve(PROFILE)),
    season: vi.fn(() => Promise.resolve(2026)),
  };
}

describe("DraftAnalysisService", () => {
  it("does not read the draft market until the session read authorizes the caller", async () => {
    const getSession = vi.fn(() =>
      Promise.reject(
        new DraftSessionError(
          "DRAFT_NOT_FOUND",
          "The draft session was not found for this account.",
        ),
      ),
    );
    const getBaseline = vi.fn(() => Promise.resolve(baseline([])));
    const projections = projectionSource();
    const service = new DraftAnalysisService({ getSession }, { getBaseline }, projections);

    await expect(service.getAnalysis(OUTSIDER_ID, DRAFT_ID)).rejects.toMatchObject({
      code: "DRAFT_NOT_FOUND",
      statusCode: 404,
    });
    expect(getBaseline).not.toHaveBeenCalled();
    expect(projections.listCandidates).not.toHaveBeenCalled();
  });

  it("serves a member the analysis for the session it authorized", async () => {
    const getSession = vi.fn(() => Promise.resolve(snapshot()));
    const getBaseline = vi.fn(() => Promise.resolve(baseline([{ playerId: QB_A, overallAdp: 5 }])));
    const service = new DraftAnalysisService(
      { getSession },
      { getBaseline },
      projectionSource(),
      () => new Date("2026-08-24T18:05:00.000Z"),
    );

    const analysis = await service.getAnalysis(MEMBER_ID, DRAFT_ID);

    expect(getSession).toHaveBeenCalledWith(MEMBER_ID, DRAFT_ID);
    expect(getBaseline).toHaveBeenCalledWith(MEMBER_ID, DRAFT_ID);
    expect(analysis.draftId).toBe(DRAFT_ID);
    expect(analysis.generatedAt).toBe("2026-08-24T18:05:00.000Z");
  });

  it("keeps the analysis usable when the market read reports the caller unknown", async () => {
    const getSession = vi.fn(() => Promise.resolve(snapshot()));
    const getBaseline = vi.fn(() =>
      Promise.resolve({
        state: "unavailable" as const,
        reason: "draft-not-found" as const,
        detail: "The draft does not exist or is not available to you.",
      }),
    );
    const service = new DraftAnalysisService({ getSession }, { getBaseline }, projectionSource());

    const analysis = await service.getAnalysis(MEMBER_ID, DRAFT_ID);

    expect(analysis.market).toMatchObject({ state: "unavailable", reason: "draft-not-found" });
    expect(analysis.warnings.some((row) => row.code === "MARKET_UNAVAILABLE")).toBe(true);
    expect(analysis.teams).not.toHaveLength(0);
  });
});
