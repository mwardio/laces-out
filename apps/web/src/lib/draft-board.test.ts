import { describe, expect, it } from "vitest";

import {
  analyzeAuctionBoard,
  buildDraftBoardRows,
  buildSnakeBestNowQueue,
  type DraftBoardPlayer,
  type DraftBoardValue,
} from "./draft-board.js";

const players: DraftBoardPlayer[] = [
  { id: "qb", name: "Quarterback", positions: ["QB"] },
  { id: "rb", name: "Running Back", positions: ["RB"] },
  { id: "wr", name: "Wide Receiver", positions: ["WR"] },
  { id: "te", name: "Tight End", positions: ["TE"] },
];

function value(playerId: string, input: Partial<DraftBoardValue>): DraftBoardValue {
  return {
    playerId,
    overallRank: null,
    positionRank: null,
    tier: null,
    adp: null,
    aav: null,
    targetPrice: null,
    ceilingPrice: null,
    target: false,
    avoid: false,
    ...input,
  };
}

describe("draft board helpers", () => {
  it("sorts by the chosen custom field and keeps missing coverage visibly last", () => {
    const values = [
      value("qb", { overallRank: 2, tier: 1, aav: 24 }),
      value("rb", { overallRank: 1, tier: 2, aav: 31 }),
      value("wr", { adp: 3, tier: 1, aav: 28 }),
    ];

    expect(buildDraftBoardRows(players, values, "rank").map((row) => row.player.id)).toEqual([
      "rb",
      "qb",
      "wr",
      "te",
    ]);
    expect(buildDraftBoardRows(players, values, "aav").map((row) => row.player.id)).toEqual([
      "rb",
      "wr",
      "qb",
      "te",
    ]);
    expect(buildDraftBoardRows(players, values, "name").map((row) => row.player.id)).toEqual([
      "qb",
      "rb",
      "te",
      "wr",
    ]);
    expect(buildDraftBoardRows(players, values, "rank")[3]?.covered).toBe(false);
  });

  it("moves a player at most twelve rank slots for an actual unfilled starter fit", () => {
    const queue = buildSnakeBestNowQueue({
      availablePlayers: players,
      allPlayers: players,
      rosteredPlayerIds: ["qb"],
      rosterSlots: [
        { id: "QB-1", label: "QB", kind: "STARTER", eligiblePositions: ["QB"] },
        { id: "RB-1", label: "RB", kind: "STARTER", eligiblePositions: ["RB"] },
        {
          id: "FLEX-1",
          label: "Flex",
          kind: "STARTER",
          eligiblePositions: ["RB", "WR", "TE"],
        },
        { id: "BN-1", label: "Bench", kind: "BENCH", eligiblePositions: ["QB", "RB", "WR", "TE"] },
      ],
      values: [
        value("qb", { overallRank: 1 }),
        value("wr", { overallRank: 2 }),
        value("rb", { overallRank: 8 }),
        value("te", { overallRank: 20 }),
      ],
    });

    expect(queue[0]).toMatchObject({
      player: { id: "rb" },
      baseRank: 8,
      adjustedRank: -4,
      needLabel: "RB open",
    });
    expect(queue.every((row) => row.baseRank - row.adjustedRank <= 12)).toBe(true);
  });

  it("uses live budgets for auction values and fails explicitly on incomplete AAV coverage", () => {
    const teams = [
      { teamId: "one", remainingBudget: 20, openSlots: 2 },
      { teamId: "two", remainingBudget: 12, openSlots: 2 },
    ];
    const insufficient = analyzeAuctionBoard({
      availablePlayerIds: players.map((player) => player.id),
      values: [value("rb", { aav: 10 })],
      teams,
      selectedPlayerId: "rb",
      selectedTeamId: "one",
      minimumBid: 1,
    });
    expect(insufficient).toMatchObject({
      available: false,
      code: "INSUFFICIENT_COVERAGE",
      coveredPlayers: 1,
      requiredPlayers: 4,
    });

    const analysis = analyzeAuctionBoard({
      availablePlayerIds: [...players.map((player) => player.id), "depth"],
      values: [
        value("qb", { aav: 10 }),
        value("rb", { aav: 8 }),
        value("wr", { aav: 6 }),
        value("te", { aav: 4 }),
        value("depth", { aav: 2 }),
      ],
      teams,
      selectedPlayerId: "rb",
      selectedTeamId: "one",
      minimumBid: 1,
    });
    expect(analysis).toMatchObject({
      available: true,
      coveredPlayers: 5,
      requiredPlayers: 4,
      legalMaximumBid: 19,
    });
    if (analysis.available) {
      expect(analysis.inflationFactor).toBeCloseTo(28 / 24);
      expect(analysis.fairValue).toBeCloseTo(1 + 7 * (28 / 24));
      expect(analysis.targetPrice).toBe(9);
    }
  });
});
