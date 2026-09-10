import type { DecisionInboxItemState, InSeasonDecisionSnapshot } from "@laces-out/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  DecisionInboxService,
  type DecisionInboxAccess,
  type DecisionInboxReceipt,
  type DecisionInboxRepository,
} from "./decision-inbox.js";
import {
  decisionInboxSnapshot,
  INBOX_LEAGUE_ID as LEAGUE,
  INBOX_MEMBERSHIP_ID as MEMBERSHIP,
  INBOX_NOW as NOW,
  INBOX_OTHER_TEAM_ID as OTHER_TEAM,
  INBOX_OTHER_USER_ID as OTHER_USER,
  INBOX_TEAM_ID as TEAM,
  INBOX_USER_ID as USER,
} from "./decision-inbox-test-fixtures.js";

function harness(options: { ttl?: number; capacity?: number } = {}) {
  let time = Date.parse(NOW);
  const accesses = new Map<string, DecisionInboxAccess>([
    [USER, { membershipId: MEMBERSHIP, teamId: TEAM, revision: "sync-1" }],
    [OTHER_USER, { membershipId: "other-membership", teamId: OTHER_TEAM, revision: "sync-1" }],
  ]);
  const states = new Map<string, DecisionInboxReceipt>();
  const key = (scope: { userId: string; leagueId: string; teamId: string }, itemId: string) =>
    JSON.stringify([scope.userId, scope.leagueId, scope.teamId, itemId]);
  const repository = {
    findAccess: vi.fn<DecisionInboxRepository["findAccess"]>((userId, leagueId) =>
      Promise.resolve(leagueId === LEAGUE ? accesses.get(userId) : undefined),
    ),
    listReceipts: vi.fn<DecisionInboxRepository["listReceipts"]>((scope, ids) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const row = states.get(key(scope, id));
          return row ? [row] : [];
        }),
      ),
    ),
    saveReceipt: vi.fn<DecisionInboxRepository["saveReceipt"]>((scope, itemId, state, now) => {
      const receipt = { itemId, state, updatedAt: now.toISOString() };
      states.set(key(scope, itemId), receipt);
      return Promise.resolve(receipt);
    }),
  } satisfies DecisionInboxRepository;
  const getSnapshot = vi.fn((userId: string) =>
    Promise.resolve(
      decisionInboxSnapshot({
        team: {
          id: accesses.get(userId)?.teamId ?? TEAM,
          name: `${userId} private team`,
          faabRemaining: 82,
        },
      }),
    ),
  );
  const service = new DecisionInboxService(
    repository,
    { getSnapshot },
    () => new Date(time),
    options.ttl ?? 60_000,
    options.capacity ?? 128,
  );
  return {
    service,
    repository,
    accesses,
    getSnapshot,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("live Decision inbox service", () => {
  it("coalesces concurrent loads and keeps actor-private summaries separate", async () => {
    const h = harness();
    const [first, second, other] = await Promise.all([
      h.service.getInbox(USER, LEAGUE),
      h.service.getInbox(USER, LEAGUE),
      h.service.getInbox(OTHER_USER, LEAGUE),
    ]);
    expect(first).toEqual(second);
    expect(first?.team?.id).toBe(TEAM);
    expect(other?.team?.id).toBe(OTHER_TEAM);
    expect(h.getSnapshot).toHaveBeenCalledTimes(2);
    await h.service.getInbox(USER, LEAGUE);
    expect(h.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("invalidates on explicit refresh, TTL expiration and changed sync revision", async () => {
    const h = harness();
    await h.service.getInbox(USER, LEAGUE);
    await h.service.getInbox(USER, LEAGUE, { refresh: true });
    h.advance(60_001);
    await h.service.getInbox(USER, LEAGUE);
    h.accesses.set(USER, { ...h.accesses.get(USER)!, revision: "sync-2" });
    await h.service.getInbox(USER, LEAGUE);
    expect(h.getSnapshot).toHaveBeenCalledTimes(4);
  });

  it("bounds cached summaries", async () => {
    const h = harness({ capacity: 1 });
    await h.service.getInbox(USER, LEAGUE);
    await h.service.getInbox(OTHER_USER, LEAGUE);
    await h.service.getInbox(USER, LEAGUE);
    expect(h.getSnapshot).toHaveBeenCalledTimes(3);
  });

  it("rechecks membership and the current claim on cache hits and rejects obsolete items", async () => {
    const h = harness();
    const first = await h.service.getInbox(USER, LEAGUE);
    const itemId = first!.items[0]!.id;
    h.accesses.set(USER, { ...h.accesses.get(USER)!, teamId: OTHER_TEAM });
    const changed = await h.service.getInbox(USER, LEAGUE);
    expect(changed?.team?.id).toBe(OTHER_TEAM);
    expect(await h.service.setState(USER, LEAGUE, itemId, "reviewed")).toBeUndefined();
    h.accesses.delete(USER);
    expect(await h.service.getInbox(USER, LEAGUE)).toBeUndefined();
    expect(
      await h.service.setState(USER, LEAGUE, changed!.items[0]!.id, "dismissed"),
    ).toBeUndefined();
    expect(h.repository.saveReceipt).not.toHaveBeenCalled();
  });

  it("does not return a private snapshot if access changes while it computes", async () => {
    const h = harness();
    h.getSnapshot.mockImplementationOnce(async () => {
      h.accesses.delete(USER);
      return decisionInboxSnapshot();
    });
    expect(await h.service.getInbox(USER, LEAGUE)).toBeUndefined();
  });

  it("persists reviewed, dismissed and reopened state without recomputing the engines", async () => {
    const h = harness();
    const itemId = (await h.service.getInbox(USER, LEAGUE))!.items[0]!.id;
    for (const state of ["reviewed", "dismissed", "open"] satisfies DecisionInboxItemState[]) {
      expect(await h.service.setState(USER, LEAGUE, itemId, state)).toEqual({
        itemId,
        state,
        updatedAt: NOW,
      });
      expect((await h.service.getInbox(USER, LEAGUE))?.items[0]?.state).toBe(state);
    }
    expect(h.getSnapshot).toHaveBeenCalledTimes(1);
    expect(await h.service.setState(USER, LEAGUE, "f".repeat(64), "dismissed")).toBeUndefined();
  });

  it("retains unavailable reasons when no team is claimed and refuses mutations", async () => {
    const h = harness();
    h.accesses.set(USER, { ...h.accesses.get(USER)!, teamId: null });
    const unavailable: InSeasonDecisionSnapshot["lineup"] = {
      state: "unavailable",
      reasons: [{ code: "TEAM_UNCLAIMED", message: "Claim your team first." }],
    };
    h.getSnapshot.mockResolvedValue(
      decisionInboxSnapshot({
        team: null,
        lineup: unavailable,
        waivers: unavailable,
        trades: unavailable,
      }),
    );
    const result = await h.service.getInbox(USER, LEAGUE);
    expect(result?.items).toEqual([]);
    expect(result?.sections[0]?.reasons[0]?.code).toBe("TEAM_UNCLAIMED");
    expect(await h.service.setState(USER, LEAGUE, "f".repeat(64), "reviewed")).toBeUndefined();
  });

  it("does not cache failures", async () => {
    const h = harness();
    h.getSnapshot.mockRejectedValueOnce(new Error("temporary read failure"));
    await expect(h.service.getInbox(USER, LEAGUE)).rejects.toThrow("temporary read failure");
    expect((await h.service.getInbox(USER, LEAGUE))?.items).toHaveLength(1);
    expect(h.getSnapshot).toHaveBeenCalledTimes(2);
  });
});
