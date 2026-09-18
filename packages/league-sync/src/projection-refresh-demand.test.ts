import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ProjectionRefreshDemandDispatcher,
  type ProjectionRefreshDemand,
} from "./projection-refresh-demand.js";

function fixture(demands: readonly ProjectionRefreshDemand[] = []) {
  const pending = new Map(demands.map((row) => [row.leagueSeasonId, row.demandId]));
  const repository = {
    capture: vi.fn(async (_season: number, limit: number) =>
      [...pending]
        .slice(0, limit)
        .map(([leagueSeasonId, demandId]) => ({ leagueSeasonId, demandId })),
    ),
    acknowledge: vi.fn(async (captured: readonly ProjectionRefreshDemand[]) => {
      for (const row of captured)
        if (pending.get(row.leagueSeasonId) === row.demandId) pending.delete(row.leagueSeasonId);
    }),
  };
  const enqueue = vi.fn<(season: number) => Promise<string | null>>(async () => randomUUID());
  const dispatcher = new ProjectionRefreshDemandDispatcher({ repository, enqueue });
  return { pending, repository, enqueue, dispatcher };
}

const demand = (): ProjectionRefreshDemand => ({
  leagueSeasonId: randomUUID(),
  demandId: randomUUID(),
});

describe("durable league projection demand", () => {
  it("does no queue work without demand but preserves explicit refresh requests", async () => {
    const test = fixture();
    expect(await test.dispatcher.dispatch(2026)).toBeNull();
    expect(test.enqueue).not.toHaveBeenCalled();
    await test.dispatcher.dispatch(2026, { enqueueWithoutDemand: true });
    expect(test.enqueue).toHaveBeenCalledExactlyOnceWith(2026);
  });

  it("captures a bounded batch before enqueue and acknowledges only a durable job", async () => {
    const test = fixture(Array.from({ length: 101 }, demand));
    await test.dispatcher.dispatch(2026);
    expect(test.repository.capture).toHaveBeenCalledExactlyOnceWith(2026, 100);
    expect(test.pending.size).toBe(1);
    expect(test.enqueue.mock.invocationCallOrder[0]).toBeGreaterThan(
      test.repository.capture.mock.invocationCallOrder[0]!,
    );
    expect(test.repository.acknowledge.mock.invocationCallOrder[0]).toBeGreaterThan(
      test.enqueue.mock.invocationCallOrder[0]!,
    );
    await test.dispatcher.dispatch(2026);
    expect(test.pending.size).toBe(0);
    await test.dispatcher.dispatch(2026);
    expect(test.enqueue).toHaveBeenCalledTimes(2);
  });

  it("retains demand after coalescing and enqueue failure until a subsequent sweep succeeds", async () => {
    const row = demand();
    const test = fixture([row]);
    test.enqueue.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("queue unavailable"));
    expect(await test.dispatcher.dispatch(2026)).toBeNull();
    await expect(test.dispatcher.dispatch(2026)).rejects.toThrow("queue unavailable");
    expect(test.repository.acknowledge).not.toHaveBeenCalled();
    expect(test.pending.get(row.leagueSeasonId)).toBe(row.demandId);
    await test.dispatcher.dispatch(2026);
    expect(test.pending.size).toBe(0);
  });

  it("retains a newer sync committed during dispatch", async () => {
    const row = demand();
    const newer = randomUUID();
    const test = fixture([row]);
    test.enqueue.mockImplementationOnce(async () => {
      test.pending.set(row.leagueSeasonId, newer);
      return randomUUID();
    });
    await test.dispatcher.dispatch(2026);
    expect(test.repository.acknowledge).toHaveBeenCalledWith([row]);
    expect(test.pending.get(row.leagueSeasonId)).toBe(newer);
    await test.dispatcher.dispatch(2026);
    expect(test.pending.size).toBe(0);
  });

  it("recovers a send-before-ack failure through ordinary queue deduplication", async () => {
    const row = demand();
    const test = fixture([row]);
    test.repository.acknowledge.mockRejectedValueOnce(new Error("connection lost after send"));
    await expect(test.dispatcher.dispatch(2026)).rejects.toThrow("connection lost after send");
    test.enqueue.mockResolvedValueOnce(null);
    expect(await test.dispatcher.dispatch(2026)).toBeNull();
    expect(test.pending.get(row.leagueSeasonId)).toBe(row.demandId);
    await test.dispatcher.dispatch(2026);
    expect(test.pending.size).toBe(0);
  });

  it("does not enqueue after cancellation while reading demand", async () => {
    const test = fixture([demand()]);
    const controller = new AbortController();
    test.repository.capture.mockImplementationOnce(async () => {
      controller.abort();
      return [];
    });
    await expect(test.dispatcher.dispatch(2026, { signal: controller.signal })).rejects.toThrow();
    expect(test.enqueue).not.toHaveBeenCalled();
    expect(test.pending.size).toBe(1);
  });

  it("leaves a sent job's demand pending if cancelled before acknowledgement", async () => {
    const test = fixture([demand()]);
    const controller = new AbortController();
    test.enqueue.mockImplementationOnce(async () => {
      controller.abort();
      return randomUUID();
    });
    await expect(test.dispatcher.dispatch(2026, { signal: controller.signal })).rejects.toThrow();
    expect(test.repository.acknowledge).not.toHaveBeenCalled();
    expect(test.pending.size).toBe(1);
  });
});
