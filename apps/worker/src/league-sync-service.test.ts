import { describe, expect, it, vi } from "vitest";

import {
  EspnSessionSyncError,
  YahooSyncError,
  type EspnSessionSyncReceipt,
  type YahooSyncReceipt,
} from "@laces-out/league-sync";

import type { LeagueSyncJob } from "./jobs.js";
import {
  LeagueSyncService,
  type LeagueSyncOperationalEvent,
  type LeagueSyncTarget,
} from "./league-sync-service.js";

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

function espnReceipt(overrides: Partial<EspnSessionSyncReceipt> = {}): EspnSessionSyncReceipt {
  return {
    state: "accepted",
    syncRunId: "espn-session-run-1",
    leagueId: "league-1",
    leagueSeasonId: "league-season-1",
    externalLeagueKey: "1234567",
    season: 2026,
    recordsWritten: 18,
    syncedAt: now.toISOString(),
    supplementalAccepted: 0,
    supplementalFailed: 0,
    supplementalFailures: [],
    identityChanged: false,
    reauthorizationRequired: false,
    ...overrides,
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
    expect(circuit.recordSuccess).toHaveBeenCalledWith({
      provider: "yahoo",
      connectionId: "connection-1",
      leagueSeasonId: "league-season-1",
      at: now,
    });
  });

  it("runs post-commit work only for accepted Yahoo artifacts", async () => {
    const afterYahooCommit = vi.fn(() => Promise.resolve());
    const observe = vi.fn<(event: LeagueSyncOperationalEvent) => void>();
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
    const syncIdentity = vi.fn(() => Promise.reject(new Error("must not be called")));
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: { syncIdentity, syncLeague } as never,
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
    expect(syncIdentity).not.toHaveBeenCalled();
  });

  it("settles identity bootstrap without entering blocked supplemental work and runs after-commit", async () => {
    const afterEspnCommit = vi.fn(() => Promise.resolve());
    const receipt = espnReceipt({
      syncRunId: "espn-session-identity-run",
      identityChanged: true,
    });
    const blockedSupplemental = new Promise<typeof receipt>(() => undefined);
    const syncLeague = vi.fn(() => blockedSupplemental);
    const syncIdentity = vi.fn(() => Promise.resolve(receipt));
    const circuit = circuitStore();
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: { syncIdentity, syncLeague },
      circuit,
      afterEspnCommit,
      now: () => now,
    });

    await expect(
      service.runLeagueSync(job({ reason: "identity-bootstrap" }), context()),
    ).resolves.toMatchObject({ state: "synced", syncRunId: receipt.syncRunId });
    expect(syncIdentity).toHaveBeenCalledWith(
      "user-1",
      "connection-1",
      "league-season-1",
      expect.any(AbortSignal),
    );
    expect(syncLeague).not.toHaveBeenCalled();
    expect(circuit.recordSuccess).toHaveBeenCalledWith({
      provider: "espn",
      connectionId: "connection-1",
      leagueSeasonId: "league-season-1",
      at: now,
    });
    expect(afterEspnCommit).toHaveBeenCalledWith(receipt);
  });

  it("runs ESPN post-commit for identity changes on unchanged core receipts only", async () => {
    const afterEspnCommit = vi.fn(() => Promise.resolve());
    const changedReceipt = espnReceipt({
      state: "unchanged",
      recordsWritten: 0,
      identityChanged: true,
    });
    const unchangedReceipt = espnReceipt({
      state: "unchanged",
      recordsWritten: 0,
      identityChanged: false,
    });
    const syncLeague = vi
      .fn<() => Promise<EspnSessionSyncReceipt>>()
      .mockResolvedValueOnce(changedReceipt)
      .mockResolvedValueOnce(unchangedReceipt);
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague,
      },
      circuit: circuitStore(),
      afterEspnCommit,
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toEqual({
      state: "unchanged",
      syncRunId: changedReceipt.syncRunId,
    });
    expect(afterEspnCommit).toHaveBeenCalledWith(changedReceipt);

    afterEspnCommit.mockClear();
    await expect(service.runLeagueSync(job(), context())).resolves.toMatchObject({
      state: "unchanged",
    });
    expect(afterEspnCommit).not.toHaveBeenCalled();
  });

  it("finalizes a durable core before reporting supplemental reauthorization", async () => {
    const receipt = espnReceipt({
      reauthorizationRequired: true,
      supplementalFailed: 1,
      supplementalFailures: [{ kind: null, code: "AUTHORIZATION_EXPIRED", retryable: false }],
    });
    const afterEspnCommit = vi.fn(() => Promise.resolve());
    const observe = vi.fn<(event: LeagueSyncOperationalEvent) => void>();
    const circuit = circuitStore();
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => Promise.resolve(receipt),
      },
      circuit,
      afterEspnCommit,
      observe,
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toEqual({
      state: "reauthorization-required",
      connectionId: "connection-1",
    });
    expect(circuit.recordSuccess).toHaveBeenCalledWith({
      provider: "espn",
      connectionId: "connection-1",
      leagueSeasonId: "league-season-1",
      at: now,
    });
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(afterEspnCommit).toHaveBeenCalledWith(receipt);
    expect(observe.mock.calls.map(([event]) => event.event)).toEqual([
      "sync-completed",
      "reauthorization-required",
    ]);
  });

  it("settles a member refresh when a supplemental artifact is rejected", async () => {
    const receipt = espnReceipt({
      supplementalFailed: 1,
      supplementalFailures: [{ kind: "available-waivers", code: "SCHEMA_DRIFT", retryable: false }],
    });
    const espnSessionAttempts = {
      recordStarted: vi.fn(() => Promise.resolve()),
      recordFailure: vi.fn(() => Promise.resolve()),
    };
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => Promise.resolve(receipt),
      },
      espnSessionAttempts,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(
      service.runLeagueSync(job({ refreshRequestId: "refresh-1" }), context()),
    ).resolves.toMatchObject({ state: "synced" });
    expect(espnSessionAttempts.recordFailure).toHaveBeenCalledWith({
      refreshRequestId: "refresh-1",
      leagueSeasonId: "league-season-1",
      errorCode: "SCHEMA_DRIFT",
      errorDetail: "The available-waivers ESPN artifact did not complete.",
      retryable: false,
      at: now,
    });
  });

  it("runs post-commit before containing a circuit-success bookkeeping failure", async () => {
    const receipt = espnReceipt();
    const order: string[] = [];
    const circuit = circuitStore();
    circuit.recordSuccess.mockImplementation(() => {
      order.push("circuit-success");
      return Promise.reject(
        new Error("circuit store unavailable SWID=secret; espn_s2=secret-cookie"),
      );
    });
    const afterEspnCommit = vi.fn(() => {
      order.push("after-commit");
      return Promise.resolve();
    });
    const observe = vi.fn<(event: LeagueSyncOperationalEvent) => void>();
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => Promise.resolve(receipt),
      },
      circuit,
      afterEspnCommit,
      observe,
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context())).resolves.toEqual({
      state: "synced",
      recordsWritten: receipt.recordsWritten,
      syncRunId: receipt.syncRunId,
    });
    expect(order).toEqual(["after-commit", "circuit-success"]);
    expect(afterEspnCommit).toHaveBeenCalledWith(receipt);
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({
      event: "circuit-success-failed",
      provider: "espn",
      connectionId: "connection-1",
      leagueSeasonId: "league-season-1",
    });
    expect(JSON.stringify(observe.mock.calls)).not.toContain("SWID");
    expect(JSON.stringify(observe.mock.calls)).not.toContain("espn_s2");
  });

  it("keeps pre-persistence caller cancellation out of provider circuit failures", async () => {
    const controller = new AbortController();
    const circuit = circuitStore();
    const afterEspnCommit = vi.fn(() => Promise.resolve());
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => {
          const cancellation = new DOMException("worker shutdown", "AbortError");
          controller.abort(cancellation);
          return Promise.reject(cancellation);
        },
      },
      circuit,
      afterEspnCommit,
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context(controller.signal))).rejects.toThrow(
      "League sync was aborted during shutdown",
    );
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
    expect(afterEspnCommit).not.toHaveBeenCalled();
  });

  it("finishes circuit success and post-commit after a durable receipt despite cancellation", async () => {
    const controller = new AbortController();
    const receipt = espnReceipt();
    const circuit = circuitStore();
    const afterEspnCommit = vi.fn(() => Promise.resolve());
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => {
          controller.abort(new DOMException("worker shutdown", "AbortError"));
          return Promise.resolve(receipt);
        },
      },
      circuit,
      afterEspnCommit,
      now: () => now,
    });

    await expect(service.runLeagueSync(job(), context(controller.signal))).resolves.toEqual({
      state: "synced",
      recordsWritten: receipt.recordsWritten,
      syncRunId: receipt.syncRunId,
    });
    expect(circuit.recordSuccess).toHaveBeenCalledWith({
      provider: "espn",
      connectionId: "connection-1",
      leagueSeasonId: "league-season-1",
      at: now,
    });
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(afterEspnCommit).toHaveBeenCalledWith(receipt);
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

  it("keeps a member ESPN refresh actionable while its league circuit cools down", async () => {
    const espnSessionAttempts = {
      recordStarted: vi.fn(() => Promise.resolve()),
      recordFailure: vi.fn(() => Promise.resolve()),
    };
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
        consecutiveFailures: 5,
        circuitOpenUntil: new Date(now.getTime() + 90_000),
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => Promise.reject(new Error("must not be called")),
      },
      espnSessionAttempts,
      circuit: circuitStore(),
      now: () => now,
    });

    await expect(
      service.runLeagueSync(job({ refreshRequestId: "refresh-1" }), context()),
    ).resolves.toEqual({ state: "circuit-open", retryAfterSeconds: 90 });
    expect(espnSessionAttempts.recordStarted).not.toHaveBeenCalled();
    expect(espnSessionAttempts.recordFailure).toHaveBeenCalledWith({
      refreshRequestId: "refresh-1",
      leagueSeasonId: "league-season-1",
      errorCode: "CIRCUIT_COOLDOWN",
      errorDetail: "Automatic ESPN refresh is cooling down before its next retry.",
      retryable: true,
      at: now,
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
      expect.objectContaining({
        provider: "yahoo",
        connectionId: "connection-1",
        leagueSeasonId: "league-season-1",
        at: now,
      }),
    );
  });

  it("records deterministic ESPN drift against one league without retrying the queue job", async () => {
    const failure = new EspnSessionSyncError(
      "SCHEMA_DRIFT",
      "ESPN league data no longer matches the supported format",
    );
    const circuit = circuitStore();
    const espnSessionAttempts = {
      recordStarted: vi.fn(() => Promise.resolve()),
      recordFailure: vi.fn(() => Promise.resolve()),
    };
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => Promise.reject(failure),
      },
      espnSessionAttempts,
      circuit,
      now: () => now,
    });

    await expect(
      service.runLeagueSync(job({ refreshRequestId: "refresh-1" }), context()),
    ).resolves.toEqual({
      state: "provider-rejected",
      provider: "espn",
      errorCode: "SCHEMA_DRIFT",
    });
    expect(espnSessionAttempts.recordStarted).toHaveBeenCalledWith({
      refreshRequestId: "refresh-1",
      leagueSeasonId: "league-season-1",
      at: now,
    });
    expect(espnSessionAttempts.recordFailure).toHaveBeenCalledWith({
      refreshRequestId: "refresh-1",
      leagueSeasonId: "league-season-1",
      errorCode: "SCHEMA_DRIFT",
      errorDetail: "ESPN league data no longer matches the supported format",
      retryable: false,
      at: now,
    });
    expect(circuit.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "espn",
        connectionId: "connection-1",
        leagueSeasonId: "league-season-1",
      }),
    );
  });

  it("finishes a member refresh when ESPN proves reauthorization is required", async () => {
    const failure = new EspnSessionSyncError(
      "REAUTHORIZATION_REQUIRED",
      "ESPN sign-in must be renewed",
    );
    const circuit = circuitStore();
    const espnSessionAttempts = {
      recordStarted: vi.fn(() => Promise.resolve()),
      recordFailure: vi.fn(() => Promise.resolve()),
    };
    const service = new LeagueSyncService({
      targets: reader({
        provider: "espn",
        externalKey: "1234567",
        connectionCapabilities: { authentication: ["server-session-cookie"] },
      }),
      espnSessionSync: {
        syncIdentity: () => Promise.reject(new Error("must not be called")),
        syncLeague: () => Promise.reject(failure),
      },
      espnSessionAttempts,
      circuit,
      now: () => now,
    });

    await expect(
      service.runLeagueSync(job({ refreshRequestId: "refresh-1" }), context()),
    ).resolves.toEqual({
      state: "reauthorization-required",
      connectionId: "connection-1",
    });
    expect(espnSessionAttempts.recordFailure).toHaveBeenCalledWith({
      refreshRequestId: "refresh-1",
      leagueSeasonId: "league-season-1",
      errorCode: "REAUTHORIZATION_REQUIRED",
      errorDetail: "ESPN sign-in must be renewed",
      retryable: false,
      at: now,
    });
    expect(circuit.recordFailure).not.toHaveBeenCalled();
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
