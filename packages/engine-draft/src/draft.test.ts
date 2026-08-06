import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createRosterSlots, draftEventId, playerId, teamId, type Player } from "@laces-out/domain";

import {
  calculateAuctionInflation,
  createSnakePickOrder,
  DraftInvariantError,
  inflatedAuctionValue,
  latestUndoableEvent,
  maximumLegalBid,
  recommendBid,
  reduceDraft,
  type AuctionDraftConfig,
  type DraftEvent,
  type SnakeDraftConfig,
} from "./index.js";

const a = teamId("a");
const b = teamId("b");
const players: readonly Player[] = [
  { id: playerId("qb-a"), name: "QB A", positions: ["QB"] },
  { id: playerId("qb-b"), name: "QB B", positions: ["QB"] },
  { id: playerId("rb-a"), name: "RB A", positions: ["RB"] },
  { id: playerId("rb-b"), name: "RB B", positions: ["RB"] },
];
const rosterSlots = createRosterSlots([
  { type: "QB", count: 1 },
  { type: "BENCH", count: 1 },
]);
const snakeConfig: SnakeDraftConfig = {
  mode: "SNAKE",
  teams: [
    { id: a, name: "A", rosterSlots },
    { id: b, name: "B", rosterSlots },
  ],
  players,
  pickOrder: [a, b, b, a],
};

describe("snake draft helpers and reducer", () => {
  it("builds standard and third-round-reversal order", () => {
    expect(createSnakePickOrder([a, b], 4)).toEqual([a, b, b, a, a, b, b, a]);
    expect(createSnakePickOrder([a, b], 4, { thirdRoundReversal: true })).toEqual([
      a,
      b,
      b,
      a,
      b,
      a,
      a,
      b,
    ]);
  });

  it("supports keepers in future pick slots while advancing through open picks", () => {
    const events: DraftEvent[] = [
      {
        id: draftEventId("keeper"),
        type: "SNAKE_KEEPER_ASSIGNED",
        teamId: b,
        playerId: playerId("rb-b"),
        overallPick: 3,
      },
      {
        id: draftEventId("pick-1"),
        type: "SNAKE_PLAYER_SELECTED",
        teamId: a,
        playerId: playerId("qb-a"),
        overallPick: 1,
      },
      {
        id: draftEventId("pick-2"),
        type: "SNAKE_PLAYER_SELECTED",
        teamId: b,
        playerId: playerId("qb-b"),
        overallPick: 2,
      },
    ];
    const state = reduceDraft(snakeConfig, events);

    expect(state.nextPick).toEqual({ overallPick: 4, teamId: a });
    expect(state.teams.find((team) => team.teamId === b)?.roster).toHaveLength(2);
  });

  it("uses immutable revert events and permits undoing a revert", () => {
    const selection: DraftEvent = {
      id: draftEventId("pick-1"),
      type: "SNAKE_PLAYER_SELECTED",
      teamId: a,
      playerId: playerId("qb-a"),
      overallPick: 1,
    };
    const revert: DraftEvent = {
      id: draftEventId("undo-1"),
      type: "DRAFT_EVENT_REVERTED",
      targetEventId: selection.id,
    };
    const restore: DraftEvent = {
      id: draftEventId("restore-1"),
      type: "DRAFT_EVENT_REVERTED",
      targetEventId: revert.id,
    };

    expect(reduceDraft(snakeConfig, [selection, revert]).nextPick?.overallPick).toBe(1);
    const restored = reduceDraft(snakeConfig, [selection, revert, restore]);
    expect(restored.nextPick?.overallPick).toBe(2);
    expect(restored.draftedPlayerIds).toEqual([playerId("qb-a")]);
    expect(latestUndoableEvent([selection, revert, restore])?.id).toBe(selection.id);
  });

  it("rejects out-of-turn picks and illegal rosters", () => {
    expect(() =>
      reduceDraft(snakeConfig, [
        {
          id: draftEventId("wrong"),
          type: "SNAKE_PLAYER_SELECTED",
          teamId: b,
          playerId: playerId("qb-b"),
          overallPick: 1,
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PICK" }));

    const qbOnlyConfig: SnakeDraftConfig = {
      ...snakeConfig,
      teams: snakeConfig.teams.map((team) => ({
        ...team,
        rosterSlots: createRosterSlots([{ type: "QB", count: 1 }]),
      })),
      pickOrder: [a, b],
    };
    expect(() =>
      reduceDraft(qbOnlyConfig, [
        {
          id: draftEventId("illegal"),
          type: "SNAKE_PLAYER_SELECTED",
          teamId: a,
          playerId: playerId("rb-a"),
          overallPick: 1,
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "ROSTER_ILLEGAL" }));
  });
});

describe("auction reducer", () => {
  const config: AuctionDraftConfig = {
    mode: "AUCTION",
    minimumBid: 1,
    teams: [
      { id: a, name: "A", rosterSlots, budget: 20 },
      { id: b, name: "B", rosterSlots, budget: 20 },
    ],
    players,
  };

  it("tracks nominations, bids, sales, budgets, and max bids", () => {
    const events: DraftEvent[] = [
      {
        id: draftEventId("nominate"),
        type: "AUCTION_NOMINATION_STARTED",
        teamId: a,
        playerId: playerId("qb-a"),
        nominationNumber: 1,
      },
      {
        id: draftEventId("bid"),
        type: "AUCTION_BID_PLACED",
        teamId: b,
        playerId: playerId("qb-a"),
        amount: 10,
      },
      {
        id: draftEventId("sold"),
        type: "AUCTION_PLAYER_SOLD",
        teamId: b,
        playerId: playerId("qb-a"),
        price: 10,
      },
    ];
    const state = reduceDraft(config, events);
    const teamB = state.teams.find((team) => team.teamId === b)!;

    expect(state.activeNomination).toBeNull();
    expect(teamB).toMatchObject({ spent: 10, remainingBudget: 10, openSlots: 1, maximumBid: 10 });
  });

  it("reserves minimum dollars for every remaining roster slot", () => {
    expect(() =>
      reduceDraft(config, [
        {
          id: draftEventId("too-rich"),
          type: "AUCTION_PLAYER_SOLD",
          teamId: a,
          playerId: playerId("qb-a"),
          price: 20,
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(maximumLegalBid(20, 2, 1)).toBe(19);
  });

  it("exposes typed invariant errors", () => {
    try {
      reduceDraft(config, [
        {
          id: draftEventId("bad-price"),
          type: "AUCTION_PLAYER_SOLD",
          teamId: a,
          playerId: playerId("qb-a"),
          price: 0,
        },
      ]);
      throw new Error("Expected reducer to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DraftInvariantError);
      expect((error as DraftInvariantError).code).toBe("INVALID_PRICE");
    }
  });
});

describe("auction value math", () => {
  it("separates minimum-dollar reserves from live inflation", () => {
    const market = calculateAuctionInflation({
      teams: [
        { remainingBudget: 50, openSlots: 3 },
        { remainingBudget: 30, openSlots: 2 },
      ],
      remainingPlayers: [
        { playerId: playerId("qb-a"), baseValue: 30 },
        { playerId: playerId("rb-a"), baseValue: 20 },
      ],
      minimumBid: 1,
    });

    expect(market.discretionaryDollars).toBe(75);
    expect(market.baselineDiscretionaryValue).toBe(48);
    expect(market.inflationFactor).toBeCloseTo(75 / 48);
    expect(inflatedAuctionValue(20, market.inflationFactor, 1)).toBeCloseTo(30.6875);
  });

  it("caps a recommended bid at the team's legal maximum", () => {
    expect(
      recommendBid({
        baseValue: 50,
        inflationFactor: 2,
        minimumBid: 1,
        remainingBudget: 12,
        openSlots: 3,
      }),
    ).toMatchObject({ targetPrice: 10, maximumBid: 10, legalMaximumBid: 10 });
  });

  it("always preserves the minimum-price reserve", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000 }),
        fc.nat({ max: 30 }),
        fc.nat({ max: 10 }),
        (remainingBudget, openSlots, minimumBid) => {
          const maximum = maximumLegalBid(remainingBudget, openSlots, minimumBid);
          expect(maximum).toBeGreaterThanOrEqual(0);
          expect(maximum).toBeLessThanOrEqual(remainingBudget);
          if (openSlots === 0) {
            expect(maximum).toBe(0);
          } else if (remainingBudget >= minimumBid * (openSlots - 1)) {
            expect(maximum + minimumBid * (openSlots - 1)).toBe(remainingBudget);
          }
        },
      ),
    );
  });
});
