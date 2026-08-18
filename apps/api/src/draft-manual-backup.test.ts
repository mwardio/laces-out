import { loadEnvironment } from "@laces-out/config";
import type { DraftSessionSnapshot, EspnLiveDraftFeedStatus } from "@laces-out/contracts";
import type { LeagueMembershipRole } from "@laces-out/db";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { DraftSessionPort } from "./draft-routes.js";
import {
  EspnLiveDraftService,
  type EspnLiveDraftRepository,
  type ManualBackupContext,
  type SetManualBackupInput,
  type SetManualBackupResult,
} from "./espn-live-draft-service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_ID = "30000000-0000-4000-8000-000000000001";
const FEED_ID = "70000000-0000-4000-8000-000000000001";
const TEAM_A_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_B_ID = "40000000-0000-4000-8000-000000000002";
const PLAYER_ID = "50000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const NOW = new Date("2026-08-24T18:05:00.000Z");
const KEY = "manual-backup-3f2a1c4d";

function feedStatus(active: boolean, pending: number): EspnLiveDraftFeedStatus {
  return {
    provider: "espn",
    state: "live",
    providerLeagueId: "1234567",
    season: 2026,
    fresh: true,
    ageSeconds: 2.4,
    lastAcceptedAt: NOW.toISOString(),
    lastMaterialEventAt: NOW.toISOString(),
    pickCount: 1,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    manualBackupActive: active,
    pendingReconciliation: pending,
    standbySources: 0,
    verification: "pending",
    lastIssueCode: active ? "MANUAL_BACKUP_ACTIVE" : null,
    currentAuction: null,
  };
}

const rosterSlot = {
  id: "slot:qb:1",
  type: "QB" as const,
  label: "QB 1",
  kind: "STARTER" as const,
  eligiblePositions: ["QB" as const],
};

function snapshot(feed: EspnLiveDraftFeedStatus, accessRole: LeagueMembershipRole = "owner") {
  return {
    id: DRAFT_ID,
    leagueSeasonId: LEAGUE_SEASON_ID,
    transport: "espn-live",
    providerPolling: true,
    providerFeed: feed,
    accessRole,
    sequence: 0,
    persistedState: "live",
    config: {
      mode: "SNAKE",
      teams: [
        { id: TEAM_A_ID, name: "Ditka's Revenge", rosterSlots: [rosterSlot] },
        { id: TEAM_B_ID, name: "Finkle Is Einhorn", rosterSlots: [rosterSlot] },
      ],
      players: [{ id: PLAYER_ID, name: "Alpha Arm", positions: ["QB"], nflTeam: "CHI" }],
      pickOrder: [TEAM_A_ID, TEAM_B_ID],
    },
    state: {
      mode: "SNAKE",
      teams: [
        { teamId: TEAM_A_ID, name: "Ditka's Revenge", roster: [], openSlots: 1 },
        { teamId: TEAM_B_ID, name: "Finkle Is Einhorn", roster: [], openSlots: 1 },
      ],
      draftedPlayerIds: [],
      activeEventIds: [],
      revertedEventIds: [],
      nextPick: { overallPick: 1, teamId: TEAM_A_ID },
      activeNomination: null,
      complete: false,
    },
    events: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } satisfies DraftSessionSnapshot;
}

function authenticatedService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: USER_ID,
          email: "guru@example.com",
          displayName: "League Guru",
          role: "admin",
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

/**
 * Only the manual backup half of the port is real here; ingest is exercised against its own fake in
 * espn-live-draft-service.test.ts. The feed flag lives on this object so a toggle is observable in
 * the session the route reads back.
 */
class FakeRepository implements EspnLiveDraftRepository {
  accessRole: LeagueMembershipRole | undefined = "owner";
  archived = false;
  feedId: string | null = FEED_ID;
  manualBackupActive = false;
  sequence = 0;
  pendingReconciliation = 0;
  /** Set to force the repository-level race branch: the ledger moved after the context read. */
  raceSequence: number | undefined;
  readonly updates: SetManualBackupInput[] = [];

  loadManualBackupContext(
    actorUserId: string,
    draftId: string,
  ): Promise<ManualBackupContext | undefined> {
    if (actorUserId !== USER_ID || draftId !== DRAFT_ID || this.accessRole === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      feedId: this.feedId,
      accessRole: this.accessRole,
      archived: this.archived,
      manualBackupActive: this.manualBackupActive,
      sequence: this.sequence,
      pendingReconciliation: this.pendingReconciliation,
    });
  }

  setManualBackupActive(input: SetManualBackupInput): Promise<SetManualBackupResult> {
    this.updates.push(input);
    if (this.raceSequence !== undefined) {
      return Promise.resolve({ status: "version-conflict", currentSequence: this.raceSequence });
    }
    this.manualBackupActive = input.active;
    return Promise.resolve({ status: "updated" });
  }

  authorizeDevice(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  authorizePulseDevice(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  authorizePulseMember(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  loadSessionContext(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  claimLease(): Promise<{ granted: boolean; expiresAt: Date | null; generation: number }> {
    return Promise.resolve({ granted: false, expiresAt: null, generation: 0 });
  }

  commitObservation(): Promise<{ sequence: number; committed: boolean }> {
    return Promise.resolve({ sequence: 0, committed: false });
  }

  recordHeartbeat(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  loadFeedStatus(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  loadPulseContext(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

async function manualBackupApp(repository: FakeRepository, configured = true) {
  const draftSessions = {
    getSession: () =>
      Promise.resolve(
        snapshot(
          feedStatus(repository.manualBackupActive, repository.pendingReconciliation),
          repository.accessRole ?? "owner",
        ),
      ),
  } as unknown as DraftSessionPort;
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authenticatedService(),
    draftSessions,
    ...(configured
      ? {
          draftManualBackup: new EspnLiveDraftService(repository, {
            enabled: true,
            now: () => NOW,
          }),
        }
      : {}),
  });
}

function body(overrides: Readonly<Record<string, unknown>> = {}) {
  return { expectedSequence: 0, idempotencyKey: KEY, active: true, ...overrides };
}

describe("manual backup route", () => {
  it("freezes and resumes provider control for a league owner", async () => {
    const repository = new FakeRepository();
    const app = await manualBackupApp(repository);

    const activated = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({
      id: DRAFT_ID,
      providerFeed: { manualBackupActive: true },
    });
    expect(repository.manualBackupActive).toBe(true);

    const resumed = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body({ active: false, idempotencyKey: "manual-backup-resume-1" }),
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ providerFeed: { manualBackupActive: false } });
    expect(repository.updates.map((update) => update.active)).toEqual([true, false]);
    await app.close();
  });

  it("lets a commissioner change shared backup mode", async () => {
    const repository = new FakeRepository();
    repository.accessRole = "commissioner";
    const app = await manualBackupApp(repository);

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(repository.manualBackupActive).toBe(true);
    await app.close();
  });

  it("refuses a manager or viewer and answers a stranger with 404", async () => {
    for (const role of ["manager", "viewer"] as const) {
      const repository = new FakeRepository();
      repository.accessRole = role;
      const app = await manualBackupApp(repository);
      const response = await app.inject({
        method: "POST",
        url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
        headers: { cookie: COOKIE },
        payload: body(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "DRAFT_FORBIDDEN" });
      expect(repository.updates).toHaveLength(0);
      expect(repository.manualBackupActive).toBe(false);
      await app.close();
    }

    // No role at all must not be distinguishable from a draft that does not exist.
    const repository = new FakeRepository();
    repository.accessRole = undefined;
    const app = await manualBackupApp(repository);
    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "DRAFT_NOT_FOUND" });
    expect(repository.updates).toHaveLength(0);
    await app.close();
  });

  it("requires an explicit reconciliation choice while snapshots are held", async () => {
    const repository = new FakeRepository();
    repository.manualBackupActive = true;
    repository.pendingReconciliation = 3;
    const app = await manualBackupApp(repository);

    const undecided = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body({ active: false }),
    });
    expect(undecided.statusCode).toBe(409);
    expect(undecided.json()).toMatchObject({ code: "DRAFT_RECONCILIATION_REQUIRED" });
    expect(repository.updates).toHaveLength(0);
    expect(repository.manualBackupActive).toBe(true);

    // Keeping the manual ledger clears the freeze and nothing else: the held provider snapshots
    // are still only observations, and no revert of a manual entry is written anywhere.
    const kept = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body({ active: false, reconciliation: "keep-manual" }),
    });
    expect(kept.statusCode).toBe(200);
    expect(repository.manualBackupActive).toBe(false);
    expect(repository.updates).toEqual([
      { feedId: FEED_ID, draftId: DRAFT_ID, expectedSequence: 0, active: false, now: NOW },
    ]);
    await app.close();
  });

  it("accepts a reconciliation choice only when returning to provider sync", async () => {
    const repository = new FakeRepository();
    const app = await manualBackupApp(repository);

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body({ reconciliation: "accept-provider" }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "DRAFT_INVALID_INPUT" });
    expect(repository.updates).toHaveLength(0);
    await app.close();
  });

  it("rejects an unknown reconciliation choice", async () => {
    const repository = new FakeRepository();
    const app = await manualBackupApp(repository);

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body({ active: false, reconciliation: "whatever-the-client-wants" }),
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns the current sequence when the ledger moved under the caller", async () => {
    const repository = new FakeRepository();
    repository.sequence = 7;
    const app = await manualBackupApp(repository);

    const stale = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body({ expectedSequence: 4 }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "DRAFT_VERSION_CONFLICT", currentSequence: 7 });
    expect(repository.updates).toHaveLength(0);
    await app.close();
  });

  it("reports the conflict a concurrent append creates between read and write", async () => {
    const repository = new FakeRepository();
    repository.raceSequence = 9;
    const app = await manualBackupApp(repository);

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "DRAFT_VERSION_CONFLICT", currentSequence: 9 });
    expect(repository.manualBackupActive).toBe(false);
    await app.close();
  });

  it("replays the same key as a no-op, even after the ledger has moved on", async () => {
    const repository = new FakeRepository();
    const app = await manualBackupApp(repository);
    const payload = body();

    const first = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload,
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ providerFeed: { manualBackupActive: true } });

    // A room already in the requested mode changes nothing, so a retry whose expected sequence has
    // since been overtaken by a manual pick still succeeds rather than raising a conflict the
    // caller cannot act on.
    repository.sequence = 12;
    const late = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload,
    });
    expect(late.statusCode).toBe(200);
    expect(repository.updates).toHaveLength(1);
    await app.close();
  });

  it("answers 404 for a room that has no provider feed to fall back from", async () => {
    const repository = new FakeRepository();
    repository.feedId = null;
    const app = await manualBackupApp(repository);

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("refuses to change shared state in an archived league", async () => {
    const repository = new FakeRepository();
    repository.archived = true;
    const app = await manualBackupApp(repository);

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("requires authentication and reports an unconfigured server as unavailable", async () => {
    const repository = new FakeRepository();
    const app = await manualBackupApp(repository);
    const anonymous = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      payload: body(),
    });
    expect(anonymous.statusCode).toBe(401);
    expect(repository.updates).toHaveLength(0);
    await app.close();

    const unconfigured = await manualBackupApp(new FakeRepository(), false);
    const response = await unconfigured.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    await unconfigured.close();
  });

  it("answers with the shared session contract and never provider session material", async () => {
    const repository = new FakeRepository();
    const app = await manualBackupApp(repository);

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/manual-backup`,
      headers: { cookie: COOKIE },
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toMatch(/device|token|cookie|swid|espn_s2|lease|username/iu);
    await app.close();
  });
});
