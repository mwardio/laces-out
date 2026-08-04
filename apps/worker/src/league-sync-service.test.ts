import { describe, expect, it, vi } from "vitest";

import type { LeagueSyncJob } from "./jobs.js";
import { LeagueSyncService, type LeagueSyncTarget } from "./league-sync-service.js";

const now = new Date("2026-09-10T12:00:00.000Z");

function context(signal = new AbortController().signal) {
  return { jobId: "league-sync-test", signal } as const;
}

function job(overrides: Partial<LeagueSyncJob> = {}): LeagueSyncJob {
  return {
    connectionId: "connection-1",
    leagueSeasonId: "league-season-1",
    reason: "manual",
    ...overrides,
  };
}

function directJob(overrides: Partial<LeagueSyncJob> = {}): LeagueSyncJob {
  return {
    mode: "server-direct",
    leagueSeasonId: "league-season-1",
    reason: "stale-on-view",
    ...overrides,
  };
}

function reader(target: Partial<LeagueSyncTarget> | null = {}) {
  return {
    findSyncTarget: vi.fn(() =>
      Promise.resolve(
        target === null
          ? undefined
          : ({
              userId: "user-1",
              provider: "yahoo",
              externalKey: "nfl.l.12345",
              connectionHealth: "healthy",
              consecutiveFailures: 0,
              circuitOpenUntil: null,
              ...target,
            } satisfies LeagueSyncTarget),
      ),
    ),
  };
}

function circuitStore() {
  return {
    recordSuccess: vi.fn(() => Promise.resolve()),
    recordFailure: vi.fn(() =>
      Promise.resolve({ state: "closed" as const, consecutiveFailures: 1 }),
    ),
  };
}

describe("LeagueSyncService", () => {
  it("refreshes a Yahoo league through the shared sync service", async () => {
    const syncLeague = vi.fn(() =>
      Promise.resolve({ syncRunId: "run-1", state: "accepted" as const, recordsWritten: 42 }),
    );
    const circuit = circuitStore();
    const service = new LeagueSyncService({
      targets: reader(),
      yahooSync: { syncLeague } as never,
      circuit,
      now: () => now,
    });

    const outcome = await service.runLeagueSync(job(), context());

    expect(syncLeague).toHaveBeenCalledWith("user-1", "connection-1", "nfl.l.12345");
    expect(outcome).toEqual({ state: "synced", recordsWritten: 42, syncRunId: "run-1" });
    expect(circuit.recordSuccess).toHaveBeenCalledWith("connection-1", now);
  });

  it("reports an unchanged provider payload without writing a second run", async () => {
    const syncLeague = vi.fn(() =>
      Promise.resolve({ syncRunId: "run-1", state: "unchanged" as const, recordsWritten: 0 }),
    );
    const service = new LeagueSyncService({
      targets: reader(),
      yahooSync: { syncLeague } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    const first = await service.runLeagueSync(job(), context());
    const second = await service.runLeagueSync(job(), context());

    expect(first).toEqual(second);
    expect(second).toEqual({ state: "unchanged", syncRunId: "run-1" });
  });

  it("never fetches ESPN and reports that the companion is required", async () => {
    const syncLeague = vi.fn(() => Promise.reject(new Error("must not be called")));
    const circuit = circuitStore();
    const service = new LeagueSyncService({
      targets: reader({ provider: "espn", externalKey: "1234567" }),
      yahooSync: { syncLeague } as never,
      circuit,
      now: () => now,
    });

    const outcome = await service.runLeagueSync(job({ reason: "scheduled" }), context());

    expect(outcome).toEqual({ state: "external-companion-required", provider: "espn" });
    expect(syncLeague).not.toHaveBeenCalled();
    expect(circuit.recordFailure).not.toHaveBeenCalled();
  });

  it("routes an explicit ESPN server-direct job without resolving a user connection", async () => {
    const targets = reader();
    const syncLeague = vi.fn(() =>
      Promise.resolve({
        state: "accepted" as const,
        leagueSeasonId: "league-season-1",
        leagueId: "league-1",
        syncRunId: "direct-run-1",
        season: 2026,
        checksumSha256: "a".repeat(64),
        recordsWritten: 21,
      }),
    );
    const service = new LeagueSyncService({
      targets,
      espnDirect: { syncLeague },
      circuit: circuitStore(),
      now: () => now,
    });
    const signal = new AbortController().signal;

    await expect(
      service.runLeagueSync(
        directJob({
          refreshRequestId: "refresh-1",
          probe: false,
        }),
        context(signal),
      ),
    ).resolves.toEqual({ state: "synced", recordsWritten: 21, syncRunId: "direct-run-1" });
    expect(syncLeague).toHaveBeenCalledWith(
      {
        leagueSeasonId: "league-season-1",
        refreshRequestId: "refresh-1",
        probe: false,
      },
      signal,
    );
    expect(targets.findSyncTarget).not.toHaveBeenCalled();
  });

  it("resolves unverified direct capability as assisted work instead of retrying", async () => {
    const service = new LeagueSyncService({
      targets: reader(),
      espnDirect: { syncLeague: () => Promise.resolve({ state: "evidence-required" }) },
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(
      service.runLeagueSync(directJob({ reason: "provider-sweep" }), context()),
    ).resolves.toEqual({ state: "external-companion-required", provider: "espn" });
  });

  it("short-circuits an open connection circuit instead of consuming a retry", async () => {
    const syncLeague = vi.fn(() => Promise.reject(new Error("must not be called")));
    const service = new LeagueSyncService({
      targets: reader({
        consecutiveFailures: 5,
        circuitOpenUntil: new Date(now.getTime() + 90_000),
      }),
      yahooSync: { syncLeague } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    const outcome = await service.runLeagueSync(job(), context());

    expect(outcome).toEqual({ state: "circuit-open", retryAfterSeconds: 90 });
    expect(syncLeague).not.toHaveBeenCalled();
  });

  it("resumes once the cooldown elapses without any manual intervention", async () => {
    const syncLeague = vi.fn(() =>
      Promise.resolve({ syncRunId: "run-9", state: "accepted" as const, recordsWritten: 3 }),
    );
    const service = new LeagueSyncService({
      targets: reader({
        consecutiveFailures: 9,
        circuitOpenUntil: new Date(now.getTime() - 1_000),
      }),
      yahooSync: { syncLeague } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toMatchObject({
      state: "synced",
    });
  });

  it("records a failure and rethrows so pg-boss retries and finally dead-letters", async () => {
    const failure = new Error("provider temporarily unavailable");
    const circuit = circuitStore();
    const service = new LeagueSyncService({
      targets: reader(),
      yahooSync: { syncLeague: () => Promise.reject(failure) } as never,
      circuit,
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).rejects.toBe(failure);
    expect(circuit.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "connection-1", at: now }),
    );
  });

  it("treats an expired credential as terminal rather than retryable", async () => {
    const service = new LeagueSyncService({
      targets: reader({ connectionHealth: "reauthorize" }),
      yahooSync: { syncLeague: () => Promise.reject(new Error("must not be called")) } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toEqual({
      state: "reauthorization-required",
      connectionId: "connection-1",
    });
  });

  it("treats a disabled connection as terminal too", async () => {
    const service = new LeagueSyncService({
      targets: reader({ connectionHealth: "disabled" }),
      yahooSync: { syncLeague: () => Promise.reject(new Error("must not be called")) } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toEqual({
      state: "reauthorization-required",
      connectionId: "connection-1",
    });
  });

  it("resolves rather than retrying when the connection does not own the league season", async () => {
    const syncLeague = vi.fn(() => Promise.reject(new Error("must not be called")));
    const service = new LeagueSyncService({
      targets: reader(null),
      yahooSync: { syncLeague } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toEqual({
      state: "target-missing",
    });
    expect(syncLeague).not.toHaveBeenCalled();
  });

  it("refuses to start when the job was aborted during shutdown", async () => {
    const controller = new AbortController();
    controller.abort();
    const targets = reader();
    const service = new LeagueSyncService({
      targets,
      yahooSync: { syncLeague: () => Promise.reject(new Error("must not be called")) } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context(controller.signal))).rejects.toThrow(
      "League sync was aborted during shutdown",
    );
    expect(targets.findSyncTarget).not.toHaveBeenCalled();
  });

  it("completes as a stated no-op when Yahoo sync is not configured for this deployment", async () => {
    const service = new LeagueSyncService({
      targets: reader(),
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toEqual({
      state: "provider-unconfigured",
      provider: "yahoo",
    });
  });

  it("opens one connection's circuit without affecting another connection or recomputation", async () => {
    const failing = reader({
      consecutiveFailures: 5,
      circuitOpenUntil: new Date(now.getTime() + 60_000),
    });
    const healthy = reader();
    const syncLeague = vi.fn(() =>
      Promise.resolve({ syncRunId: "run-2", state: "accepted" as const, recordsWritten: 7 }),
    );

    const blocked = await new LeagueSyncService({
      targets: failing,
      yahooSync: { syncLeague } as never,
      circuit: circuitStore(),
      now: () => now,
    }).runLeagueSync(job({ connectionId: "connection-broken" }), context());

    const allowed = await new LeagueSyncService({
      targets: healthy,
      yahooSync: { syncLeague } as never,
      circuit: circuitStore(),
      now: () => now,
    }).runLeagueSync(job({ connectionId: "connection-2" }), context());

    expect(blocked).toMatchObject({ state: "circuit-open" });
    expect(allowed).toMatchObject({ state: "synced" });
    expect(syncLeague).toHaveBeenCalledTimes(1);
  });

  it("satisfies the declared worker service interface by resolving void", async () => {
    const service = new LeagueSyncService({
      targets: reader({ provider: "espn" }),
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.syncLeague(job(), context())).resolves.toBeUndefined();
  });
});
