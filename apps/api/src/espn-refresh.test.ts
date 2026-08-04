import { describe, expect, it, vi } from "vitest";

import {
  EspnRefreshCoordinator,
  EspnRefreshError,
  type EspnRefreshRepository,
  type RefreshTarget,
  type StoredRefreshRequest,
} from "./espn-refresh.js";

const NOW = new Date("2026-09-20T17:00:00.000Z");
const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const REQUEST_ID = "30000000-0000-4000-8000-000000000001";

function target(overrides: Partial<RefreshTarget> = {}): RefreshTarget {
  const fresh = new Date(NOW.getTime() - 5 * 60_000).toISOString();
  return {
    leagueId: "40000000-0000-4000-8000-000000000001",
    leagueSeasonId: LEAGUE_SEASON_ID,
    externalLeagueId: "1234567",
    season: 2026,
    seasonStatus: "active",
    currentWeek: 3,
    artifactFreshness: {
      core: fresh,
      "available-players": fresh,
      "weekly-box-scores": fresh,
      transactions: fresh,
      "completed-draft": fresh,
    },
    hasActiveMatchup: false,
    directCoreState: "unknown",
    preferredMode: "automatic",
    lastProbeAt: null,
    nextProbeAt: null,
    lastDirectSuccessAt: null,
    circuitOpenUntil: null,
    activeAgentCount: 0,
    mostRecentAgentSeenAt: null,
    request: null,
    latestAttempt: null,
    ...overrides,
  };
}

function storedRequest(overrides: Partial<StoredRefreshRequest> = {}): StoredRefreshRequest {
  return {
    id: REQUEST_ID,
    state: "queued",
    fulfillmentMode: null,
    requiredArtifacts: ["core"],
    minimumCaptureAt: NOW,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function repositoryHarness(initial: RefreshTarget | undefined) {
  let current = initial;
  const createOrGetRequest = vi.fn<EspnRefreshRepository["createOrGetRequest"]>(async (input) => {
    const request = storedRequest({
      fulfillmentMode: input.fulfillmentMode,
      requiredArtifacts: input.requiredArtifacts,
      minimumCaptureAt: input.minimumCaptureAt,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    });
    if (current) current = { ...current, request };
    return request;
  });
  const repository: EspnRefreshRepository = {
    inspectMemberTarget: vi.fn(async () => current),
    createOrGetRequest,
    pollAgent: vi.fn<EspnRefreshRepository["pollAgent"]>(async () => ({
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      pollAfterSeconds: 300,
      requests: [],
    })),
    reportAgentAttempt: vi.fn<EspnRefreshRepository["reportAgentAttempt"]>(async () => ({
      attemptId: REQUEST_ID,
      state: "started",
    })),
  };
  return { repository, createOrGetRequest };
}

describe("ESPN refresh coordinator", () => {
  it("returns current without creating work when every relevant artifact is fresh", async () => {
    const harness = repositoryHarness(target());
    const enqueueDirect = vi.fn(async () => "job-1");
    const coordinator = new EspnRefreshCoordinator(
      harness.repository,
      { directEnabled: true, enqueueDirect },
      () => NOW,
    );

    await expect(coordinator.requestRefresh(USER_ID, LEAGUE_SEASON_ID)).resolves.toMatchObject({
      current: true,
      request: null,
      display: { code: "up-to-date" },
    });
    expect(harness.createOrGetRequest).not.toHaveBeenCalled();
    expect(enqueueDirect).not.toHaveBeenCalled();
  });

  it("creates one server-owned assisted intent with only independently stale artifacts", async () => {
    const initial = target({
      artifactFreshness: {
        ...target().artifactFreshness,
        transactions: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
      },
      activeAgentCount: 1,
    });
    const harness = repositoryHarness(initial);
    const coordinator = new EspnRefreshCoordinator(
      harness.repository,
      { directEnabled: false },
      () => NOW,
    );

    const status = await coordinator.requestRefresh(USER_ID, LEAGUE_SEASON_ID);

    expect(harness.createOrGetRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        leagueSeasonId: LEAGUE_SEASON_ID,
        minimumCaptureAt: NOW,
        requiredArtifacts: ["transactions"],
        fulfillmentMode: null,
      }),
    );
    expect(status).toMatchObject({
      current: false,
      request: { id: REQUEST_ID, requiredArtifacts: ["transactions"] },
      display: { code: "queued-no-agent", actionRequired: false },
    });
    expect(status.request?.expiresAt).toBe("2026-09-21T17:00:00.000Z");
  });

  it("dispatches direct work only for operator-verified core capability", async () => {
    const harness = repositoryHarness(
      target({
        artifactFreshness: {
          ...target().artifactFreshness,
          core: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
        },
        directCoreState: "available",
      }),
    );
    const enqueueDirect = vi.fn(async () => "job-1");
    const coordinator = new EspnRefreshCoordinator(
      harness.repository,
      { directEnabled: true, enqueueDirect },
      () => NOW,
    );

    const status = await coordinator.requestRefresh(USER_ID, LEAGUE_SEASON_ID);

    expect(harness.createOrGetRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fulfillmentMode: "server-direct" }),
    );
    expect(enqueueDirect).toHaveBeenCalledWith({
      leagueSeasonId: LEAGUE_SEASON_ID,
      refreshRequestId: REQUEST_ID,
    });
    expect(status.display.code).toBe("refreshing-direct");
  });

  it("does not bypass an open direct circuit", async () => {
    const harness = repositoryHarness(
      target({
        artifactFreshness: {
          ...target().artifactFreshness,
          core: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
        },
        directCoreState: "available",
        circuitOpenUntil: new Date(NOW.getTime() + 5 * 60_000),
      }),
    );
    const enqueueDirect = vi.fn(async () => "job-1");
    const coordinator = new EspnRefreshCoordinator(
      harness.repository,
      { directEnabled: true, enqueueDirect },
      () => NOW,
    );

    await coordinator.requestRefresh(USER_ID, LEAGUE_SEASON_ID);

    expect(harness.createOrGetRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fulfillmentMode: null }),
    );
    expect(enqueueDirect).not.toHaveBeenCalled();
  });

  it("redacts another member's device name and exposes a direct partial as agent work", async () => {
    const request = storedRequest({ state: "processing", fulfillmentMode: "server-direct" });
    const harness = repositoryHarness(
      target({
        artifactFreshness: {
          ...target().artifactFreshness,
          transactions: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
        },
        request,
        latestAttempt: {
          mode: "server-direct",
          state: "accepted",
          deviceName: "Someone else's iPhone",
          deviceUserId: OTHER_USER_ID,
          clientKind: "ios-app",
          errorCode: null,
          startedAt: NOW,
          finishedAt: NOW,
        },
      }),
    );
    const coordinator = new EspnRefreshCoordinator(
      harness.repository,
      { directEnabled: true },
      () => NOW,
    );

    const status = await coordinator.getStatus(USER_ID, LEAGUE_SEASON_ID);

    expect(status.request?.latestAttempt?.deviceName).toBeNull();
    expect(status.display).toEqual({
      code: "queued-no-agent",
      label: "Core checked · waiting for an authorized sync device",
      actionRequired: true,
    });
  });

  it("fails membership lookup without revealing whether the ESPN season exists", async () => {
    const harness = repositoryHarness(undefined);
    const coordinator = new EspnRefreshCoordinator(
      harness.repository,
      { directEnabled: true },
      () => NOW,
    );

    await expect(coordinator.getStatus(USER_ID, LEAGUE_SEASON_ID)).rejects.toMatchObject({
      name: EspnRefreshError.name,
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });
});
