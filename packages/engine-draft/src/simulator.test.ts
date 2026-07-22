import { describe, expect, it } from "vitest";

import {
  assignPlayersToRosterSlots,
  createRosterSlots,
  draftEventId,
  playerId,
  teamId,
  type Player,
  type Position,
} from "@fantasy/domain";

import {
  boundedSeededNoise,
  reduceDraft,
  seededUnitInterval,
  simulateAuctionMockDraft,
  simulateSnakeMockDraft,
  type AuctionDraftConfig,
  type MockPlayerMarket,
  type SnakeDraftConfig,
} from "./index.js";

function playersAt(position: Position, count: number): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: playerId(`${position.toLowerCase()}-${index + 1}`),
    name: `${position} ${index + 1}`,
    positions: [position],
  }));
}

function marketFor(players: readonly Player[]): MockPlayerMarket[] {
  return players.map((player, index) => ({
    playerId: player.id,
    adp: index + 1,
    auctionValue: Math.max(1, 14 - index),
  }));
}

describe("seeded mock-draft primitives", () => {
  it("is repeatable, keyed rather than call-order dependent, and strictly bounded", () => {
    const first = seededUnitInterval("league-night", "pick:14:rb-2");
    expect(seededUnitInterval("league-night", "pick:14:rb-2")).toBe(first);
    expect(seededUnitInterval("league-night", "pick:15:rb-2")).not.toBe(first);

    for (let index = 0; index < 1_000; index += 1) {
      const noise = boundedSeededNoise("bounded", `player:${index}`, 7.5);
      expect(noise).toBeGreaterThanOrEqual(-7.5);
      expect(noise).toBeLessThan(7.5);
    }
  });
});

describe("snake mock simulator", () => {
  const teams = [teamId("alpha"), teamId("bravo"), teamId("charlie")];
  const players = [...playersAt("QB", 3), ...playersAt("RB", 3), ...playersAt("WR", 3)];
  const slots = createRosterSlots([
    { type: "QB", count: 1 },
    { type: "RB", count: 1 },
    { type: "WR", count: 1 },
  ]);
  const config: SnakeDraftConfig = {
    mode: "SNAKE",
    teams: teams.map((id) => ({ id, name: id, rosterSlots: slots })),
    players,
    pickOrder: [
      teams[0]!,
      teams[1]!,
      teams[2]!,
      teams[2]!,
      teams[1]!,
      teams[0]!,
      teams[0]!,
      teams[1]!,
      teams[2]!,
    ],
  };
  const market = marketFor(players);

  it("produces a complete, legal, duplicate-free draft for the same seed", () => {
    const input = { config, market, seed: "snake-2026", adpNoise: 5 } as const;
    const first = simulateSnakeMockDraft(input);
    const second = simulateSnakeMockDraft(input);

    expect(first.stopReason).toBe("COMPLETE");
    expect(first.events).toEqual(second.events);
    expect(first.state.draftedPlayerIds).toHaveLength(players.length);
    expect(new Set(first.state.draftedPlayerIds)).toHaveLength(players.length);
    for (const team of first.state.teams) {
      const roster = team.roster.map((item) =>
        players.find((player) => player.id === item.playerId)!,
      );
      expect(assignPlayersToRosterSlots(roster, slots).feasible).toBe(true);
      expect(team.openSlots).toBe(0);
    }
    expect(reduceDraft(config, first.events)).toEqual(first.state);
  });

  it("resumes to the exact one-shot event stream", () => {
    const oneShot = simulateSnakeMockDraft({ config, market, seed: "step-snake" });
    const firstStep = simulateSnakeMockDraft({
      config,
      market,
      seed: "step-snake",
      eventLimit: 4,
    });
    expect(firstStep.stopReason).toBe("EVENT_LIMIT");
    const resumed = simulateSnakeMockDraft({
      config,
      market,
      seed: "step-snake",
      events: firstStep.events,
    });
    expect(resumed.events).toEqual(oneShot.events);
  });

  it("repeats the choice but issues a branch-safe ID after an immutable undo", () => {
    const first = simulateSnakeMockDraft({
      config,
      market,
      seed: "redo-snake",
      eventLimit: 1,
    });
    const originalPick = first.generatedEvents[0]!;
    expect(originalPick.type).toBe("SNAKE_PLAYER_SELECTED");
    const events = [
      ...first.events,
      {
        id: draftEventId("manual-undo-1"),
        type: "DRAFT_EVENT_REVERTED" as const,
        targetEventId: originalPick.id,
      },
    ];
    const redone = simulateSnakeMockDraft({
      config,
      market,
      seed: "redo-snake",
      events,
      eventLimit: 1,
    });
    const redonePick = redone.generatedEvents[0]!;

    expect(redonePick.type).toBe("SNAKE_PLAYER_SELECTED");
    if (
      originalPick.type === "SNAKE_PLAYER_SELECTED" &&
      redonePick.type === "SNAKE_PLAYER_SELECTED"
    ) {
      expect(redonePick.playerId).toBe(originalPick.playerId);
      expect(redonePick.overallPick).toBe(originalPick.overallPick);
    }
    expect(redonePick.id).not.toBe(originalPick.id);
    expect(() => reduceDraft(config, redone.events)).not.toThrow();
  });

  it("stops cleanly before a user-controlled pick", () => {
    const result = simulateSnakeMockDraft({
      config,
      market,
      seed: "user-pick",
      controlledTeamIds: [teams[1]!],
    });

    expect(result.stopReason).toBe("CONTROLLED_PICK");
    expect(result.state.nextPick).toEqual({ overallPick: 2, teamId: teams[1] });
    expect(result.generatedEvents).toHaveLength(1);
  });

  it("responds to a recent positional run without violating the noise bound", () => {
    const runTeams = [teamId("run-a"), teamId("run-b")];
    const runPlayers: Player[] = [
      { id: playerId("run-rb-1"), name: "Run RB 1", positions: ["RB"] },
      { id: playerId("run-rb-2"), name: "Run RB 2", positions: ["RB"] },
      { id: playerId("run-wr-1"), name: "Run WR 1", positions: ["WR"] },
      { id: playerId("run-wr-2"), name: "Run WR 2", positions: ["WR"] },
    ];
    const runSlots = createRosterSlots([{ type: "BENCH", count: 2 }]);
    const runConfig: SnakeDraftConfig = {
      mode: "SNAKE",
      teams: runTeams.map((id) => ({ id, name: id, rosterSlots: runSlots })),
      players: runPlayers,
      pickOrder: [runTeams[0]!, runTeams[1]!, runTeams[1]!, runTeams[0]!],
    };
    const openingPick = {
      id: draftEventId("run-opening-pick"),
      type: "SNAKE_PLAYER_SELECTED" as const,
      teamId: runTeams[0]!,
      playerId: playerId("run-rb-1"),
      overallPick: 1,
    };
    const result = simulateSnakeMockDraft({
      config: runConfig,
      market: runPlayers.map((player, index) => ({ playerId: player.id, adp: index + 1 })),
      seed: "position-run",
      events: [openingPick],
      adpNoise: 0,
      positionRunStrength: 10,
      eventLimit: 1,
    });
    const selection = result.generatedEvents[0]!;

    expect(selection.type).toBe("SNAKE_PLAYER_SELECTED");
    if (selection.type === "SNAKE_PLAYER_SELECTED") {
      expect(selection.playerId).toBe(playerId("run-rb-2"));
    }
  });
});

describe("auction mock simulator", () => {
  const teams = [teamId("auction-a"), teamId("auction-b"), teamId("auction-c")];
  const players = [...playersAt("QB", 3), ...playersAt("RB", 3), ...playersAt("WR", 3)];
  const slots = createRosterSlots([
    { type: "QB", count: 1 },
    { type: "RB", count: 1 },
    { type: "WR", count: 1 },
  ]);
  const config: AuctionDraftConfig = {
    mode: "AUCTION",
    minimumBid: 1,
    teams: teams.map((id) => ({ id, name: id, rosterSlots: slots, budget: 30 })),
    players,
  };
  const market = marketFor(players);

  it("models nominations, bids, budgets, and legal roster completion deterministically", () => {
    const first = simulateAuctionMockDraft({ config, market, seed: "auction-2026" });
    const second = simulateAuctionMockDraft({ config, market, seed: "auction-2026" });

    expect(first.stopReason).toBe("COMPLETE");
    expect(first.events).toEqual(second.events);
    expect(first.events.some((event) => event.type === "AUCTION_NOMINATION_STARTED")).toBe(true);
    expect(first.events.some((event) => event.type === "AUCTION_BID_PLACED")).toBe(true);
    expect(first.events.some((event) => event.type === "AUCTION_PLAYER_SOLD")).toBe(true);
    expect(new Set(first.state.draftedPlayerIds)).toHaveLength(first.state.draftedPlayerIds.length);

    for (const team of first.state.teams) {
      expect(team.spent).toBeLessThanOrEqual(30);
      expect(team.remainingBudget).toBeGreaterThanOrEqual(team.openSlots);
      expect(team.openSlots).toBe(0);
      const roster = team.roster.map((item) =>
        players.find((player) => player.id === item.playerId)!,
      );
      expect(assignPlayersToRosterSlots(roster, slots).feasible).toBe(true);
    }
    expect(reduceDraft(config, first.events)).toEqual(first.state);
  });

  it("preserves budget, uniqueness, and roster invariants across varied seeds", () => {
    for (let index = 0; index < 40; index += 1) {
      const result = simulateAuctionMockDraft({
        config,
        market,
        seed: `auction-invariant-${index}`,
      });
      expect(result.stopReason).toBe("COMPLETE");
      expect(new Set(result.state.draftedPlayerIds).size).toBe(
        result.state.draftedPlayerIds.length,
      );
      for (const team of result.state.teams) {
        expect(team.spent).toBeLessThanOrEqual(30);
        expect(team.remainingBudget).toBeGreaterThanOrEqual(team.openSlots);
        const roster = team.roster.map((item) =>
          players.find((player) => player.id === item.playerId)!,
        );
        expect(assignPlayersToRosterSlots(roster, slots).feasible).toBe(true);
      }
    }
  });

  it("replays identically when resumed in the middle of a nomination", () => {
    const oneShot = simulateAuctionMockDraft({ config, market, seed: "step-auction" });
    const firstStep = simulateAuctionMockDraft({
      config,
      market,
      seed: "step-auction",
      eventLimit: 2,
    });
    expect(firstStep.stopReason).toBe("EVENT_LIMIT");
    expect(firstStep.state.activeNomination).not.toBeNull();

    const resumed = simulateAuctionMockDraft({
      config,
      market,
      seed: "step-auction",
      events: firstStep.events,
    });
    expect(resumed.events).toEqual(oneShot.events);
  });

  it("stops before a controlled team's nomination turn", () => {
    const result = simulateAuctionMockDraft({
      config,
      market,
      seed: "controlled-auction",
      controlledTeamIds: [teams[1]!],
    });

    expect(result.stopReason).toBe("CONTROLLED_NOMINATION");
    expect(result.state.teams.find((team) => team.teamId === teams[0])?.roster).toHaveLength(1);
    expect(result.state.activeNomination).toBeNull();
  });
});
