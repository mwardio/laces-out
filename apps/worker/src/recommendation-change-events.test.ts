import type { LeagueRecomputeResult } from "@laces-out/decisions";
import { describe, expect, it, vi } from "vitest";

import type { ChangeEventDraft } from "@laces-out/change-events";

import {
  decisionFingerprint,
  emitRecommendationChangeEvents,
  materialAction,
  type RecommendationDeltaRepository,
} from "./recommendation-change-events.js";

const SEASON_ID = "60000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const TEAM = "30000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "30000000-0000-4000-8000-000000000002";
const OWNER = "10000000-0000-4000-8000-000000000001";
const MANAGER = "10000000-0000-4000-8000-000000000002";
const OCCURRED_AT = new Date("2026-09-16T12:00:00.000Z");

const lineupMove = {
  slotId: "RB1",
  remove: { id: "a", name: "A. Back" },
  add: { id: "b", name: "B. Back" },
  projectedPointDelta: 3.4,
  explanation: "B projects higher",
};

describe("decisionFingerprint", () => {
  it("ignores presentational noise and reacts to a material change", () => {
    const base = decisionFingerprint({ lineup: [lineupMove] });

    expect(base).toMatch(/^[a-f0-9]{64}$/u);
    expect(decisionFingerprint({ lineup: [{ ...lineupMove, projectedPointDelta: 3.41 }] })).toBe(
      base,
    );
    expect(decisionFingerprint({ lineup: [{ ...lineupMove, explanation: "reworded" }] })).toBe(
      base,
    );
    expect(
      decisionFingerprint({ lineup: [{ ...lineupMove, add: { id: "z", name: "Z. Back" } }] }),
    ).not.toBe(base);
  });

  it("is stable when equivalent rows are reordered", () => {
    const claims = [
      { add: { id: "c" }, drop: { id: "d" } },
      { add: { id: "e" }, drop: { id: "f" } },
    ];
    expect(decisionFingerprint({ waiver: claims })).toBe(
      decisionFingerprint({ waiver: [...claims].reverse() }),
    );
  });
});

describe("materialAction", () => {
  it("drops numbers and explanations but keeps identities", () => {
    expect(materialAction(lineupMove)).toEqual({
      slotId: "RB1",
      remove: { id: "a", name: "A. Back" },
      add: { id: "b", name: "B. Back" },
    });
  });
});

function repository(
  overrides: Partial<RecommendationDeltaRepository> = {},
): RecommendationDeltaRepository {
  return {
    describeClaimedTeams: () =>
      Promise.resolve([
        { fantasyTeamId: TEAM, teamName: "Gridiron Ghosts", leagueId: LEAGUE_ID, userId: OWNER },
        { fantasyTeamId: OTHER_TEAM, teamName: "Other Team", leagueId: LEAGUE_ID, userId: MANAGER },
      ]),
    listRecentRuns: () =>
      Promise.resolve([
        { runId: "next", inputHash: "a".repeat(64), week: 4 },
        { runId: "prior", inputHash: "b".repeat(64), week: 4 },
      ]),
    listRunActions: (runId: string) =>
      Promise.resolve(
        runId === "next" ? [{ ...lineupMove, add: { id: "z", name: "Z. Back" } }] : [lineupMove],
      ),
    ...overrides,
  };
}

function result(
  runs: LeagueRecomputeResult["runs"] = [
    { kind: "lineup", fantasyTeamId: TEAM, runId: "next", inserted: true },
  ],
): LeagueRecomputeResult {
  return { leagueSeasonId: SEASON_ID, runs, skipped: [] };
}

describe("emitRecommendationChangeEvents", () => {
  it("emits one private action event to the claiming member only", async () => {
    const emit = vi.fn<(drafts: readonly ChangeEventDraft[], now: Date) => Promise<unknown>>(() =>
      Promise.resolve({}),
    );

    await emitRecommendationChangeEvents(
      { repository: repository(), emit, algorithmVersion: "in-season-decisions-v1" },
      { leagueSeasonId: SEASON_ID, result: result(), occurredAt: OCCURRED_AT },
    );

    const [drafts] = emit.mock.calls[0]!;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      source: "decision-delta",
      eventType: "recommendation.changed",
      aggregateType: "league-season-team",
      aggregateId: `${SEASON_ID}:${TEAM}`,
      leagueId: LEAGUE_ID,
      actorUserId: null,
      visibility: "private",
      severity: "action",
      recipientUserIds: [OWNER],
    });
    // A second member of the same league is never a recipient of this event.
    expect(drafts[0]!.recipientUserIds).not.toContain(MANAGER);
    expect(drafts[0]!.payload).toMatchObject({
      v: 1,
      kinds: ["lineup"],
      algorithmVersion: "in-season-decisions-v1",
    });
  });

  it("emits nothing for a replayed run the recompute resolved to an existing row", async () => {
    const emit = vi.fn();

    await emitRecommendationChangeEvents(
      { repository: repository(), emit, algorithmVersion: "in-season-decisions-v1" },
      {
        leagueSeasonId: SEASON_ID,
        result: result([{ kind: "lineup", fantasyTeamId: TEAM, runId: "next", inserted: false }]),
        occurredAt: OCCURRED_AT,
      },
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it("treats a team's first-ever run as a baseline", async () => {
    const emit = vi.fn();

    await emitRecommendationChangeEvents(
      {
        repository: repository({
          listRecentRuns: () =>
            Promise.resolve([{ runId: "next", inputHash: "a".repeat(64), week: 4 }]),
        }),
        emit,
        algorithmVersion: "in-season-decisions-v1",
      },
      { leagueSeasonId: SEASON_ID, result: result(), occurredAt: OCCURRED_AT },
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits nothing when the material recommendation set is unchanged", async () => {
    const emit = vi.fn();

    await emitRecommendationChangeEvents(
      {
        repository: repository({
          // Same move, different projected delta: a projection refresh, not a decision change.
          listRunActions: (runId: string) =>
            Promise.resolve([
              runId === "next" ? { ...lineupMove, projectedPointDelta: 3.41 } : lineupMove,
            ]),
        }),
        emit,
        algorithmVersion: "in-season-decisions-v1",
      },
      { leagueSeasonId: SEASON_ID, result: result(), occurredAt: OCCURRED_AT },
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits nothing for a team nobody has claimed", async () => {
    const emit = vi.fn();

    await emitRecommendationChangeEvents(
      {
        repository: repository({ describeClaimedTeams: () => Promise.resolve([]) }),
        emit,
        algorithmVersion: "in-season-decisions-v1",
      },
      { leagueSeasonId: SEASON_ID, result: result(), occurredAt: OCCURRED_AT },
    );

    expect(emit).not.toHaveBeenCalled();
  });
});
