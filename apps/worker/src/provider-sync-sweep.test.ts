import { describe, expect, it, vi } from "vitest";

import type { LeagueSyncJob } from "@fantasy/jobs";

import { ProviderSyncSweepService } from "./provider-sync-sweep.js";

const NOW = new Date("2026-09-24T15:00:00.000Z");

function context(signal = new AbortController().signal) {
  return { jobId: "provider-sweep-test", signal } as const;
}

describe("provider sync sweep", () => {
  it("expires stale intents without reading direct targets while direct sync is disabled", async () => {
    const expireRequests = vi.fn(async () => 2);
    const listDue = vi.fn(async () => []);
    const enqueue = vi.fn(async () => "job-1");
    const service = new ProviderSyncSweepService({
      enabled: false,
      targets: { expireRequests, listDue },
      enqueue,
      now: () => NOW,
    });

    await expect(
      service.sweepProviderSync({ requestedAt: "scheduled" }, context()),
    ).resolves.toEqual({ expired: 2, considered: 0, enqueued: 0 });
    expect(expireRequests).toHaveBeenCalledWith(NOW);
    expect(listDue).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("bounds selection, probes unverified states, and counts only newly queued jobs", async () => {
    const expireRequests = vi.fn(async () => 1);
    const listDue = vi.fn(async () => [
      { leagueSeasonId: "season-unknown", directCoreState: "unknown" as const },
      { leagueSeasonId: "season-private", directCoreState: "not-public" as const },
      { leagueSeasonId: "season-available", directCoreState: "available" as const },
      { leagueSeasonId: "season-degraded", directCoreState: "degraded" as const },
    ]);
    const enqueue = vi
      .fn<(job: LeagueSyncJob) => Promise<string | null>>()
      .mockResolvedValueOnce("job-1")
      .mockResolvedValueOnce("job-2")
      .mockResolvedValueOnce("job-3")
      .mockResolvedValueOnce(null);
    const service = new ProviderSyncSweepService({
      enabled: true,
      targets: { expireRequests, listDue },
      enqueue,
      now: () => NOW,
    });

    await expect(
      service.sweepProviderSync({ requestedAt: NOW.toISOString() }, context()),
    ).resolves.toEqual({ expired: 1, considered: 4, enqueued: 3 });
    expect(expireRequests).toHaveBeenCalledWith(NOW);
    expect(listDue).toHaveBeenCalledWith(NOW, 100);
    expect(enqueue.mock.calls.map(([job]) => job)).toEqual([
      {
        mode: "server-direct",
        leagueSeasonId: "season-unknown",
        reason: "provider-sweep",
        probe: true,
      },
      {
        mode: "server-direct",
        leagueSeasonId: "season-private",
        reason: "provider-sweep",
        probe: true,
      },
      {
        mode: "server-direct",
        leagueSeasonId: "season-available",
        reason: "provider-sweep",
        probe: false,
      },
      {
        mode: "server-direct",
        leagueSeasonId: "season-degraded",
        reason: "provider-sweep",
        probe: false,
      },
    ]);
  });

  it("stops before database work when shutdown already started", async () => {
    const controller = new AbortController();
    controller.abort();
    const expireRequests = vi.fn(async () => 0);
    const listDue = vi.fn(async () => []);
    const service = new ProviderSyncSweepService({
      enabled: true,
      targets: { expireRequests, listDue },
      enqueue: vi.fn(async () => null),
      now: () => NOW,
    });

    await expect(
      service.sweepProviderSync({ requestedAt: "scheduled" }, context(controller.signal)),
    ).rejects.toThrow("aborted during shutdown");
    expect(expireRequests).not.toHaveBeenCalled();
    expect(listDue).not.toHaveBeenCalled();
  });
});
