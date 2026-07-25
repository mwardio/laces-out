import type { Job, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deadLetterQueueNames,
  enqueueDataHealthCheck,
  enqueueLeagueSync,
  enqueueProjectionRefresh,
  enqueueRecommendationRecompute,
  ensureDailyRefresh,
  queueNames,
  registerQueues,
  registerSchedules,
  registerWorkers,
  type DataHealthJob,
  type DataRefreshJob,
  type LeagueSyncJob,
  type ProjectionRefreshJob,
  type RecommendationJob,
  type WorkerServices,
} from "./jobs.js";

type Handler = (jobs: Job<never>[]) => Promise<unknown>;

function bossHarness() {
  const handlers = new Map<string, Handler>();
  const createQueue = vi.fn(() => Promise.resolve());
  const updateQueue = vi.fn(() => Promise.resolve());
  const send = vi.fn(() => Promise.resolve("job-id"));
  const schedule = vi.fn(() => Promise.resolve());
  const work = vi.fn((name: string, ...input: unknown[]) => {
    handlers.set(name, input.at(-1) as Handler);
    return Promise.resolve(`worker:${name}`);
  });
  const boss = { createQueue, updateQueue, send, schedule, work } as unknown as PgBoss;
  return { boss, createQueue, updateQueue, send, schedule, work, handlers };
}

function loggerHarness() {
  const info = vi.fn();
  return { logger: { info } as unknown as Logger, info };
}

function job<T>(name: string, data: T, signal = new AbortController().signal): Job<T> {
  return {
    id: `${name}-job-id`,
    name,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal,
  };
}

async function run<T>(handlers: Map<string, Handler>, name: string, value: Job<T>): Promise<void> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing test handler for ${name}`);
  await handler([value as Job<never>]);
}

describe("worker queue reliability", () => {
  it("creates visible dead-letter queues and reapplies bounded retry settings", async () => {
    const { boss, createQueue, updateQueue } = bossHarness();

    await registerQueues(boss);

    for (const name of Object.values(deadLetterQueueNames)) {
      expect(createQueue).toHaveBeenCalledWith(
        name,
        expect.objectContaining({
          retryLimit: 0,
          expireInSeconds: 82_800,
          warningQueueSize: 1,
        }),
      );
      expect(updateQueue).toHaveBeenCalledWith(
        name,
        expect.objectContaining({ retryLimit: 0, retentionSeconds: 2_592_000 }),
      );
    }
    for (const [key, name] of Object.entries(queueNames)) {
      const expectedLimits = {
        syncLeague: { retryLimit: 5, retryDelayMax: 900, expireInSeconds: 900 },
        refreshProjections: { retryLimit: 4, retryDelayMax: 1_800, expireInSeconds: 1_800 },
        recomputeRecommendations: { retryLimit: 3, retryDelayMax: 300, expireInSeconds: 900 },
        dataHealth: { retryLimit: 2, retryDelayMax: 300, expireInSeconds: 300 },
        dataRefresh: { retryLimit: 5, retryDelayMax: 3_600, expireInSeconds: 1_800 },
        notificationSweep: { retryLimit: 2, retryDelayMax: 120, expireInSeconds: 300 },
      } as const;
      const limits = expectedLimits[key as keyof typeof expectedLimits];
      expect(createQueue).toHaveBeenCalledWith(
        name,
        expect.objectContaining({
          retryBackoff: true,
          retryDelayMax: limits.retryDelayMax,
          expireInSeconds: limits.expireInSeconds,
          deadLetter: deadLetterQueueNames[key as keyof typeof deadLetterQueueNames],
        }),
      );
      expect(updateQueue).toHaveBeenCalledWith(
        name,
        expect.objectContaining({ retryLimit: limits.retryLimit }),
      );
    }
  });

  it("registers single-job workers with global per-group concurrency", async () => {
    const { boss, work } = bossHarness();
    const { logger } = loggerHarness();

    await registerWorkers(boss, logger);

    expect(work).toHaveBeenCalledTimes(6);
    for (const name of Object.values(queueNames)) {
      expect(work).toHaveBeenCalledWith(
        name,
        { batchSize: 1, groupConcurrency: 1 },
        expect.any(Function),
      );
    }
  });
});

describe("typed worker service dispatch", () => {
  let harness: ReturnType<typeof bossHarness>;
  let logger: Logger;
  let info: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    harness = bossHarness();
    ({ logger, info } = loggerHarness());
  });

  it("awaits every configured operational service with cancellation context", async () => {
    const syncLeague = vi.fn(() => Promise.resolve());
    const refreshProjections = vi.fn(() => Promise.resolve());
    const recomputeRecommendations = vi.fn(() => Promise.resolve());
    const checkDataHealth = vi.fn(() =>
      Promise.resolve({
        checkedAt: "2026-07-21T12:00:00.000Z",
        enabledSources: 3,
        healthySources: 2,
        pendingSources: 0,
        degradedSources: 1,
        failingSources: 1,
        staleSources: 0,
        degradedSourceKeys: ["source-3"],
      }),
    );
    const services: WorkerServices = {
      leagueSync: { syncLeague },
      projectionRefresh: { refreshProjections },
      recommendationRecompute: { recomputeRecommendations },
      dataHealth: { checkDataHealth },
    };
    await registerWorkers(harness.boss, logger, services);

    const league: LeagueSyncJob = {
      connectionId: "connection-1",
      leagueSeasonId: "league-1",
      reason: "scheduled",
    };
    const projections: ProjectionRefreshJob = { season: 2026, week: 3 };
    const recommendations: RecommendationJob = {
      leagueSeasonId: "league-1",
      kinds: ["lineup", "waiver"],
    };
    const health: DataHealthJob = { source: "schedule" };

    const leagueWork = job(queueNames.syncLeague, league);
    await run(harness.handlers, queueNames.syncLeague, leagueWork);
    await run(
      harness.handlers,
      queueNames.refreshProjections,
      job(queueNames.refreshProjections, projections),
    );
    await run(
      harness.handlers,
      queueNames.recomputeRecommendations,
      job(queueNames.recomputeRecommendations, recommendations),
    );
    await run(harness.handlers, queueNames.dataHealth, job(queueNames.dataHealth, health));

    expect(syncLeague).toHaveBeenCalledWith(league, {
      jobId: "league-sync-job-id",
      signal: leagueWork.signal,
    });
    expect(refreshProjections).toHaveBeenCalledWith(
      projections,
      expect.objectContaining({ jobId: "projection-refresh-job-id" }),
    );
    expect(recomputeRecommendations).toHaveBeenCalledWith(
      recommendations,
      expect.objectContaining({ jobId: "recommendation-recompute-job-id" }),
    );
    expect(checkDataHealth).toHaveBeenCalledWith(
      health,
      expect.objectContaining({ jobId: "data-health-check-job-id" }),
    );
    expect(info).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      queueNames.syncLeague,
      { connectionId: "connection-1", leagueSeasonId: "league-1", reason: "manual" },
      "League sync service is not configured",
    ],
    [
      queueNames.refreshProjections,
      { season: 2026, reason: "scheduled" },
      "Projection refresh service is not configured",
    ],
    [
      queueNames.recomputeRecommendations,
      { leagueSeasonId: "league-1", kinds: ["trade"] },
      "Recommendation recompute service is not configured",
    ],
    [queueNames.dataHealth, { source: "schedule" }, "Data health service is not configured"],
    [
      queueNames.notificationSweep,
      { kind: "lineup-lock", reason: "scheduled" },
      "Notification sweep service is not configured",
    ],
  ])("fails closed when %s has no service", async (name, data, expected) => {
    await registerWorkers(harness.boss, logger);

    await expect(run(harness.handlers, name, job(name, data))).rejects.toThrow(expected);
    expect(info).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads before invoking a service", async () => {
    const refreshProjections = vi.fn(() => Promise.resolve());
    await registerWorkers(harness.boss, logger, {
      projectionRefresh: { refreshProjections },
    });

    await expect(
      run(
        harness.handlers,
        queueNames.refreshProjections,
        job(queueNames.refreshProjections, { season: 2026, week: 26 }),
      ),
    ).rejects.toThrow("week must be between 1 and 25");
    expect(refreshProjections).not.toHaveBeenCalled();
  });

  it("does not start an aborted job", async () => {
    const controller = new AbortController();
    controller.abort();
    const syncLeague = vi.fn(() => Promise.resolve());
    await registerWorkers(harness.boss, logger, { leagueSync: { syncLeague } });

    await expect(
      run(
        harness.handlers,
        queueNames.syncLeague,
        job(
          queueNames.syncLeague,
          { connectionId: "connection-1", leagueSeasonId: "league-1", reason: "manual" },
          controller.signal,
        ),
      ),
    ).rejects.toThrow("aborted during shutdown");
    expect(syncLeague).not.toHaveBeenCalled();
  });

  it("propagates service failures so pg-boss can retry the job", async () => {
    const failure = new Error("provider temporarily unavailable");
    await registerWorkers(harness.boss, logger, {
      leagueSync: { syncLeague: () => Promise.reject(failure) },
    });

    await expect(
      run(
        harness.handlers,
        queueNames.syncLeague,
        job(queueNames.syncLeague, {
          connectionId: "connection-1",
          leagueSeasonId: "league-1",
          reason: "scheduled",
        }),
      ),
    ).rejects.toBe(failure);
    expect(info).not.toHaveBeenCalled();
  });

  it("dispatches player, market, and ADP refreshes with user-forced checks", async () => {
    const refreshPlayerData = vi.fn(() =>
      Promise.resolve({
        nflverse: { state: "updated", rowsRead: 10, rowsWritten: 9, rowsRejected: 1 },
      }),
    );
    const refreshMarketData = vi.fn(() =>
      Promise.resolve({ state: "updated", rowsRead: 100, rowsWritten: 80, rowsRejected: 20 }),
    );
    const refreshAdpData = vi.fn(() =>
      Promise.resolve([{ state: "changed", rowsRead: 200, rowsWritten: 190, rowsRejected: 10 }]),
    );
    await registerWorkers(harness.boss, logger, {
      refreshPlayerData,
      refreshMarketData,
      refreshAdpData,
    });

    const player: DataRefreshJob = {
      requestedBy: "user-1",
      scope: "player-data",
      reason: "user",
      requestedAt: "2026-07-21T12:00:00.000Z",
    };
    const market: DataRefreshJob = {
      requestedBy: "system",
      scope: "market-data",
      reason: "scheduled",
      requestedAt: "scheduled",
    };
    const adp: DataRefreshJob = {
      requestedBy: "system",
      scope: "adp-data",
      reason: "startup-recovery",
      requestedAt: "2026-07-21T12:00:00.000Z",
    };
    await run(harness.handlers, queueNames.dataRefresh, job(queueNames.dataRefresh, player));
    await run(harness.handlers, queueNames.dataRefresh, job(queueNames.dataRefresh, market));
    await run(harness.handlers, queueNames.dataRefresh, job(queueNames.dataRefresh, adp));

    expect(refreshPlayerData).toHaveBeenCalledWith(true);
    expect(refreshMarketData).toHaveBeenCalledWith(false);
    expect(refreshAdpData).toHaveBeenCalledWith(false);
    expect(info).toHaveBeenCalledTimes(3);
  });

  it("fails closed when an ADP refresh is queued without its adapter", async () => {
    await registerWorkers(harness.boss, logger);

    await expect(
      run(
        harness.handlers,
        queueNames.dataRefresh,
        job(queueNames.dataRefresh, {
          requestedBy: "system",
          scope: "adp-data",
          reason: "daily",
          requestedAt: "scheduled",
        }),
      ),
    ).rejects.toThrow("Draft-market ADP adapter service is not configured");
  });
});

describe("dispatch contracts and schedules", () => {
  it("adds stable deduplication and global serialization metadata", async () => {
    const { boss, send } = bossHarness();

    await enqueueLeagueSync(boss, {
      connectionId: "connection-1",
      leagueSeasonId: "league-1",
      reason: "manual",
    });
    await enqueueProjectionRefresh(boss, { season: 2026, week: 4 });
    await enqueueRecommendationRecompute(boss, {
      leagueSeasonId: "league-1",
      kinds: ["waiver", "lineup", "waiver"],
    });
    await enqueueDataHealthCheck(boss, {
      source: "manual",
      requestedBy: "admin-1",
      requestedAt: "2026-07-21T12:00:00.000Z",
    });

    expect(send).toHaveBeenNthCalledWith(
      1,
      queueNames.syncLeague,
      expect.any(Object),
      expect.objectContaining({
        group: { id: "league-season:league-1" },
        singletonKey: "league-sync:connection-1:league-1",
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      queueNames.refreshProjections,
      expect.any(Object),
      expect.objectContaining({
        group: { id: "projections" },
        singletonKey: "projection-refresh:2026:week-4",
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      3,
      queueNames.recomputeRecommendations,
      expect.any(Object),
      expect.objectContaining({
        group: { id: "league-season:league-1" },
        singletonKey: "recommendations:league-1:lineup,waiver",
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      4,
      queueNames.dataHealth,
      expect.any(Object),
      expect.objectContaining({ group: { id: "data-health" }, singletonKey: "data-health" }),
    );
  });

  it("registers keyed UTC refresh schedules and a coalesced health schedule", async () => {
    const { boss, schedule } = bossHarness();

    await registerSchedules(boss, 2026);

    expect(schedule).toHaveBeenCalledTimes(7);
    expect(schedule).toHaveBeenNthCalledWith(
      1,
      queueNames.dataHealth,
      "*/15 * * * *",
      { source: "schedule" },
      expect.objectContaining({
        key: "scheduled-data-health",
        group: { id: "data-health" },
        singletonKey: "data-health",
      }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      queueNames.dataRefresh,
      "17 5 * * *",
      expect.objectContaining({ scope: "player-data" }),
      expect.objectContaining({ tz: "UTC", key: "daily-shared-nfl-player-data" }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      3,
      queueNames.dataRefresh,
      "47 5 * * *",
      expect.objectContaining({ scope: "adp-data" }),
      expect.objectContaining({ tz: "UTC", key: "daily-draft-market-adp" }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      4,
      queueNames.dataRefresh,
      "23 * * * *",
      expect.objectContaining({ scope: "market-data" }),
      expect.objectContaining({ tz: "UTC", key: "hourly-waiver-market-data" }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      5,
      queueNames.notificationSweep,
      "4,19,34,49 * * * *",
      { kind: "lineup-lock", reason: "scheduled" },
      expect.objectContaining({
        tz: "UTC",
        key: "lineup-lock-alerts",
        group: { id: "notifications" },
        singletonKey: "notification-sweep:lineup-lock",
      }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      6,
      queueNames.refreshProjections,
      "*/10 * * * *",
      { season: 2026, reason: "lock-window" },
      expect.objectContaining({
        tz: "UTC",
        key: "near-lock-first-party-projections",
        group: { id: "projections" },
        singletonKey: "projection-lock-window:2026",
      }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      7,
      queueNames.refreshProjections,
      "11 * * * *",
      { season: 2026, reason: "scheduled" },
      expect.objectContaining({
        tz: "UTC",
        key: "hourly-first-party-projections",
        group: { id: "projections" },
        singletonKey: "projection-refresh:2026:season",
      }),
    );
  });

  it("deduplicates startup recovery by UTC date", async () => {
    const { boss, send } = bossHarness();
    const now = new Date("2026-07-21T23:59:58.000Z");

    await ensureDailyRefresh(boss, now);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      queueNames.dataRefresh,
      expect.objectContaining({ reason: "startup-recovery", requestedAt: now.toISOString() }),
      expect.objectContaining({
        group: { id: "shared-nfl-data" },
        singletonKey: "startup-daily:2026-07-21",
        singletonSeconds: 86_400,
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      queueNames.dataRefresh,
      expect.objectContaining({
        scope: "adp-data",
        reason: "startup-recovery",
        requestedAt: now.toISOString(),
      }),
      expect.objectContaining({
        group: { id: "shared-nfl-data" },
        singletonKey: "startup-adp:2026-07-21",
        singletonSeconds: 86_400,
      }),
    );
  });
});
