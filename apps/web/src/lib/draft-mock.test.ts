import { describe, expect, it } from "vitest";

import type { DraftSessionSnapshot } from "./api-client";
import {
  advanceLocalDraftMock,
  createLocalDraftMock,
  draftMockAvailability,
  localMockEvents,
  recordLocalControlledSelection,
  replayLocalDraftFromEvent,
  undoLatestLocalDraftEvent,
} from "./draft-mock";
import type { DraftBoardValue } from "./draft-board";

const now = "2026-07-21T12:00:00.000Z";
const teamA = "00000000-0000-4000-8000-000000000001";
const teamB = "00000000-0000-4000-8000-000000000002";
const playerIds = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
] as const;

function snakeSession(): DraftSessionSnapshot {
  const rosterSlots: DraftSessionSnapshot["config"]["teams"][number]["rosterSlots"] = [
    {
      id: "BENCH-1",
      type: "BENCH" as const,
      label: "Bench 1",
      kind: "BENCH" as const,
      eligiblePositions: ["QB", "RB", "WR", "TE"],
    },
    {
      id: "BENCH-2",
      type: "BENCH" as const,
      label: "Bench 2",
      kind: "BENCH" as const,
      eligiblePositions: ["QB", "RB", "WR", "TE"],
    },
  ];
  return {
    id: "20000000-0000-4000-8000-000000000001",
    leagueSeasonId: "30000000-0000-4000-8000-000000000001",
    transport: "manual",
    providerPolling: false,
    providerFeed: null,
    accessRole: "owner",
    sequence: 0,
    persistedState: "created",
    config: {
      mode: "SNAKE",
      teams: [
        { id: teamA, name: "Alpha", rosterSlots },
        { id: teamB, name: "Bravo", rosterSlots },
      ],
      players: playerIds.map((id, index) => ({
        id,
        name: `Player ${index + 1}`,
        positions: [index % 2 === 0 ? ("RB" as const) : ("WR" as const)],
      })),
      pickOrder: [teamA, teamB, teamB, teamA],
    },
    state: {
      mode: "SNAKE",
      teams: [
        { teamId: teamA, name: "Alpha", roster: [], openSlots: 2 },
        { teamId: teamB, name: "Bravo", roster: [], openSlots: 2 },
      ],
      draftedPlayerIds: [],
      activeEventIds: [],
      revertedEventIds: [],
      nextPick: { overallPick: 1, teamId: teamA },
      activeNomination: null,
      complete: false,
    },
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

function values(): DraftBoardValue[] {
  return playerIds.map((id, index) => ({
    playerId: id,
    overallRank: index + 1,
    positionRank: index + 1,
    tier: 1,
    adp: index + 1,
    adpStandardDeviation: 1,
    adpSampleSize: 100,
    aav: 10 - index,
    targetPrice: null,
    ceilingPrice: null,
    target: false,
    avoid: false,
  }));
}

function auctionSession(): DraftSessionSnapshot {
  const snake = snakeSession();
  const teams = snake.config.teams.map((team) => ({ ...team, budget: 20 }));
  return {
    ...snake,
    config: {
      mode: "AUCTION",
      teams,
      players: snake.config.players,
      minimumBid: 1,
    },
    state: {
      mode: "AUCTION",
      teams: teams.map((team) => ({
        teamId: team.id,
        name: team.name,
        roster: [],
        openSlots: 2,
        spent: 0,
        remainingBudget: 20,
        maximumBid: 19,
      })),
      draftedPlayerIds: [],
      activeEventIds: [],
      revertedEventIds: [],
      nextPick: null,
      activeNomination: null,
      complete: false,
    },
  };
}

describe("local draft mock", () => {
  it("reports an honest unavailable state when board coverage cannot fill the room", () => {
    const result = draftMockAvailability(snakeSession(), values().slice(0, 3));

    expect(result).toMatchObject({ available: false, coveredPlayers: 3, requiredPlayers: 4 });
    expect(result.message).toContain("4 available players");
  });

  it("forks the real room locally and advances exactly one event or to the controlled turn", () => {
    const session = snakeSession();
    const started = createLocalDraftMock(session, values(), "friends-league", teamB);
    const one = advanceLocalDraftMock(started, "event");
    const atTurn = advanceLocalDraftMock(started, "controlled-turn");

    expect(one.events).toEqual(atTurn.events);
    expect(one.events).toHaveLength(1);
    expect(one.stopReason).toBe("CONTROLLED_PICK");
    expect(atTurn.stopReason).toBe("CONTROLLED_PICK");
    expect(atTurn.state.nextPick?.teamId).toBe(teamB);
    expect(session.events).toEqual([]);
    expect(session.sequence).toBe(0);
  });

  it("records, immutably undoes, and deterministically replays local events", () => {
    const started = createLocalDraftMock(snakeSession(), values(), "redo-local", teamB);
    const atTurn = advanceLocalDraftMock(started, "controlled-turn");
    const chosenPlayer = atTurn.state.draftedPlayerIds.some((id) => id === playerIds[1])
      ? playerIds[2]
      : playerIds[1];
    const selected = recordLocalControlledSelection(atTurn, chosenPlayer, "local-user-selection");
    const undone = undoLatestLocalDraftEvent(selected, "local-user-undo");

    expect(selected.state.draftedPlayerIds.some((id) => id === chosenPlayer)).toBe(true);
    expect(undone.state.draftedPlayerIds.some((id) => id === chosenPlayer)).toBe(false);
    expect(localMockEvents(undone).at(-1)?.type).toBe("DRAFT_EVENT_REVERTED");

    const firstGenerated = localMockEvents(selected)[0]!;
    const replayed = replayLocalDraftFromEvent(selected, firstGenerated.id);
    expect(replayed.events.slice(0, firstGenerated === undefined ? 0 : 1)).toEqual(
      selected.events.slice(0, 1),
    );
    expect(replayed.stopReason).toBe("CONTROLLED_PICK");
  });

  it("keeps auction nominations and modeled bids in the local fork", () => {
    const session = auctionSession();
    const started = createLocalDraftMock(session, values(), "auction-local", teamB);
    const atNomination = advanceLocalDraftMock(started, "controlled-turn");
    expect(atNomination.stopReason).toBe("CONTROLLED_NOMINATION");
    expect(atNomination.state.activeNomination).toBeNull();

    const availablePlayer = playerIds.find(
      (id) => !atNomination.state.draftedPlayerIds.some((drafted) => drafted === id),
    )!;
    const nominated = recordLocalControlledSelection(
      atNomination,
      availablePlayer,
      "local-auction-nomination",
    );
    expect(nominated.state.activeNomination?.nominatorTeamId).toBe(teamB);
    const advanced = advanceLocalDraftMock(nominated, "event");
    expect(advanced.events.at(-1)?.type).toBe("AUCTION_BID_PLACED");
    expect(session.events).toEqual([]);
    expect(session.state.draftedPlayerIds).toEqual([]);
  });
});
