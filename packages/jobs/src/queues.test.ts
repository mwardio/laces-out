import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import {
  deadLetterQueueNames,
  enqueueDataHealthCheck,
  enqueueDataRefresh,
  enqueueLeagueSync,
  enqueueProjectionRefresh,
  enqueueRosProjectionRefresh,
  enqueueProviderSyncSweep,
  enqueueRecommendationRecompute,
  queueNames,
  registerQueues,
} from "./queues.js";

function sendHarness() {
  const send = vi.fn(() => Promise.resolve("job-id"));
  return { boss: { send } as unknown as PgBoss, send };
}

function registrationHarness() {
  const created = new Map<string, Record<string, unknown>>();
  const updated = new Map<string, Record<string, unknown>>();
  const boss = {
    createQueue: vi.fn((name: string, configuration: Record<string, unknown>) => {
      created.set(name, configuration);
      return Promise.resolve();
    }),
    updateQueue: vi.fn((name: string, configuration: Record<string, unknown>) => {
      updated.set(name, configuration);
      return Promise.resolve();
    }),
  } as unknown as PgBoss;
  return { boss, created, updated };
}

describe("shared queue dispatch contract", () => {
  it("serializes league sync per connection and league season", async () => {
    const { boss, send } = sendHarness();

    await enqueueLeagueSync(boss, {
      connectionId: "connection-1",
      leagueSeasonId: "league-1",
      reason: "manual",
    });

    expect(send).toHaveBeenCalledWith(
      queueNames.syncLeague,
      expect.any(Object),
      expect.objectContaining({
        group: { id: "league-season:league-1" },
        singletonKey: "league-sync:connection-1:league-1",
        singletonSeconds: 60,
      }),
    );
  });

  it("deduplicates identity bootstrap independently from full connection refreshes", async () => {
    const { boss, send } = sendHarness();

    await enqueueLeagueSync(boss, {
      mode: "connection",
      connectionId: "connection-1",
      leagueSeasonId: "league-1",
      reason: "identity-bootstrap",
    });
    for (const reason of ["manual", "scheduled", "stale-on-view", "draft"] as const) {
      await enqueueLeagueSync(boss, {
        mode: "connection",
        connectionId: "connection-1",
        leagueSeasonId: "league-1",
        reason,
      });
    }

    const calls = send.mock.calls as unknown as Array<
      [queue: string, payload: unknown, options: unknown]
    >;
    expect(calls.map((call) => call[2])).toEqual([
      {
        group: { id: "league-season:league-1" },
        singletonKey: "league-sync:identity-bootstrap:connection-1:league-1",
        singletonSeconds: 60,
      },
      ...Array.from({ length: 4 }, () => ({
        group: { id: "league-season:league-1" },
        singletonKey: "league-sync:connection-1:league-1",
        singletonSeconds: 60,
      })),
    ]);
    expect(calls[0]?.[1]).toMatchObject({
      mode: "connection",
      reason: "identity-bootstrap",
    });
  });

  it("rejects identity bootstrap on the unauthenticated server-direct path", () => {
    const { boss, send } = sendHarness();

    expect(() =>
      enqueueLeagueSync(boss, {
        mode: "server-direct",
        leagueSeasonId: "league-1",
        reason: "identity-bootstrap",
      }),
    ).toThrow("identity bootstrap requires connection mode");
    expect(send).not.toHaveBeenCalled();
  });

  it("serializes server-direct reads with the same league group and a mode-specific singleton", async () => {
    const { boss, send } = sendHarness();

    await enqueueLeagueSync(boss, {
      mode: "server-direct",
      leagueSeasonId: "league-1",
      refreshRequestId: "refresh-1",
      reason: "stale-on-view",
      probe: false,
    });

    expect(send).toHaveBeenCalledWith(
      queueNames.syncLeague,
      expect.any(Object),
      expect.objectContaining({
        group: { id: "league-season:league-1" },
        singletonKey: "league-sync:server-direct:league-1",
        singletonSeconds: 60,
      }),
    );
  });

  it("accepts a refresh request id on an authenticated server-session sync", async () => {
    const { boss, send } = sendHarness();

    await enqueueLeagueSync(boss, {
      mode: "connection",
      connectionId: "connection-1",
      leagueSeasonId: "league-1",
      refreshRequestId: "refresh-1",
      reason: "stale-on-view",
    });

    expect(send).toHaveBeenCalledWith(
      queueNames.syncLeague,
      expect.objectContaining({
        connectionId: "connection-1",
        refreshRequestId: "refresh-1",
      }),
      expect.objectContaining({
        group: { id: "league-season:league-1" },
        singletonKey: "league-sync:connection-1:league-1",
      }),
    );
  });

  it("keeps direct probes off authenticated connection jobs", () => {
    const { boss, send } = sendHarness();

    expect(() =>
      enqueueLeagueSync(boss, {
        mode: "connection",
        connectionId: "connection-1",
        leagueSeasonId: "league-1",
        reason: "stale-on-view",
        probe: false,
      }),
    ).toThrow("probe requires server-direct mode");
    expect(send).not.toHaveBeenCalled();
  });

  it("deduplicates automated Yahoo fallbacks per league even when selection changes connection", async () => {
    const { boss, send } = sendHarness();

    await enqueueLeagueSync(boss, {
      mode: "connection",
      connectionId: "connection-primary",
      leagueSeasonId: "league-1",
      reason: "provider-sweep",
    });
    await enqueueLeagueSync(boss, {
      mode: "connection",
      connectionId: "connection-fallback",
      leagueSeasonId: "league-1",
      reason: "provider-sweep",
    });

    for (const call of send.mock.calls) {
      expect(call).toEqual([
        queueNames.syncLeague,
        expect.any(Object),
        expect.objectContaining({
          group: { id: "league-season:league-1" },
          singletonKey: "league-sync:provider-sweep:league-1",
          singletonSeconds: 60,
        }),
      ]);
    }
  });

  it("coalesces provider sweeps and rejects malformed timestamps before enqueue", async () => {
    const { boss, send } = sendHarness();

    await enqueueProviderSyncSweep(boss, { requestedAt: "scheduled" });

    expect(send).toHaveBeenCalledWith(
      queueNames.providerSyncSweep,
      { requestedAt: "scheduled" },
      expect.objectContaining({
        group: { id: "provider-sync-sweep" },
        singletonKey: "provider-sync-sweep",
        singletonSeconds: 300,
      }),
    );
    expect(() => enqueueProviderSyncSweep(boss, { requestedAt: "not-a-date" })).toThrow(
      "ISO timestamp",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("serializes recomputation per league season and sorts deduplicated kinds", async () => {
    const { boss, send } = sendHarness();

    await enqueueRecommendationRecompute(boss, {
      leagueSeasonId: "league-1",
      kinds: ["waiver", "lineup", "waiver"],
    });

    expect(send).toHaveBeenCalledWith(
      queueNames.recomputeRecommendations,
      expect.any(Object),
      expect.objectContaining({
        group: { id: "league-season:league-1" },
        singletonKey: "recommendations:league-1:lineup,waiver",
        singletonSeconds: 30,
      }),
    );
  });

  it("rejects an unsupported recommendation kind before it reaches a queue", () => {
    const { boss, send } = sendHarness();

    // Validation runs before the send, so the throw is synchronous. Preserved verbatim from the
    // worker-local original: an enqueue that reached pg-boss with an unknown kind would burn the
    // full retry budget in the handler and dead-letter a job nothing can ever execute.
    expect(() =>
      enqueueRecommendationRecompute(boss, {
        leagueSeasonId: "league-1",
        kinds: ["playoffs"] as never,
      }),
    ).toThrow("unsupported recommendation kind");
    expect(send).not.toHaveBeenCalled();
  });

  it("serializes shared NFL data refresh on the one global key both processes use", async () => {
    const { boss, send } = sendHarness();

    await enqueueDataRefresh(boss, {
      requestedBy: "user-1",
      scope: "player-data",
      reason: "user",
      requestedAt: "2026-09-10T12:00:00.000Z",
    });

    expect(send).toHaveBeenCalledWith(
      queueNames.dataRefresh,
      expect.any(Object),
      expect.objectContaining({
        group: { id: "shared-nfl-data" },
        singletonKey: "shared-nfl-data",
        singletonSeconds: 60,
      }),
    );
  });

  it("serializes weekly and full projection work independently per season", async () => {
    const { boss, send } = sendHarness();

    await enqueueProjectionRefresh(boss, { season: 2026 });
    await enqueueProjectionRefresh(boss, { season: 2026, week: 4 });
    await enqueueProjectionRefresh(boss, { season: 2026, horizon: "weekly" });

    expect(send).toHaveBeenNthCalledWith(
      1,
      queueNames.refreshProjections,
      expect.any(Object),
      expect.objectContaining({ singletonKey: "projection-refresh:2026:season:full" }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      queueNames.refreshProjections,
      expect.any(Object),
      expect.objectContaining({ singletonKey: "projection-refresh:2026:week-4:full" }),
    );
    expect(send).toHaveBeenNthCalledWith(
      3,
      queueNames.refreshProjections,
      expect.any(Object),
      expect.objectContaining({ singletonKey: "projection-refresh:2026:season:weekly" }),
    );
  });

  it("dispatches ROS work onto its isolated queue", async () => {
    const { boss, send } = sendHarness();

    await enqueueRosProjectionRefresh(boss, {
      season: 2026,
      horizon: "full",
      reason: "scheduled",
    });

    expect(send).toHaveBeenCalledWith(
      queueNames.refreshRosProjections,
      { season: 2026, horizon: "full", reason: "scheduled" },
      expect.objectContaining({
        group: { id: "ros-projections" },
        singletonKey: "ros-projection-refresh:2026:scheduled",
      }),
    );
  });

  it("coalesces data health checks onto one globally serialized key", async () => {
    const { boss, send } = sendHarness();

    await enqueueDataHealthCheck(boss, { source: "schedule" });

    expect(send).toHaveBeenCalledWith(
      queueNames.dataHealth,
      expect.any(Object),
      expect.objectContaining({ group: { id: "data-health" }, singletonKey: "data-health" }),
    );
  });

  it("pairs every queue with its own dead-letter queue", () => {
    for (const key of Object.keys(queueNames) as (keyof typeof queueNames)[]) {
      expect(deadLetterQueueNames[key]).toBe(`${queueNames[key]}-dead-letter`);
    }
  });
});

describe("registerQueues", () => {
  it("registers every queue and its dead-letter queue exactly once", async () => {
    const { boss, created, updated } = registrationHarness();

    await registerQueues(boss);

    const expected = [
      ...Object.values(queueNames),
      ...Object.values(deadLetterQueueNames),
    ].toSorted();
    expect([...created.keys()].toSorted()).toEqual(expected);
    // pg-boss treats createQueue as a no-op for an existing queue, so an update must follow every
    // create or a deployment predating a setting never receives it.
    expect([...updated.keys()].toSorted()).toEqual(expected);
    for (const name of expected) {
      expect(updated.get(name)).toEqual(created.get(name));
    }
  });

  it("gives every work queue bounded retries, backoff, retention, and a dead-letter target", async () => {
    const { boss, created } = registrationHarness();

    await registerQueues(boss);

    for (const key of Object.keys(queueNames) as (keyof typeof queueNames)[]) {
      const configuration = created.get(queueNames[key]);
      expect(configuration, `${queueNames[key]} was never registered`).toBeDefined();
      // Section 2.4 requires bounded retries, exponential backoff, dead-letter visibility, and
      // retention on every important queue. A registration that omits any of these is the exact
      // drift that a hand-copied queue configuration produced before this package existed.
      expect(configuration?.retryBackoff).toBe(true);
      expect(configuration?.deadLetter).toBe(deadLetterQueueNames[key]);
      for (const setting of [
        "retryLimit",
        "retryDelay",
        "retryDelayMax",
        "expireInSeconds",
        "retentionSeconds",
        "deleteAfterSeconds",
        "warningQueueSize",
      ] as const) {
        expect(typeof configuration?.[setting], `${queueNames[key]} is missing ${setting}`).toBe(
          "number",
        );
      }
    }
  });

  it("never retries a dead-letter queue and keeps it long enough to inspect", async () => {
    const { boss, created } = registrationHarness();

    await registerQueues(boss);

    for (const name of Object.values(deadLetterQueueNames)) {
      expect(created.get(name)).toMatchObject({
        retryLimit: 0,
        retentionSeconds: 30 * 86_400,
        deleteAfterSeconds: 30 * 86_400,
      });
      // pg-boss refuses to start when expiration reaches 24 hours.
      expect(created.get(name)?.expireInSeconds).toBeLessThan(24 * 60 * 60);
    }
  });
});
