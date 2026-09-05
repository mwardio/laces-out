import { draftEventId, playerId, rosterSlotId, teamId, type RosterSlot } from "@laces-out/domain";
import {
  createSnakePickOrder,
  reduceDraft,
  type DraftConfig,
  type DraftEvent,
} from "@laces-out/engine-draft";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  reconcileYahooDraftSnapshot,
  yahooDraftPickIdempotencyKey,
  type ReconcileYahooDraftSnapshotInput,
  type YahooDraftPick,
  type YahooDraftReconciliationResult,
} from "./yahoo-draft-reconciler.js";

const FEED_ID = "feed-1";
const DRAFT_ID = "draft-1";
const NOW = new Date("2026-09-05T14:00:00.000Z");
const TEAM_A = "40000000-0000-4000-8000-00000000000a";
const TEAM_B = "40000000-0000-4000-8000-00000000000b";
const TEAM_KEY_A = "449.l.12345.t.1";
const TEAM_KEY_B = "449.l.12345.t.2";
const PLAYER = (value: number): string =>
  `50000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const PLAYER_KEY = (value: number): string => `449.p.${9000 + value}`;
const GENERATED_TEAM = (value: number): string =>
  `41000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const GENERATED_TEAM_KEY = (value: number): string => `449.l.12345.t.${value}`;

function slots(count: number): readonly RosterSlot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: rosterSlotId(`slot-${index + 1}`),
    type: "BENCH" as const,
    label: `Bench ${index + 1}`,
    kind: "BENCH" as const,
    eligiblePositions: ["QB", "RB", "WR", "TE"] as const,
  }));
}

function players(count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    id: playerId(PLAYER(index + 1)),
    name: `Player ${index + 1}`,
    positions: ["RB" as const],
  }));
}

function snakeConfig(): DraftConfig {
  return {
    mode: "SNAKE",
    teams: [
      { id: teamId(TEAM_A), name: "Team A", rosterSlots: slots(2) },
      { id: teamId(TEAM_B), name: "Team B", rosterSlots: slots(2) },
    ],
    players: players(),
    pickOrder: [teamId(TEAM_A), teamId(TEAM_B), teamId(TEAM_B), teamId(TEAM_A)],
  };
}

function auctionConfig(budget = 200): DraftConfig {
  return {
    mode: "AUCTION",
    teams: [
      { id: teamId(TEAM_A), name: "Team A", rosterSlots: slots(2), budget },
      { id: teamId(TEAM_B), name: "Team B", rosterSlots: slots(2), budget },
    ],
    players: players(),
    minimumBid: 1,
  };
}

function pick(
  sequence: number,
  teamKey: string,
  player: number,
  cost: number | null = null,
): YahooDraftPick {
  return {
    pick: sequence,
    round: Math.ceil(sequence / 2),
    teamKey,
    playerKey: PLAYER_KEY(player),
    cost,
  };
}

function snakeEvent(
  sequence: number,
  team: string,
  player: number,
  idPrefix = "manual",
): DraftEvent {
  return {
    id: draftEventId(`${idPrefix}:${sequence}`),
    type: "SNAKE_PLAYER_SELECTED",
    teamId: teamId(team),
    playerId: playerId(PLAYER(player)),
    overallPick: sequence,
    occurredAt: "2026-09-05T13:00:00.000Z",
  };
}

function auctionEvent(sequence: number, team: string, player: number, price: number): DraftEvent {
  return {
    id: draftEventId(`manual-auction:${sequence}`),
    type: "AUCTION_PLAYER_SOLD",
    teamId: teamId(team),
    playerId: playerId(PLAYER(player)),
    price,
    occurredAt: "2026-09-05T13:00:00.000Z",
  };
}

const teamIdByKey = new Map([
  [TEAM_KEY_A, TEAM_A],
  [TEAM_KEY_B, TEAM_B],
]);
const playerIdByKey = new Map(
  Array.from({ length: 8 }, (_, index) => [PLAYER_KEY(index + 1), PLAYER(index + 1)] as const),
);

function reconcile(
  overrides: Partial<ReconcileYahooDraftSnapshotInput> = {},
): YahooDraftReconciliationResult {
  return reconcileYahooDraftSnapshot({
    feedId: FEED_ID,
    draftId: DRAFT_ID,
    draftMode: "snake",
    config: snakeConfig(),
    snapshot: { collectionComplete: true, picks: [] },
    teamIdByKey,
    playerIdByKey,
    activeEvents: [],
    standardScopeConfirmed: true,
    occurredAt: NOW,
    ...overrides,
  });
}

function heldIssue(result: YahooDraftReconciliationResult): string {
  expect(result.kind).toBe("held");
  expect(result.append).toEqual([]);
  return result.kind === "held" ? result.issue : "";
}

describe("Yahoo draft forward reconciliation", () => {
  it("appends only the provider suffix after the complete active prefix", () => {
    const activeEvents = [snakeEvent(1, TEAM_A, 1)];
    const result = reconcile({
      activeEvents,
      snapshot: {
        collectionComplete: true,
        picks: [pick(1, TEAM_KEY_A, 1), pick(2, TEAM_KEY_B, 2), pick(3, TEAM_KEY_B, 3)],
      },
    });

    expect(result.kind).toBe("append");
    if (result.kind !== "append") return;
    expect(result.append).toHaveLength(2);
    expect(result.append.map((pending) => pending.event)).toMatchObject([
      {
        type: "SNAKE_PLAYER_SELECTED",
        overallPick: 2,
        teamId: TEAM_B,
        playerId: PLAYER(2),
      },
      {
        type: "SNAKE_PLAYER_SELECTED",
        overallPick: 3,
        teamId: TEAM_B,
        playerId: PLAYER(3),
      },
    ]);
    expect(result.append.every((pending) => pending.source === "yahoo")).toBe(true);
    expect(result.append.every((pending) => pending.revertsSequence === null)).toBe(true);
    expect(
      reduceDraft(snakeConfig(), [
        ...activeEvents,
        ...result.append.map((pending) => pending.event),
      ]).draftedPlayerIds,
    ).toHaveLength(3);
  });

  it("counts a matching manually-authored action as a confirmed Yahoo prefix", () => {
    const manualAction = snakeEvent(1, TEAM_A, 1);
    const result = reconcile({
      activeEvents: [manualAction],
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1)] },
    });

    expect(result).toEqual({ kind: "idempotent", append: [] });
  });

  it("uses deterministic keys scoped to the feed, draft, and provider pick", () => {
    const providerPick = pick(1, TEAM_KEY_A, 1);
    const key = yahooDraftPickIdempotencyKey({
      feedId: FEED_ID,
      draftId: DRAFT_ID,
      draftMode: "snake",
      pick: providerPick,
    });

    expect(
      yahooDraftPickIdempotencyKey({
        feedId: FEED_ID,
        draftId: DRAFT_ID,
        draftMode: "snake",
        pick: providerPick,
      }),
    ).toBe(key);
    expect(
      yahooDraftPickIdempotencyKey({
        feedId: "another-feed",
        draftId: DRAFT_ID,
        draftMode: "snake",
        pick: providerPick,
      }),
    ).not.toBe(key);
    expect(
      yahooDraftPickIdempotencyKey({
        feedId: FEED_ID,
        draftId: "another-draft",
        draftMode: "snake",
        pick: providerPick,
      }),
    ).not.toBe(key);
    expect(
      yahooDraftPickIdempotencyKey({
        feedId: FEED_ID,
        draftId: DRAFT_ID,
        draftMode: "snake",
        pick: pick(2, TEAM_KEY_B, 2),
      }),
    ).not.toBe(key);
  });
});

describe("Yahoo history fences", () => {
  it("holds outside the commissioner-confirmed standard-draft scope", () => {
    const unconfirmed = reconcile({
      standardScopeConfirmed: false,
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1)] },
    });
    const explicitKeeper = reconcile({
      snapshot: {
        collectionComplete: true,
        picks: [{ ...pick(1, TEAM_KEY_A, 1), keeper: true }],
      },
    });
    const keeperLedger = reconcile({
      activeEvents: [
        {
          id: draftEventId("manual-keeper:1"),
          type: "SNAKE_KEEPER_ASSIGNED",
          teamId: teamId(TEAM_A),
          playerId: playerId(PLAYER(1)),
          overallPick: 1,
          occurredAt: "2026-09-05T13:00:00.000Z",
        },
      ],
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1)] },
    });

    expect(heldIssue(unconfirmed)).toBe("KEEPER_SCOPE_UNVALIDATED");
    expect(heldIssue(explicitKeeper)).toBe("KEEPER_SCOPE_UNVALIDATED");
    expect(heldIssue(keeperLedger)).toBe("KEEPER_SCOPE_UNVALIDATED");
  });

  it("holds an explicitly incomplete provider collection", () => {
    expect(
      heldIssue(
        reconcile({
          snapshot: { collectionComplete: false, picks: [pick(1, TEAM_KEY_A, 1)] },
        }),
      ),
    ).toBe("INCOMPLETE_SNAPSHOT");
  });

  it("holds when Yahoo truncates an already-active ledger", () => {
    const result = reconcile({
      activeEvents: [snakeEvent(1, TEAM_A, 1), snakeEvent(2, TEAM_B, 2)],
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1)] },
    });

    expect(heldIssue(result)).toBe("HISTORY_TRUNCATED");
  });

  it("holds a changed or reordered active action without proposing a correction", () => {
    const changed = reconcile({
      activeEvents: [snakeEvent(1, TEAM_A, 1)],
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_A, 2)] },
      teamIdByKey: new Map([[TEAM_A, TEAM_A]]),
    });
    const reordered = reconcile({
      activeEvents: [snakeEvent(2, TEAM_B, 2), snakeEvent(1, TEAM_A, 1)],
      snapshot: {
        collectionComplete: true,
        picks: [pick(1, TEAM_KEY_A, 1), pick(2, TEAM_KEY_B, 2)],
      },
    });

    expect(heldIssue(changed)).toBe("HISTORY_DIVERGED");
    expect(heldIssue(reordered)).toBe("HISTORY_DIVERGED");
  });

  it("holds a gap or reordered provider sequence", () => {
    const result = reconcile({
      snapshot: {
        collectionComplete: true,
        picks: [pick(1, TEAM_KEY_A, 1), pick(3, TEAM_KEY_B, 2)],
      },
    });

    expect(heldIssue(result)).toBe("PICK_SEQUENCE_GAP");
  });
});

describe("Yahoo identity and mode validation", () => {
  it("holds a team key without an exact configured mapping", () => {
    const missing = reconcile({
      teamIdByKey: new Map(),
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1)] },
    });
    const outsideDraft = reconcile({
      teamIdByKey: new Map([[TEAM_KEY_A, "not-a-configured-team"]]),
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1)] },
    });

    expect(heldIssue(missing)).toBe("UNRESOLVED_TEAM");
    expect(heldIssue(outsideDraft)).toBe("UNRESOLVED_TEAM");
  });

  it("holds a player key without an exact configured mapping", () => {
    const result = reconcile({
      playerIdByKey: new Map(),
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1)] },
    });

    expect(heldIssue(result)).toBe("UNRESOLVED_PLAYER");
  });

  it("holds a Yahoo draft type that differs from the room", () => {
    const result = reconcile({ draftMode: "auction", config: snakeConfig() });

    expect(heldIssue(result)).toBe("DRAFT_TYPE_MISMATCH");
  });

  it("holds a cost attached to a snake pick", () => {
    const result = reconcile({
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1, 0)] },
    });

    expect(heldIssue(result)).toBe("SNAKE_COST_PRESENT");
  });
});

describe("Yahoo auction reconciliation", () => {
  it("maps a priced provider suffix to auction sale events", () => {
    const activeEvents = [auctionEvent(1, TEAM_A, 1, 47)];
    const result = reconcile({
      draftMode: "auction",
      config: auctionConfig(),
      activeEvents,
      snapshot: {
        collectionComplete: true,
        picks: [pick(1, TEAM_KEY_A, 1, 47), pick(2, TEAM_KEY_B, 2, 35)],
      },
    });

    expect(result.kind).toBe("append");
    if (result.kind !== "append") return;
    expect(result.append).toHaveLength(1);
    expect(result.append[0]!.event).toMatchObject({
      type: "AUCTION_PLAYER_SOLD",
      teamId: TEAM_B,
      playerId: PLAYER(2),
      price: 35,
    });
  });

  it("holds an auction pick with a missing or noninteger cost", () => {
    const common = { draftMode: "auction" as const, config: auctionConfig() };
    const missing = reconcile({
      ...common,
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1, null)] },
    });
    const noninteger = reconcile({
      ...common,
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_A, 1, 3.5)] },
    });

    expect(heldIssue(missing)).toBe("AUCTION_COST_MISSING");
    expect(heldIssue(noninteger)).toBe("AUCTION_COST_INVALID");
  });
});

describe("Yahoo reducer gate", () => {
  it("holds a resolved pick that violates snake ownership", () => {
    const result = reconcile({
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_B, 1)] },
    });

    expect(heldIssue(result)).toBe("REDUCER_INVARIANT");
  });

  it("validates the whole active ledger together with the proposed suffix", () => {
    const nomination: DraftEvent = {
      id: draftEventId("manual-nomination"),
      type: "AUCTION_NOMINATION_STARTED",
      teamId: teamId(TEAM_A),
      playerId: playerId(PLAYER(1)),
      nominationNumber: 1,
    };
    const result = reconcile({
      draftMode: "auction",
      config: auctionConfig(),
      activeEvents: [nomination],
      snapshot: { collectionComplete: true, picks: [pick(1, TEAM_KEY_B, 2, 10)] },
    });

    expect(heldIssue(result)).toBe("REDUCER_INVARIANT");
  });
});

describe("Yahoo prefix property gate", () => {
  it("preserves generated snake prefixes across realistic league sizes", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(4, 8, 10, 12, 14, 16),
        fc.integer({ min: 1, max: 3 }),
        fc.nat({ max: 47 }),
        fc.nat({ max: 47 }),
        (teamCount, rounds, prefixSeed, rotationSeed) => {
          const teamIds = Array.from({ length: teamCount }, (_, index) =>
            teamId(GENERATED_TEAM(index + 1)),
          );
          const teamKeys = Array.from({ length: teamCount }, (_, index) =>
            GENERATED_TEAM_KEY(index + 1),
          );
          const pickOrder = createSnakePickOrder(teamIds, rounds);
          const pickCount = pickOrder.length;
          const rotation = rotationSeed % pickCount;
          const playerNumbers = Array.from(
            { length: pickCount },
            (_, index) => ((index + rotation) % pickCount) + 1,
          );
          const keyByTeamId = new Map(teamIds.map((id, index) => [id, teamKeys[index]!]));
          const providerPicks = playerNumbers.map((playerNumber, index) => ({
            pick: index + 1,
            round: Math.floor(index / teamCount) + 1,
            teamKey: keyByTeamId.get(pickOrder[index]!)!,
            playerKey: PLAYER_KEY(playerNumber),
            cost: null,
          }));
          const prefixLength = prefixSeed % (pickCount + 1);
          const existing = playerNumbers
            .slice(0, prefixLength)
            .map((playerNumber, index) =>
              snakeEvent(index + 1, pickOrder[index]!, playerNumber, "snake-property"),
            );
          const config: DraftConfig = {
            mode: "SNAKE",
            teams: teamIds.map((id, index) => ({
              id,
              name: `Team ${index + 1}`,
              rosterSlots: slots(rounds),
            })),
            players: players(pickCount),
            pickOrder,
          };
          const result = reconcileYahooDraftSnapshot({
            feedId: FEED_ID,
            draftId: DRAFT_ID,
            draftMode: "snake",
            config,
            standardScopeConfirmed: true,
            activeEvents: existing,
            snapshot: { collectionComplete: true, picks: providerPicks },
            teamIdByKey: new Map(teamKeys.map((key, index) => [key, teamIds[index]!])),
            playerIdByKey: new Map(
              playerNumbers.map((number) => [PLAYER_KEY(number), PLAYER(number)]),
            ),
            occurredAt: NOW,
          });

          const completedEvents =
            result.kind === "append"
              ? [...existing, ...result.append.map((pending) => pending.event)]
              : existing;
          if (prefixLength === providerPicks.length) {
            expect(result).toEqual({ kind: "idempotent", append: [] });
          } else {
            expect(result.kind).toBe("append");
            if (result.kind !== "append") return;
            expect(result.append).toHaveLength(providerPicks.length - prefixLength);
          }
          const reduced = reduceDraft(config, completedEvents);
          expect(reduced.complete).toBe(true);
          expect(reduced.draftedPlayerIds).toHaveLength(pickCount);
          expect(
            reconcileYahooDraftSnapshot({
              feedId: FEED_ID,
              draftId: DRAFT_ID,
              draftMode: "snake",
              config,
              standardScopeConfirmed: true,
              activeEvents: completedEvents,
              snapshot: { collectionComplete: true, picks: providerPicks },
              teamIdByKey: new Map(teamKeys.map((key, index) => [key, teamIds[index]!])),
              playerIdByKey: new Map(
                playerNumbers.map((number) => [PLAYER_KEY(number), PLAYER(number)]),
              ),
              occurredAt: NOW,
            }),
          ).toEqual({ kind: "idempotent", append: [] });
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("preserves generated auction prefixes and exact prices", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(4, 8, 10, 12),
        fc.integer({ min: 1, max: 3 }),
        fc.nat({ max: 35 }),
        fc.nat({ max: 35 }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 100 }),
        (teamCount, rounds, prefixSeed, rotationSeed, minimumBid, priceSeed, budgetSlack) => {
          const pickCount = teamCount * rounds;
          const teamIds = Array.from({ length: teamCount }, (_, index) =>
            teamId(GENERATED_TEAM(index + 1)),
          );
          const teamKeys = Array.from({ length: teamCount }, (_, index) =>
            GENERATED_TEAM_KEY(index + 1),
          );
          const rotation = rotationSeed % pickCount;
          const playerNumbers = Array.from(
            { length: pickCount },
            (_, index) => ((index + rotation) % pickCount) + 1,
          );
          const prices = playerNumbers.map((_, index) => minimumBid + ((index + priceSeed) % 5));
          const providerPicks = playerNumbers.map((playerNumber, index) => ({
            pick: index + 1,
            round: Math.floor(index / teamCount) + 1,
            teamKey: teamKeys[index % teamCount]!,
            playerKey: PLAYER_KEY(playerNumber),
            cost: prices[index]!,
          }));
          const prefixLength = prefixSeed % (pickCount + 1);
          const existing = playerNumbers
            .slice(0, prefixLength)
            .map((playerNumber, index) =>
              auctionEvent(index + 1, teamIds[index % teamCount]!, playerNumber, prices[index]!),
            );
          const teamSpend = teamIds.map((_, teamIndex) =>
            prices.reduce(
              (sum, price, pickIndex) => sum + (pickIndex % teamCount === teamIndex ? price : 0),
              0,
            ),
          );
          const budget = Math.max(...teamSpend) + budgetSlack;
          const config: DraftConfig = {
            mode: "AUCTION",
            teams: teamIds.map((id, index) => ({
              id,
              name: `Team ${index + 1}`,
              rosterSlots: slots(rounds),
              budget,
            })),
            players: players(pickCount),
            minimumBid,
          };
          const result = reconcileYahooDraftSnapshot({
            feedId: FEED_ID,
            draftId: DRAFT_ID,
            draftMode: "auction",
            config,
            standardScopeConfirmed: true,
            activeEvents: existing,
            snapshot: { collectionComplete: true, picks: providerPicks },
            teamIdByKey: new Map(teamKeys.map((key, index) => [key, teamIds[index]!])),
            playerIdByKey: new Map(
              playerNumbers.map((number) => [PLAYER_KEY(number), PLAYER(number)]),
            ),
            occurredAt: NOW,
          });

          const completedEvents =
            result.kind === "append"
              ? [...existing, ...result.append.map((pending) => pending.event)]
              : existing;
          if (prefixLength === pickCount) {
            expect(result).toEqual({ kind: "idempotent", append: [] });
          } else {
            expect(result.kind).toBe("append");
            if (result.kind !== "append") return;
            expect(result.append).toHaveLength(pickCount - prefixLength);
            expect(
              result.append.map((pending) =>
                pending.event.type === "AUCTION_PLAYER_SOLD" ? pending.event.price : null,
              ),
            ).toEqual(prices.slice(prefixLength));
          }
          const reduced = reduceDraft(config, completedEvents);
          expect(reduced.complete).toBe(true);
          expect(reduced.draftedPlayerIds).toHaveLength(pickCount);
          expect(
            reconcileYahooDraftSnapshot({
              feedId: FEED_ID,
              draftId: DRAFT_ID,
              draftMode: "auction",
              config,
              standardScopeConfirmed: true,
              activeEvents: completedEvents,
              snapshot: { collectionComplete: true, picks: providerPicks },
              teamIdByKey: new Map(teamKeys.map((key, index) => [key, teamIds[index]!])),
              playerIdByKey: new Map(
                playerNumbers.map((number) => [PLAYER_KEY(number), PLAYER(number)]),
              ),
              occurredAt: NOW,
            }),
          ).toEqual({ kind: "idempotent", append: [] });
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
