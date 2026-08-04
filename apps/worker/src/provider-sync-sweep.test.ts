import { describe, expect, it, vi } from "vitest";

import type { LeagueSyncJob } from "@fantasy/jobs";

import {
  nextYahooAutomatedSyncAt,
  ProviderSyncSweepService,
  YAHOO_ACTIVE_SYNC_INTERVAL_MS,
  YAHOO_OFFSEASON_SYNC_INTERVAL_MS,
  YAHOO_SYNC_JITTER_WINDOW_MS,
  yahooSyncJitterMs,
} from "./provider-sync-sweep.js";

const NOW = new Date("2026-09-24T15:00:00.000Z");

function context(signal = new AbortController().signal) {
  return { jobId: "provider-sweep-test", signal } as const;
}

function reader(
  input: {
    readonly expired?: number;
    readonly espn?: readonly {
      readonly provider: "espn";
      readonly leagueSeasonId: string;
      readonly directCoreState: "unknown" | "not-public" | "available" | "degraded";
    }[];
    readonly yahoo?: readonly {
      readonly provider: "yahoo";
      readonly leagueSeasonId: string;
      readonly connectionId: string;
      readonly dueAt: Date;
    }[];
  } = {},
) {
  return {
    expireRequests: vi.fn(async () => input.expired ?? 0),
    listDueEspn: vi.fn(async () => input.espn ?? []),
    listDueYahoo: vi.fn(async () => input.yahoo ?? []),
  };
}

describe("Yahoo automated sync cadence", () => {
  const season = 2026;
  const leagueSeasonId = "50000000-0000-4000-8000-000000000001";
  const lastSyncedAt = new Date("2026-09-24T12:00:00.000Z");

  it.each([
    ["active", YAHOO_ACTIVE_SYNC_INTERVAL_MS],
    ["preseason", YAHOO_OFFSEASON_SYNC_INTERVAL_MS],
    ["offseason", YAHOO_OFFSEASON_SYNC_INTERVAL_MS],
  ] as const)("uses the conservative %s cadence", (status, intervalMs) => {
    const dueAt = nextYahooAutomatedSyncAt({
      leagueSeasonId,
      season,
      status,
      archived: false,
      lastSyncedAt,
      createdAt: lastSyncedAt,
      now: NOW,
    });

    expect(dueAt?.getTime()).toBe(
      lastSyncedAt.getTime() + intervalMs + yahooSyncJitterMs(leagueSeasonId),
    );
  });

  it("keeps jitter stable, bounded below one scheduler period, and distributed", () => {
    const ids = [
      "50000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000002",
      "50000000-0000-4000-8000-000000000003",
      "50000000-0000-4000-8000-000000000004",
    ];
    const jitter = ids.map(yahooSyncJitterMs);

    expect(yahooSyncJitterMs(ids[0]!)).toBe(jitter[0]);
    expect(jitter.every((value) => value >= 0 && value < YAHOO_SYNC_JITTER_WINDOW_MS)).toBe(true);
    expect(new Set(jitter).size).toBeGreaterThan(1);
  });

  it.each([
    { status: "completed", archived: false, season: 2026 },
    { status: "complete", archived: false, season: 2026 },
    { status: "active", archived: true, season: 2026 },
    { status: "active", archived: false, season: 2025 },
    { status: "active", archived: false, season: 2027 },
    { status: "unknown", archived: false, season: 2026 },
  ])("never schedules an ineligible season: $status/$season/$archived", (candidate) => {
    expect(
      nextYahooAutomatedSyncAt({
        leagueSeasonId,
        ...candidate,
        lastSyncedAt,
        createdAt: lastSyncedAt,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("provider sync sweep", () => {
  it("expires stale intents without reading targets while both automation paths are disabled", async () => {
    const targets = reader({ expired: 2 });
    const enqueue = vi.fn(async () => "job-1");
    const service = new ProviderSyncSweepService({
      espnEnabled: false,
      yahooEnabled: false,
      targets,
      enqueue,
      now: () => NOW,
    });

    await expect(
      service.sweepProviderSync({ requestedAt: "scheduled" }, context()),
    ).resolves.toEqual({
      expired: 2,
      considered: 0,
      enqueued: 0,
      byProvider: {
        espn: { considered: 0, enqueued: 0 },
        yahoo: { considered: 0, enqueued: 0 },
      },
    });
    expect(targets.expireRequests).toHaveBeenCalledWith(NOW);
    expect(targets.listDueEspn).not.toHaveBeenCalled();
    expect(targets.listDueYahoo).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("preserves ESPN selection, probes unverified states, and counts only new jobs", async () => {
    const targets = reader({
      expired: 1,
      espn: [
        { provider: "espn", leagueSeasonId: "season-unknown", directCoreState: "unknown" },
        { provider: "espn", leagueSeasonId: "season-private", directCoreState: "not-public" },
        { provider: "espn", leagueSeasonId: "season-available", directCoreState: "available" },
        { provider: "espn", leagueSeasonId: "season-degraded", directCoreState: "degraded" },
      ],
    });
    const enqueue = vi
      .fn<(job: LeagueSyncJob) => Promise<string | null>>()
      .mockResolvedValueOnce("job-1")
      .mockResolvedValueOnce("job-2")
      .mockResolvedValueOnce("job-3")
      .mockResolvedValueOnce(null);
    const service = new ProviderSyncSweepService({
      espnEnabled: true,
      yahooEnabled: false,
      targets,
      enqueue,
      now: () => NOW,
    });

    await expect(
      service.sweepProviderSync({ requestedAt: NOW.toISOString() }, context()),
    ).resolves.toMatchObject({
      expired: 1,
      considered: 4,
      enqueued: 3,
      byProvider: { espn: { considered: 4, enqueued: 3 } },
    });
    expect(targets.listDueEspn).toHaveBeenCalledWith(NOW, 100);
    expect(targets.listDueYahoo).not.toHaveBeenCalled();
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

  it("enqueues due Yahoo targets through the existing connection-mode league sync", async () => {
    const targets = reader({
      yahoo: [
        {
          provider: "yahoo",
          leagueSeasonId: "season-shared",
          connectionId: "connection-fallback",
          dueAt: NOW,
        },
      ],
    });
    const enqueue = vi.fn(async () => "job-yahoo");
    const observe = vi.fn();
    const service = new ProviderSyncSweepService({
      espnEnabled: false,
      yahooEnabled: true,
      targets,
      enqueue,
      observe,
      now: () => NOW,
    });

    await expect(
      service.sweepProviderSync({ requestedAt: "scheduled" }, context()),
    ).resolves.toMatchObject({
      considered: 1,
      enqueued: 1,
      byProvider: { yahoo: { considered: 1, enqueued: 1 } },
    });
    expect(targets.listDueYahoo).toHaveBeenCalledWith(NOW, 100);
    expect(targets.listDueEspn).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith({
      mode: "connection",
      connectionId: "connection-fallback",
      leagueSeasonId: "season-shared",
      reason: "provider-sweep",
    });
    expect(observe).toHaveBeenCalledWith({
      event: "due-targets-selected",
      espn: 0,
      yahoo: 1,
    });
    expect(observe).toHaveBeenCalledWith({
      event: "enqueue-result",
      provider: "yahoo",
      considered: 1,
      enqueued: 1,
      deduplicated: 0,
    });
  });

  it("reports a sanitized enqueue failure and preserves sweep retries", async () => {
    const targets = reader({
      yahoo: [
        {
          provider: "yahoo",
          leagueSeasonId: "season-failed",
          connectionId: "connection-failed",
          dueAt: NOW,
        },
      ],
    });
    const failure = new Error("queue unavailable");
    const observe = vi.fn();
    const service = new ProviderSyncSweepService({
      espnEnabled: false,
      yahooEnabled: true,
      targets,
      enqueue: () => Promise.reject(failure),
      observe,
      now: () => NOW,
    });

    await expect(service.sweepProviderSync({ requestedAt: "scheduled" }, context())).rejects.toBe(
      failure,
    );
    expect(observe).toHaveBeenCalledWith({
      event: "enqueue-failed",
      provider: "yahoo",
      leagueSeasonId: "season-failed",
    });
    expect(observe.mock.calls.flat()).not.toContain(failure);
  });

  it("stops before database work when shutdown already started", async () => {
    const controller = new AbortController();
    controller.abort();
    const targets = reader();
    const service = new ProviderSyncSweepService({
      espnEnabled: true,
      yahooEnabled: true,
      targets,
      enqueue: vi.fn(async () => null),
      now: () => NOW,
    });

    await expect(
      service.sweepProviderSync({ requestedAt: "scheduled" }, context(controller.signal)),
    ).rejects.toThrow("aborted during shutdown");
    expect(targets.expireRequests).not.toHaveBeenCalled();
    expect(targets.listDueEspn).not.toHaveBeenCalled();
    expect(targets.listDueYahoo).not.toHaveBeenCalled();
  });
});
