import { readFileSync } from "node:fs";

import { EspnSessionReadError } from "@laces-out/connector-espn";
import type { LeagueSyncBundle } from "@laces-out/connectors";
import { describe, expect, it, vi } from "vitest";

import { EspnSessionSyncService } from "./espn-session-sync.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const leagueId = "00000000-0000-4000-8000-000000000002";
const leagueSeasonId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000004";
const externalLeagueId = "98765432101234567890";
const swid = "{123e4567-e89b-42d3-a456-426614174000}";
const espnS2 = "sensitive-session-value-that-must-never-reach-telemetry";
const capturedAt = "2026-09-24T14:30:00.000Z";

function corePayload(): unknown {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../connector-espn/test/fixtures/web-client-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    payload: {
      members: Array<{ id: string }>;
      teams: Array<{ owners: string[]; primaryOwner: string }>;
    };
  };
  const activeMemberId = swid.slice(1, -1);
  fixture.payload.members[0]!.id = activeMemberId;
  Object.assign(fixture.payload.members[0]!, { isLeagueManager: false });
  fixture.payload.teams[0]!.owners = [activeMemberId];
  fixture.payload.teams[0]!.primaryOwner = activeMemberId;
  return fixture.payload;
}

function navigationArtifact() {
  return {
    leagueId: externalLeagueId,
    season: 2026,
    endpoint:
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${externalLeagueId}` +
      "?view=mNav",
    capturedAt,
    checksumSha256: "b".repeat(64),
    payload: {
      id: externalLeagueId,
      seasonId: 2026,
      members: [
        {
          id: swid.slice(1, -1),
          isLeagueManager: false,
          isLeagueCreator: true,
        },
      ],
    },
  };
}

function syncFixture() {
  let releaseSupplemental: (() => void) | undefined;
  const supplemental = new Promise<void>((resolve) => {
    releaseSupplemental = resolve;
  });
  let identityVisible = false;
  const events: unknown[] = [];
  const credentials = {
    getSession: vi.fn(() => Promise.resolve({ swid, espnS2 })),
    markReauthorizationRequired: vi.fn(() => Promise.resolve()),
  };
  const persistence = {
    persist: vi.fn(
      async (input: {
        readonly bundle: LeagueSyncBundle;
        readonly checksumSha256: string;
        readonly idempotencyKey: string;
      }) => {
        expect(input.bundle.teams.filter((team) => team.isCurrentUser)).toEqual([
          expect.objectContaining({
            providerTeamId: "101",
            currentUserIsCommissioner: true,
          }),
        ]);
        identityVisible = true;
        return {
          receiptId: "core-run-1",
          leagueId,
          leagueSeasonId,
          recordsWritten: 12,
          state: "accepted" as const,
          identityChanged: true,
        };
      },
    ),
    persistSupplemental: vi.fn(),
  };
  const client = {
    fetchCore: vi.fn(() =>
      Promise.resolve({
        leagueId: externalLeagueId,
        season: 2026,
        endpoint:
          `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${externalLeagueId}` +
          "?view=mSettings&view=mTeam&view=mRoster&view=mStandings&view=mMatchup",
        capturedAt,
        checksumSha256: "a".repeat(64),
        payload: corePayload(),
      }),
    ),
    fetchNavigation: vi.fn(() => Promise.resolve(navigationArtifact())),
    fetchSupplemental: vi.fn(async () => {
      await supplemental;
      throw new Error(`raw upstream data ${swid} ${espnS2}`);
    }),
  };
  const findTarget = vi.fn(() =>
    Promise.resolve({
      leagueId,
      leagueSeasonId,
      externalLeagueId,
      season: 2026,
    }),
  );
  const service = new EspnSessionSyncService({
    database: {} as never,
    credentials,
    client,
    persistence,
    findTarget,
    observe: (event) => events.push(event),
  });
  return {
    client,
    credentials,
    events,
    findTarget,
    identityVisible: () => identityVisible,
    persistence,
    releaseSupplemental: () => releaseSupplemental?.(),
    service,
  };
}

describe("EspnSessionSyncService staged identity persistence", () => {
  it("settles core-only identity while the supplemental provider remains blocked", async () => {
    const fixture = syncFixture();

    await expect(
      fixture.service.syncIdentity(userId, connectionId, leagueSeasonId),
    ).resolves.toMatchObject({
      syncRunId: "core-run-1",
      state: "accepted",
      recordsWritten: 12,
      supplementalAccepted: 0,
      supplementalFailed: 0,
      supplementalFailures: [],
      identityChanged: true,
      reauthorizationRequired: false,
    });

    expect(fixture.identityVisible()).toBe(true);
    expect(fixture.findTarget).toHaveBeenCalledTimes(1);
    expect(fixture.credentials.getSession).toHaveBeenCalledTimes(1);
    expect(fixture.client.fetchCore).toHaveBeenCalledTimes(1);
    expect(fixture.client.fetchNavigation).toHaveBeenCalledTimes(1);
    expect(fixture.persistence.persist).toHaveBeenCalledTimes(1);
    expect(fixture.client.fetchSupplemental).not.toHaveBeenCalled();
    expect(fixture.persistence.persistSupplemental).not.toHaveBeenCalled();
    expect(fixture.events).not.toContainEqual(
      expect.objectContaining({ stage: "supplemental-read" }),
    );
    expect(JSON.stringify(fixture.events)).not.toContain(swid);
    expect(JSON.stringify(fixture.events)).not.toContain(espnS2);
  });

  it("reuses one core transaction before best-effort supplemental stages", async () => {
    const fixture = syncFixture();
    let syncSettled = false;

    const pending = fixture.service
      .syncLeague(userId, connectionId, leagueSeasonId)
      .finally(() => (syncSettled = true));

    await vi.waitFor(() => expect(fixture.persistence.persist).toHaveBeenCalledTimes(1));
    expect(fixture.identityVisible()).toBe(true);
    expect(syncSettled).toBe(false);
    expect(fixture.findTarget).toHaveBeenCalledTimes(1);
    expect(fixture.credentials.getSession).toHaveBeenCalledTimes(1);
    expect(fixture.client.fetchCore).toHaveBeenCalledTimes(1);
    expect(fixture.client.fetchNavigation).toHaveBeenCalledTimes(1);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        event: "espn-session-stage-duration",
        stage: "core-admission-persist",
        outcome: "succeeded",
      }),
    );

    fixture.releaseSupplemental();
    await expect(pending).resolves.toMatchObject({
      syncRunId: "core-run-1",
      state: "accepted",
      supplementalAccepted: 0,
      supplementalFailed: 1,
    });
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        event: "espn-session-stage-duration",
        stage: "supplemental-read",
        outcome: "failed",
        supplementalFailed: 1,
      }),
    );
    expect(JSON.stringify(fixture.events)).not.toContain(swid);
    expect(JSON.stringify(fixture.events)).not.toContain(espnS2);
  });

  it("marks reauthorization when a supplemental read proves the session expired", async () => {
    const fixture = syncFixture();
    fixture.client.fetchSupplemental.mockRejectedValueOnce(
      new EspnSessionReadError({
        code: "AUTHORIZATION_EXPIRED",
        message: "ESPN sign-in must be renewed",
      }),
    );

    await expect(
      fixture.service.syncLeague(userId, connectionId, leagueSeasonId),
    ).resolves.toMatchObject({
      state: "accepted",
      supplementalAccepted: 0,
      supplementalFailed: 1,
      reauthorizationRequired: true,
    });
    expect(fixture.persistence.persist).toHaveBeenCalledTimes(1);
    expect(fixture.credentials.markReauthorizationRequired).toHaveBeenCalledWith(
      userId,
      connectionId,
      "ESPN_SESSION_EXPIRED",
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        stage: "reauthorization-state-persist",
        outcome: "succeeded",
      }),
    );
    expect(fixture.persistence.persistSupplemental).not.toHaveBeenCalled();
  });

  it("marks reauthorization when the dedicated navigation read proves the session expired", async () => {
    const fixture = syncFixture();
    fixture.client.fetchNavigation.mockRejectedValueOnce(
      new EspnSessionReadError({
        code: "AUTHORIZATION_EXPIRED",
        message: "ESPN sign-in must be renewed",
      }),
    );

    await expect(
      fixture.service.syncIdentity(userId, connectionId, leagueSeasonId),
    ).rejects.toMatchObject({ code: "REAUTHORIZATION_REQUIRED" });
    expect(fixture.credentials.markReauthorizationRequired).toHaveBeenCalledWith(
      userId,
      connectionId,
      "ESPN_SESSION_EXPIRED",
    );
    expect(fixture.persistence.persist).not.toHaveBeenCalled();
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ stage: "navigation-read", outcome: "failed" }),
    );
    expect(JSON.stringify(fixture.events)).not.toContain(swid);
    expect(JSON.stringify(fixture.events)).not.toContain(espnS2);
  });

  it("preserves last-good identity when the dedicated navigation read fails", async () => {
    const fixture = syncFixture();
    fixture.client.fetchNavigation.mockRejectedValueOnce(
      new EspnSessionReadError({
        code: "UPSTREAM_ERROR",
        message: `sanitized upstream failure ${swid} ${espnS2}`,
        retryable: true,
      }),
    );

    await expect(
      fixture.service.syncIdentity(userId, connectionId, leagueSeasonId),
    ).rejects.toMatchObject({ code: "PROVIDER_READ_FAILED", retryable: true });
    expect(fixture.persistence.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.events)).not.toContain(swid);
    expect(JSON.stringify(fixture.events)).not.toContain(espnS2);
  });

  it("reports provider schema drift separately from durable persistence failure", async () => {
    const fixture = syncFixture();
    const payload = corePayload() as {
      settings: { draftSettings: { type: string } };
    };
    payload.settings.draftSettings.type = "unsupported-draft-shape";
    fixture.client.fetchCore.mockResolvedValueOnce({
      leagueId: externalLeagueId,
      season: 2026,
      endpoint:
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${externalLeagueId}` +
        "?view=mSettings&view=mTeam&view=mRoster&view=mStandings&view=mMatchup",
      capturedAt,
      checksumSha256: "c".repeat(64),
      payload,
    });

    await expect(
      fixture.service.syncIdentity(userId, connectionId, leagueSeasonId),
    ).rejects.toMatchObject({
      code: "SCHEMA_DRIFT",
      message: "ESPN league data no longer matches the supported format",
      retryable: false,
    });
    expect(fixture.persistence.persist).not.toHaveBeenCalled();
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ stage: "core-normalization", outcome: "failed" }),
    );
    expect(fixture.events).not.toContainEqual(
      expect.objectContaining({ stage: "core-admission-persist" }),
    );
  });

  it("keeps durable write failures classified as persistence failures", async () => {
    const fixture = syncFixture();
    fixture.persistence.persist.mockRejectedValueOnce(new Error("database write failed"));

    await expect(
      fixture.service.syncIdentity(userId, connectionId, leagueSeasonId),
    ).rejects.toMatchObject({ code: "PERSISTENCE_FAILED", retryable: true });
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ stage: "core-normalization", outcome: "succeeded" }),
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ stage: "core-admission-persist", outcome: "failed" }),
    );
  });

  it("does not claim reauthorization when its durable state write fails", async () => {
    const fixture = syncFixture();
    fixture.client.fetchSupplemental.mockRejectedValueOnce(
      new EspnSessionReadError({
        code: "AUTHORIZATION_EXPIRED",
        message: "ESPN sign-in must be renewed",
      }),
    );
    fixture.credentials.markReauthorizationRequired.mockRejectedValueOnce(
      new Error(`database write failed ${swid} ${espnS2}`),
    );

    await expect(
      fixture.service.syncLeague(userId, connectionId, leagueSeasonId),
    ).resolves.toMatchObject({
      state: "accepted",
      supplementalFailed: 1,
      reauthorizationRequired: false,
    });
    expect(fixture.persistence.persist).toHaveBeenCalledTimes(1);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        stage: "reauthorization-state-persist",
        outcome: "failed",
      }),
    );
    expect(JSON.stringify(fixture.events)).not.toContain(swid);
    expect(JSON.stringify(fixture.events)).not.toContain(espnS2);
  });

  it("preserves caller cancellation before core persistence", async () => {
    const fixture = syncFixture();
    const controller = new AbortController();
    const cancellation = new DOMException("worker shutdown", "AbortError");
    fixture.client.fetchCore.mockImplementationOnce(() => {
      controller.abort(cancellation);
      return Promise.reject(cancellation);
    });

    await expect(
      fixture.service.syncLeague(userId, connectionId, leagueSeasonId, controller.signal),
    ).rejects.toBe(cancellation);
    expect(fixture.persistence.persist).not.toHaveBeenCalled();
    expect(fixture.credentials.markReauthorizationRequired).not.toHaveBeenCalled();
  });

  it("re-evaluates navigation authority without changing core admission identity", async () => {
    const fixture = syncFixture();
    const navigationBase = navigationArtifact();
    fixture.client.fetchNavigation.mockReset();
    fixture.client.fetchNavigation
      .mockResolvedValueOnce({
        ...navigationBase,
        checksumSha256: "b".repeat(64),
        payload: {
          id: externalLeagueId,
          seasonId: 2026,
          members: [
            {
              id: swid.slice(1, -1),
              isLeagueManager: false,
              isLeagueCreator: false,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ...navigationBase,
        capturedAt: "2026-09-24T14:31:00.000Z",
        checksumSha256: "c".repeat(64),
        payload: {
          id: externalLeagueId,
          seasonId: 2026,
          members: [
            {
              id: swid.slice(1, -1),
              isLeagueManager: true,
              isLeagueCreator: false,
            },
          ],
        },
      });
    fixture.persistence.persist.mockImplementation(async () => ({
      receiptId: "core-run-1",
      leagueId,
      leagueSeasonId,
      recordsWritten: 12,
      state: "accepted" as const,
      identityChanged: true,
    }));

    await fixture.service.syncIdentity(userId, connectionId, leagueSeasonId);
    await fixture.service.syncIdentity(userId, connectionId, leagueSeasonId);

    const first = fixture.persistence.persist.mock.calls[0]?.[0];
    const second = fixture.persistence.persist.mock.calls[1]?.[0];
    expect(first?.checksumSha256).toBe("a".repeat(64));
    expect(second?.checksumSha256).toBe(first?.checksumSha256);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(first?.bundle.teams.find((team) => team.isCurrentUser)?.currentUserIsCommissioner).toBe(
      false,
    );
    expect(second?.bundle.teams.find((team) => team.isCurrentUser)?.currentUserIsCommissioner).toBe(
      true,
    );
  });

  it("treats the durable core receipt as a no-cancel boundary", async () => {
    const fixture = syncFixture();
    const controller = new AbortController();
    const pending = fixture.service.syncLeague(
      userId,
      connectionId,
      leagueSeasonId,
      controller.signal,
    );

    await vi.waitFor(() => expect(fixture.persistence.persist).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("worker shutdown", "AbortError"));
    fixture.releaseSupplemental();

    await expect(pending).resolves.toMatchObject({
      syncRunId: "core-run-1",
      state: "accepted",
      identityChanged: true,
      supplementalFailed: 1,
    });
  });
});
