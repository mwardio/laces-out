import { createHash } from "node:crypto";

import { playerId, rosterSlotId, teamId, type RosterSlot } from "@fantasy/domain";
import { reduceDraft, type DraftConfig } from "@fantasy/engine-draft";
import { describe, expect, it } from "vitest";

import type { DraftSessionEventRecord } from "./draft-session.js";
import {
  acceptedProviderActions,
  canonicalProviderOrder,
  reconcileProviderObservation,
  type ProviderDraftAction,
  type ProviderPendingEvent,
  type ReconciliationPlan,
} from "./espn-live-draft-reconciler.js";

const FEED = "feed-1";
const TEAM_A = "40000000-0000-4000-8000-00000000000a";
const TEAM_B = "40000000-0000-4000-8000-00000000000b";
const PLAYER = (n: number): string => `50000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const eventIdFor = (key: string): string =>
  `espn:${createHash("sha256").update(key, "utf8").digest("hex")}`;

function slots(count: number): readonly RosterSlot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: rosterSlotId(`slot-${index + 1}`),
    type: "BENCH" as const,
    label: `Bench ${index + 1}`,
    kind: "BENCH" as const,
    eligiblePositions: ["QB", "RB", "WR", "TE"] as const,
  }));
}

function snakeConfig(rounds = 2, playerCount = 12): DraftConfig {
  const order: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const forward = round % 2 === 0;
    order.push(...(forward ? [TEAM_A, TEAM_B] : [TEAM_B, TEAM_A]));
  }
  return {
    mode: "SNAKE",
    teams: [
      { id: teamId(TEAM_A), name: "Ditka's Revenge", rosterSlots: slots(rounds) },
      { id: teamId(TEAM_B), name: "Finkle Is Einhorn", rosterSlots: slots(rounds) },
    ],
    players: Array.from({ length: playerCount }, (_, index) => ({
      id: playerId(PLAYER(index + 1)),
      name: `Player ${index + 1}`,
      positions: ["RB" as const],
    })),
    pickOrder: order.map((id) => teamId(id)),
  };
}

function auctionConfig(slotCount = 2, budget = 200): DraftConfig {
  return {
    mode: "AUCTION",
    teams: [
      { id: teamId(TEAM_A), name: "Ditka's Revenge", rosterSlots: slots(slotCount), budget },
      { id: teamId(TEAM_B), name: "Finkle Is Einhorn", rosterSlots: slots(slotCount), budget },
    ],
    players: Array.from({ length: 12 }, (_, index) => ({
      id: playerId(PLAYER(index + 1)),
      name: `Player ${index + 1}`,
      positions: ["RB" as const],
    })),
    minimumBid: 1,
  };
}

function snakePick(overallPick: number, team: string, player: number, keeper = false) {
  return {
    kind: "snake-pick" as const,
    overallPick,
    teamId: team,
    playerId: PLAYER(player),
    keeper,
  };
}

function auctionSale(team: string, player: number, price: number, keeper = false) {
  return { kind: "auction-sale" as const, teamId: team, playerId: PLAYER(player), price, keeper };
}

/** Applies a plan's appended events to a ledger the way the repository would. */
function commit(
  events: readonly DraftSessionEventRecord[],
  append: readonly ProviderPendingEvent[],
): DraftSessionEventRecord[] {
  return [
    ...events,
    ...append.map((pending, index) => ({
      sequence: events.length + index + 1,
      idempotencyKey: pending.idempotencyKey,
      source: pending.source,
      occurredAt: "2026-08-24T18:00:00.000Z",
      revertsSequence: pending.revertsSequence,
      event: pending.event,
    })),
  ];
}

function reconcile(
  config: DraftConfig,
  events: readonly DraftSessionEventRecord[],
  observed: readonly ProviderDraftAction[],
  destructiveConfirmed = false,
): ReconciliationPlan {
  return reconcileProviderObservation({
    feedId: FEED,
    config,
    events,
    observed,
    occurredAt: new Date("2026-08-24T18:00:00.000Z"),
    destructiveConfirmed,
    eventIdFor,
  });
}

function appendOf(plan: ReconciliationPlan): readonly ProviderPendingEvent[] {
  if (plan.kind === "forward" || plan.kind === "destructive") return plan.append;
  throw new Error(`expected an appending plan, received ${plan.kind}`);
}

describe("provider action ordering", () => {
  it("replays keepers before live picks so a keeper's slot is consumed first", () => {
    const ordered = canonicalProviderOrder([
      snakePick(1, TEAM_A, 1),
      snakePick(4, TEAM_A, 9, true),
      snakePick(2, TEAM_B, 2),
    ]);
    expect(ordered.map((action) => (action as { overallPick: number }).overallPick)).toEqual([
      4, 1, 2,
    ]);
  });

  it("is stable as picks accumulate, so forward movement never reads as a rewrite", () => {
    const first = canonicalProviderOrder([snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)]);
    const later = canonicalProviderOrder([
      snakePick(2, TEAM_B, 2),
      snakePick(1, TEAM_A, 1),
      snakePick(3, TEAM_B, 3),
    ]);
    expect(later.slice(0, 2)).toEqual(first);
  });
});

describe("forward reconciliation", () => {
  it("appends nothing when the observed board matches the ledger", () => {
    const config = snakeConfig();
    const first = reconcile(config, [], [snakePick(1, TEAM_A, 1)]);
    const ledger = commit([], appendOf(first));
    expect(reconcile(config, ledger, [snakePick(1, TEAM_A, 1)])).toEqual({ kind: "idempotent" });
  });

  it("appends only the suffix when the board moves forward", () => {
    const config = snakeConfig();
    const ledger = commit([], appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1)])));
    const plan = reconcile(config, ledger, [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)]);
    const append = appendOf(plan);
    expect(plan.kind).toBe("forward");
    expect(append).toHaveLength(1);
    expect(append[0]!.event.type).toBe("SNAKE_PLAYER_SELECTED");
  });

  it("produces a ledger the draft engine accepts", () => {
    const config = snakeConfig();
    let ledger: DraftSessionEventRecord[] = [];
    const board = [
      snakePick(1, TEAM_A, 1),
      snakePick(2, TEAM_B, 2),
      snakePick(3, TEAM_B, 3),
      snakePick(4, TEAM_A, 4),
    ];
    for (let count = 1; count <= board.length; count += 1) {
      const plan = reconcile(config, ledger, board.slice(0, count));
      if (plan.kind === "idempotent") continue;
      ledger = commit(ledger, appendOf(plan));
    }
    const state = reduceDraft(
      config,
      ledger.map((record) => record.event),
    );
    expect(state.complete).toBe(true);
    expect(state.draftedPlayerIds).toHaveLength(4);
  });

  it("derives keys that make a replayed upload byte-identical", () => {
    const config = snakeConfig();
    const once = appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1)]));
    const twice = appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1)]));
    expect(once[0]!.idempotencyKey).toBe(twice[0]!.idempotencyKey);
    expect(once[0]!.event.id).toBe(twice[0]!.event.id);
  });

  it("tags every provider event with espn provenance", () => {
    const append = appendOf(reconcile(snakeConfig(), [], [snakePick(1, TEAM_A, 1)]));
    expect(append.every((pending) => pending.source === "espn")).toBe(true);
  });
});

describe("keepers", () => {
  it("assigns a snake keeper to its own later slot and still replays picks in order", () => {
    const config = snakeConfig();
    const plan = reconcile(config, [], [snakePick(1, TEAM_A, 1), snakePick(4, TEAM_A, 9, true)]);
    const append = appendOf(plan);
    expect(append[0]!.event.type).toBe("SNAKE_KEEPER_ASSIGNED");
    expect(append[1]!.event.type).toBe("SNAKE_PLAYER_SELECTED");
    const state = reduceDraft(
      config,
      commit([], append).map((record) => record.event),
    );
    expect(state.draftedPlayerIds).toHaveLength(2);
  });

  it("records an auction keeper distinctly from a sale", () => {
    const config = auctionConfig();
    const append = appendOf(
      reconcile(config, [], [auctionSale(TEAM_A, 9, 0, true), auctionSale(TEAM_B, 2, 15)]),
    );
    expect(append.map((pending) => pending.event.type)).toEqual([
      "AUCTION_KEEPER_ASSIGNED",
      "AUCTION_PLAYER_SOLD",
    ]);
  });
});

describe("auction sales", () => {
  it("persists the sale price and leaves the bidding war out of the ledger", () => {
    const config = auctionConfig();
    const append = appendOf(reconcile(config, [], [auctionSale(TEAM_A, 1, 47)]));
    expect(append).toHaveLength(1);
    expect(append[0]!.event).toMatchObject({ type: "AUCTION_PLAYER_SOLD", price: 47 });
    const state = reduceDraft(
      config,
      commit([], append).map((record) => record.event),
    );
    expect(state.teams.find((team) => team.teamId === TEAM_A)?.spent).toBe(47);
  });

  it("holds a sale that would exceed a team's legal maximum bid", () => {
    const config = auctionConfig(2, 20);
    const plan = reconcile(config, [], [auctionSale(TEAM_A, 1, 20)]);
    expect(plan).toMatchObject({ kind: "held", issue: "REDUCER_INVARIANT" });
  });
});

describe("rollback and correction", () => {
  it("holds the first destructive snapshot instead of rewriting history", () => {
    const config = snakeConfig();
    const ledger = commit(
      [],
      appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)])),
    );
    const plan = reconcile(config, ledger, [snakePick(1, TEAM_A, 1)]);
    expect(plan).toMatchObject({ kind: "destructive-hold", commonPrefix: 1, supersededActions: 1 });
  });

  it("reverts newest-first once the same rollback is confirmed", () => {
    const config = snakeConfig();
    const ledger = commit(
      [],
      appendOf(
        reconcile(
          config,
          [],
          [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2), snakePick(3, TEAM_B, 3)],
        ),
      ),
    );
    const plan = reconcile(config, ledger, [snakePick(1, TEAM_A, 1)], true);
    const append = appendOf(plan);
    expect(plan.kind).toBe("destructive");
    expect(append.map((pending) => pending.revertsSequence)).toEqual([3, 2]);
    const state = reduceDraft(
      config,
      commit(ledger, append).map((record) => record.event),
    );
    expect(state.draftedPlayerIds).toHaveLength(1);
  });

  it("replaces a corrected pick with the right player", () => {
    const config = snakeConfig();
    const ledger = commit(
      [],
      appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)])),
    );
    const plan = reconcile(
      config,
      ledger,
      [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 7)],
      true,
    );
    const append = appendOf(plan);
    expect(append[0]!.event.type).toBe("DRAFT_EVENT_REVERTED");
    expect(append[1]!.event).toMatchObject({ type: "SNAKE_PLAYER_SELECTED", overallPick: 2 });
    const state = reduceDraft(
      config,
      commit(ledger, append).map((record) => record.event),
    );
    expect(state.draftedPlayerIds).toContain(PLAYER(7));
    expect(state.draftedPlayerIds).not.toContain(PLAYER(2));
  });

  it("keeps keys unique when the same slot is re-picked with the same player", () => {
    const config = snakeConfig();
    const ledger = commit(
      [],
      appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)])),
    );
    const rolledBack = commit(
      ledger,
      appendOf(reconcile(config, ledger, [snakePick(1, TEAM_A, 1)], true)),
    );
    const replayed = appendOf(
      reconcile(config, rolledBack, [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)]),
    );
    const existing = new Set(rolledBack.map((record) => record.idempotencyKey));
    expect(replayed).toHaveLength(1);
    expect(existing.has(replayed[0]!.idempotencyKey)).toBe(false);
  });

  it("never rewrites a room that contains manual events", () => {
    const config = snakeConfig();
    const ledger = commit(
      [],
      appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)])),
    );
    const withManual: DraftSessionEventRecord[] = [
      ...ledger,
      {
        sequence: ledger.length + 1,
        idempotencyKey: "manual-entry-000001",
        source: "manual",
        occurredAt: "2026-08-24T18:10:00.000Z",
        revertsSequence: null,
        event: {
          id: "manual:abc",
          type: "SNAKE_PLAYER_SELECTED",
          teamId: TEAM_B,
          playerId: PLAYER(3),
          overallPick: 3,
          occurredAt: "2026-08-24T18:10:00.000Z",
        },
      } as unknown as DraftSessionEventRecord,
    ];
    const plan = reconcile(config, withManual, [snakePick(1, TEAM_A, 1)], true);
    expect(plan).toMatchObject({ kind: "held", issue: "MANUAL_BACKUP_ACTIVE" });
  });
});

describe("fail-closed behavior", () => {
  it("holds an observation whose picks violate snake order", () => {
    const config = snakeConfig();
    const plan = reconcile(config, [], [snakePick(2, TEAM_B, 2)]);
    expect(plan).toMatchObject({ kind: "held", issue: "REDUCER_INVARIANT" });
  });

  it("holds an observation that drafts one player twice", () => {
    const config = snakeConfig();
    const plan = reconcile(config, [], [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 1)]);
    expect(plan).toMatchObject({ kind: "held", issue: "REDUCER_INVARIANT" });
  });

  it("holds a pick attributed to the wrong owner of that slot", () => {
    const config = snakeConfig();
    const plan = reconcile(config, [], [snakePick(1, TEAM_B, 1)]);
    expect(plan).toMatchObject({ kind: "held", issue: "REDUCER_INVARIANT" });
  });

  it("treats an empty render as a rollback candidate, never an immediate wipe", () => {
    const config = snakeConfig();
    const ledger = commit([], appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1)])));
    expect(reconcile(config, ledger, [])).toMatchObject({ kind: "destructive-hold" });
  });
});

describe("accepted action recovery", () => {
  it("ignores reverted events when rebuilding the standing board", () => {
    const config = snakeConfig();
    const ledger = commit(
      [],
      appendOf(reconcile(config, [], [snakePick(1, TEAM_A, 1), snakePick(2, TEAM_B, 2)])),
    );
    const rolledBack = commit(
      ledger,
      appendOf(reconcile(config, ledger, [snakePick(1, TEAM_A, 1)], true)),
    );
    const { actions } = acceptedProviderActions(rolledBack);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toMatchObject({ overallPick: 1 });
  });
});
