import { readFileSync } from "node:fs";

import {
  EspnPublicReadError,
  canonicalEspnPayloadChecksumV1,
  type EspnPublicLeagueArtifact,
} from "@fantasy/connector-espn";
import { describe, expect, it, vi } from "vitest";

import {
  EspnDirectSyncService,
  type EspnDirectStateRepository,
  type EspnDirectTarget,
} from "./espn-direct-sync.js";

const NOW = new Date("2026-09-24T15:00:00.000Z");
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "30000000-0000-4000-8000-000000000001";
const REQUEST_ID = "40000000-0000-4000-8000-000000000001";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/connector-espn/test/fixtures/web-client-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  leagueId: string;
  season: number;
  endpoint: string;
  checksumSha256: string;
  payload: unknown;
};
const canonicalFixtureChecksum = canonicalEspnPayloadChecksumV1(fixture.payload);

function target(overrides: Partial<EspnDirectTarget> = {}): EspnDirectTarget {
  return {
    leagueSeasonId: LEAGUE_SEASON_ID,
    leagueId: LEAGUE_ID,
    externalLeagueId: fixture.leagueId,
    season: fixture.season,
    seasonStatus: "active",
    directCoreState: "available",
    preferredMode: "automatic",
    circuitOpenUntil: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function artifact(overrides: Partial<EspnPublicLeagueArtifact> = {}): EspnPublicLeagueArtifact {
  return {
    provider: "espn",
    authority: "unofficial",
    readOnly: true,
    leagueId: fixture.leagueId,
    season: fixture.season,
    endpoint: fixture.endpoint,
    fetchedAt: "2026-09-24T14:59:00.000Z",
    checksumSha256: fixture.checksumSha256,
    payload: fixture.payload,
    ...overrides,
  };
}

function repositoryHarness(value: EspnDirectTarget | undefined = target()) {
  const findTarget = vi.fn(async () => value);
  const recordAttempt = vi.fn(async () => undefined);
  const recordEvidenceRequired = vi.fn(async () => undefined);
  const recordSuccess = vi.fn(async () => undefined);
  const recordNotPublic = vi.fn(async () => undefined);
  const recordFailure = vi.fn(async () => undefined);
  const repository: EspnDirectStateRepository = {
    findTarget,
    recordAttempt,
    recordEvidenceRequired,
    recordSuccess,
    recordNotPublic,
    recordFailure,
  };
  return {
    repository,
    findTarget,
    recordAttempt,
    recordEvidenceRequired,
    recordSuccess,
    recordNotPublic,
    recordFailure,
  };
}

describe("ESPN server-direct sync", () => {
  it("is a complete no-op while the deployment flag is disabled", async () => {
    const harness = repositoryHarness();
    const client = { fetchLeague: vi.fn(async () => artifact()) };
    const persistence = { persist: vi.fn() };
    const service = new EspnDirectSyncService({
      enabled: false,
      repository: harness.repository,
      client,
      persistence,
      now: () => NOW,
    });

    await expect(
      service.syncLeague(
        { leagueSeasonId: LEAGUE_SEASON_ID, probe: false },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: "disabled" });
    expect(harness.findTarget).not.toHaveBeenCalled();
    expect(client.fetchLeague).not.toHaveBeenCalled();
  });

  it("does not promote a successful anonymous probe without operator-reviewed evidence", async () => {
    const harness = repositoryHarness(target({ directCoreState: "unknown" }));
    const client = { fetchLeague: vi.fn(async () => artifact()) };
    const persistence = { persist: vi.fn() };
    const service = new EspnDirectSyncService({
      enabled: true,
      repository: harness.repository,
      client,
      persistence,
      now: () => NOW,
    });
    const signal = new AbortController().signal;

    await expect(
      service.syncLeague({ leagueSeasonId: LEAGUE_SEASON_ID, probe: true }, signal),
    ).resolves.toEqual({ state: "evidence-required" });
    expect(client.fetchLeague).toHaveBeenCalledWith({
      leagueId: fixture.leagueId,
      season: fixture.season,
      views: ["mSettings", "mTeam", "mRoster", "mStandings", "mMatchup"],
      signal,
    });
    expect(harness.recordEvidenceRequired).toHaveBeenCalledWith({
      leagueSeasonId: LEAGUE_SEASON_ID,
      now: NOW,
    });
    expect(harness.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "rejected", errorCode: "EVIDENCE_REQUIRED" }),
    );
    expect(persistence.persist).not.toHaveBeenCalled();
  });

  it("persists a verified public artifact under server-only authority and emits after commit", async () => {
    const harness = repositoryHarness();
    const client = { fetchLeague: vi.fn(async () => artifact()) };
    const persistence = {
      persist: vi.fn(async () => ({
        receiptId: "50000000-0000-4000-8000-000000000001",
        leagueId: LEAGUE_ID,
        leagueSeasonId: LEAGUE_SEASON_ID,
        recordsWritten: 24,
        state: "accepted" as const,
      })),
    };
    const afterCommit = vi.fn(async () => undefined);
    const service = new EspnDirectSyncService({
      enabled: true,
      repository: harness.repository,
      client,
      persistence,
      afterCommit,
      now: () => NOW,
    });

    await expect(
      service.syncLeague(
        { leagueSeasonId: LEAGUE_SEASON_ID, refreshRequestId: REQUEST_ID, probe: false },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      state: "accepted",
      leagueId: LEAGUE_ID,
      leagueSeasonId: LEAGUE_SEASON_ID,
      recordsWritten: 24,
    });
    expect(persistence.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: { mode: "server-direct", leagueSeasonId: LEAGUE_SEASON_ID },
        checksumSha256: canonicalFixtureChecksum,
        kind: "espn-direct",
      }),
    );
    expect(harness.recordSuccess).toHaveBeenCalledWith({
      leagueSeasonId: LEAGUE_SEASON_ID,
      seasonStatus: "active",
      now: NOW,
    });
    expect(afterCommit).toHaveBeenCalledOnce();
  });

  it("falls back to assisted sync when ESPN refuses an anonymous read", async () => {
    const harness = repositoryHarness();
    const failure = new EspnPublicReadError({
      code: "NOT_PUBLIC",
      message: "not public",
      status: 403,
    });
    const service = new EspnDirectSyncService({
      enabled: true,
      repository: harness.repository,
      client: { fetchLeague: vi.fn(async () => Promise.reject(failure)) },
      persistence: { persist: vi.fn() },
      now: () => NOW,
    });

    await expect(
      service.syncLeague(
        { leagueSeasonId: LEAGUE_SEASON_ID, refreshRequestId: REQUEST_ID, probe: false },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: "not-public" });
    expect(harness.recordNotPublic).toHaveBeenCalledWith({
      leagueSeasonId: LEAGUE_SEASON_ID,
      now: NOW,
    });
    expect(harness.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "not-public", errorCode: "NOT_PUBLIC" }),
    );
  });

  it("records bounded retry state and rethrows rate limits for queue backoff", async () => {
    const currentTarget = target({ consecutiveFailures: 4 });
    const harness = repositoryHarness(currentTarget);
    const failure = new EspnPublicReadError({
      code: "UPSTREAM_ERROR",
      message: "provider response contained sensitive-looking text",
      status: 429,
      retryable: true,
    });
    const service = new EspnDirectSyncService({
      enabled: true,
      repository: harness.repository,
      client: { fetchLeague: vi.fn(async () => Promise.reject(failure)) },
      persistence: { persist: vi.fn() },
      now: () => NOW,
    });

    await expect(
      service.syncLeague(
        { leagueSeasonId: LEAGUE_SEASON_ID, refreshRequestId: REQUEST_ID, probe: false },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(harness.recordFailure).toHaveBeenCalledWith({
      target: currentTarget,
      errorCode: "UPSTREAM_ERROR",
      errorDetail: "ESPN public read failed before admission.",
      rateLimited: true,
      now: NOW,
    });
    expect(JSON.stringify(harness.recordFailure.mock.calls)).not.toContain("sensitive-looking");
  });

  it("rejects an admitted payload whose identity differs from the stored target", async () => {
    const harness = repositoryHarness(target({ externalLeagueId: "12345" }));
    const service = new EspnDirectSyncService({
      enabled: true,
      repository: harness.repository,
      client: { fetchLeague: vi.fn(async () => artifact({ leagueId: "12345" })) },
      persistence: { persist: vi.fn() },
      now: () => NOW,
    });

    await expect(
      service.syncLeague(
        { leagueSeasonId: LEAGUE_SEASON_ID, refreshRequestId: REQUEST_ID, probe: false },
        new AbortController().signal,
      ),
    ).rejects.toThrow("identity mismatch");
    expect(harness.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "IDENTITY_MISMATCH", rateLimited: false }),
    );
  });
});
