import { describe, expect, it, vi } from "vitest";

import { YahooSyncError, type YahooSyncReceipt } from "@laces-out/league-sync";

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
              connectionCapabilities: {
                authentication: ["oauth2-authorization-code-pkce"],
              },
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

function yahooReceipt(state: "accepted" | "unchanged" = "accepted"): YahooSyncReceipt {
  return {
    syncRunId: "run-accepted",
    leagueId: "league-1",
    leagueSeasonId: "league-season-1",
    externalLeagueKey: "nfl.l.12345",
    season: 2026,
    state,
    recordsWritten: state === "accepted" ? 42 : 0,
    syncedAt: now.toISOString(),
  };
}

describe("LeagueSyncService", () => {
  it("refreshes a manual Yahoo league through the shared service without an automation flag", async () => {
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

  it("runs post-commit work only for accepted Yahoo artifacts", async () => {
    const afterYahooCommit = vi.fn(() => Promise.resolve());
    const observe = vi.fn();
    const accepted = new LeagueSyncService({
      targets: reader(),
      yahooSync: { syncLeague: () => Promise.resolve(yahooReceipt("accepted")) } as never,
      circuit: circuitStore(),
      afterYahooCommit,
      observe,
      now: () => now,
    });

    await expect(accepted.runLeagueSync(job(), context())).resolves.toMatchObject({
      state: "synced",
    });
    expect(afterYahooCommit).toHaveBeenCalledWith(yahooReceipt("accepted"));
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sync-completed", state: "accepted" }),
    );

    afterYahooCommit.mockClear();
    const unchanged = new LeagueSyncService({
      targets: reader(),
      yahooSync: { syncLeague: () => Promise.resolve(yahooReceipt("unchanged")) } as never,
      circuit: circuitStore(),
      afterYahooCommit,
      now: () => now,
    });
    await expect(unchanged.runLeagueSync(job(), context())).resolves.toMatchObject({
      state: "unchanged",
    });
    expect(afterYahooCommit).not.toHaveBeenCalled();
  });

  it("does not retry a committed artifact when a follow-up fails", async () => {
    const observe = vi.fn();
    const service = new LeagueSyncService({
      targets: reader(),
      yahooSync: { syncLeague: () => Promise.resolve(yahooReceipt("accepted")) } as never,
      circuit: circuitStore(),
      afterYahooCommit: () => Promise.reject(new Error("queue unavailable")),
      observe,
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toMatchObject({
      state: "synced",
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ event: "after-commit-failed", leagueSeasonId: "league-season-1" }),
    );
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

  it("never fetches browser-only ESPN and reports that the companion is required", async () => {
    const syncLeague = vi.fn(() => Promise.reject(new Error("must not be called")));
    const circuit = circuitStore();
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["browser-session"] },
      }),
      yahooSync: { syncLeague } as never,
      circuit,
      now: () => now,
    });

    const outcome = await service.runLeagueSync(job({ reason: "scheduled" }), context());

    expect(outcome).toEqual({ state: "external-companion-required", provider: "espn" });
    expect(syncLeague).not.toHaveBeenCalled();
    expect(circuit.recordFailure).not.toHaveBeenCalled();
  });

  it("routes an ESPN server-session connection through the unattended sync port", async () => {
    const syncLeague = vi.fn(() =>
      Promise.resolve({
        state: "accepted" as const,
        syncRunId: "espn-session-run-1",
        recordsWritten: 18,
      }),
    );
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: { syncLeague } as never,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(service.runLeagueSync(job({ reason: "scheduled" }), context())).resolves.toEqual({
      state: "synced",
      recordsWritten: 18,
      syncRunId: "espn-session-run-1",
    });
    expect(syncLeague).toHaveBeenCalledWith(
      "user-1",
      "connection-1",
      "league-season-1",
      expect.any(AbortSignal),
    );
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
    const observe = vi.fn();
    const service = new LeagueSyncService({
      targets: reader({
        consecutiveFailures: 5,
        circuitOpenUntil: new Date(now.getTime() + 90_000),
      }),
      yahooSync: { syncLeague } as never,
      circuit: circuitStore(),
      observe,
      now: () => now,
    });

    const outcome = await service.runLeagueSync(job(), context());

    expect(outcome).toEqual({ state: "circuit-open", retryAfterSeconds: 90 });
    expect(syncLeague).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({
      event: "circuit-cooldown",
      provider: "yahoo",
      connectionId: "connection-1",
      leagueSeasonId: "league-season-1",
      retryAfterSeconds: 90,
    });
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

  it("reports sanitized Yahoo throttling and Retry-After metadata while preserving retries", async () => {
    const failure = new YahooSyncError(
      "PROVIDER_READ_FAILED",
      "Yahoo did not return a valid, complete league response",
      { retryable: true, retryAfterMs: 7_001, throttled: true },
    );
    const observe = vi.fn();
    const afterYahooCommit = vi.fn(() => Promise.resolve());
    const service = new LeagueSyncService({
      targets: reader(),
      yahooSync: { syncLeague: () => Promise.reject(failure) } as never,
      circuit: circuitStore(),
      afterYahooCommit,
      observe,
      now: () => now,
    });

    await expect(service.runLeagueSync(job({ reason: "provider-sweep" }), context())).rejects.toBe(
      failure,
    );
    expect(afterYahooCommit).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({
      event: "sync-failed",
      provider: "yahoo",
      connectionId: "connection-1",
      leagueSeasonId: "league-season-1",
      errorCode: "PROVIDER_READ_FAILED",
      throttled: true,
      retryAfterSeconds: 8,
      circuitState: "closed",
      consecutiveFailures: 1,
    });
    expect(JSON.stringify(observe.mock.calls)).not.toContain("authorization");
    expect(JSON.stringify(observe.mock.calls)).not.toContain("access_token");
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
