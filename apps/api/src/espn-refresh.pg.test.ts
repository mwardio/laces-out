/**
 * Real PostgreSQL coverage for ESPN refresh expiry and agent backoff queries. Native Date values
 * reach postgres-js only in this integration shape, so an in-memory repository cannot reproduce
 * the ERR_INVALID_ARG_TYPE failure this suite guards against.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvironment } from "@fantasy/config";
import type { EspnLeagueRefreshStatus } from "@fantasy/contracts";
import {
  bridgeDeviceLeagues,
  bridgeDevices,
  createDatabase,
  espnLeagueSyncStates,
  espnRefreshAttempts,
  leagueSeasons,
  leagues,
  refreshRequests,
  users,
  type Database,
} from "@fantasy/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { DrizzleEspnRefreshRepository, EspnRefreshCoordinator } from "./espn-refresh.js";

function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = dockerIsAvailable();
if (!dockerAvailable) {
  console.warn(
    "[espn-refresh.pg.test] Skipping disposable-PostgreSQL refresh tests: docker is unavailable.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-espn-refresh-pg-${randomUUID().slice(0, 8)}`;
  const user = "laces_test";
  const password = randomBytes(16).toString("hex");
  const databaseName = "laces_test";

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:16",
    ],
    { stdio: "ignore" },
  );

  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", containerName, "pg_isready", "-U", user, "-d", databaseName],
        { stdio: "ignore" },
      );
      break;
    } catch {
      if (Date.now() > readyDeadline) {
        throw new Error(`Disposable PostgreSQL container ${containerName} did not become ready`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  const portMapping = execFileSync("docker", ["port", containerName, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const port = Number(portMapping.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not determine the published host port for ${containerName}`);
  }
  const url = `postgres://${user}:${password}@127.0.0.1:${port}/${databaseName}`;

  const connectDeadline = Date.now() + 20_000;
  for (;;) {
    const probe = postgres(url, { max: 1, prepare: false, connect_timeout: 2 });
    try {
      await probe`select 1`;
      await probe.end({ timeout: 1 });
      break;
    } catch (error) {
      await probe.end({ timeout: 1 }).catch(() => {});
      if (Date.now() > connectDeadline) {
        throw new Error(`Could not connect to ${containerName}: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return { containerName, url };
}

const NOW = new Date("2031-09-20T12:00:00.000Z");
const MEMBER_ID = "10000000-0000-4000-8000-000000000001";
const OUTSIDER_ID = "10000000-0000-4000-8000-000000000002";
const OTHER_OWNER_ID = "10000000-0000-4000-8000-000000000003";
const MEMBER_LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_LEAGUE_ID = "20000000-0000-4000-8000-000000000002";
const QUEUED_SEASON_ID = "30000000-0000-4000-8000-000000000001";
const PROCESSING_SEASON_ID = "30000000-0000-4000-8000-000000000002";
const LIVE_SEASON_ID = "30000000-0000-4000-8000-000000000003";
const OTHER_SEASON_ID = "30000000-0000-4000-8000-000000000004";
const QUEUED_REQUEST_ID = "40000000-0000-4000-8000-000000000001";
const PROCESSING_REQUEST_ID = "40000000-0000-4000-8000-000000000002";
const LIVE_REQUEST_ID = "40000000-0000-4000-8000-000000000003";
const DEVICE_ID = "50000000-0000-4000-8000-000000000001";
const DEVICE_TOKEN = `lo_espn_${"a".repeat(43)}`;
const COOKIE = `fantasy_session=${"s".repeat(32)}`;
const EXPIRED_DETAIL = "No authorized sync path fulfilled this request before it expired.";

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function authentication(userId: string): AuthService {
  const identities = {
    [MEMBER_ID]: { email: "member@example.test", displayName: "Member" },
    [OUTSIDER_ID]: { email: "outsider@example.test", displayName: "Outsider" },
    [OTHER_OWNER_ID]: { email: "other-owner@example.test", displayName: "Other Owner" },
  };
  const identity = identities[userId as keyof typeof identities];
  if (!identity) throw new Error(`Missing test identity for ${userId}`);
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: { id: userId, ...identity, role: "member" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: NOW,
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository, () => NOW);
}

describe.skipIf(!dockerAvailable)(
  "ESPN refresh repository and routes against real PostgreSQL",
  () => {
    let container: DisposablePostgres;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;
    let repository: DrizzleEspnRefreshRepository;

    async function insertRefreshRequest(input: {
      readonly id: string;
      readonly leagueSeasonId: string;
      readonly state: "queued" | "processing";
      readonly createdAt: Date;
      readonly expiresAt: Date;
      readonly startedAt?: Date;
    }): Promise<void> {
      await db.insert(refreshRequests).values({
        id: input.id,
        requestedByUserId: MEMBER_ID,
        leagueSeasonId: input.leagueSeasonId,
        kind: "league",
        state: input.state,
        idempotencyKey: `test:${input.id}`,
        notBefore: input.createdAt,
        expiresAt: input.expiresAt,
        minimumCaptureAt: input.createdAt,
        requiredArtifacts: ["core"],
        startedAt: input.startedAt,
        createdAt: input.createdAt,
      });
    }

    beforeAll(async () => {
      container = await startDisposablePostgres();
      const migrationHandle = createDatabase(container.url, 1);
      try {
        await migrate(migrationHandle.db, { migrationsFolder });
      } finally {
        await migrationHandle.close();
      }
      handle = createDatabase(container.url, 5);
      db = handle.db;
      repository = new DrizzleEspnRefreshRepository(db);

      await db.insert(users).values([
        { id: MEMBER_ID, email: "member@example.test", displayName: "Member" },
        { id: OUTSIDER_ID, email: "outsider@example.test", displayName: "Outsider" },
        { id: OTHER_OWNER_ID, email: "other-owner@example.test", displayName: "Other Owner" },
      ]);
      await db.insert(leagues).values([
        { id: MEMBER_LEAGUE_ID, ownerUserId: MEMBER_ID, name: "Member League" },
        { id: OTHER_LEAGUE_ID, ownerUserId: OTHER_OWNER_ID, name: "Other League" },
      ]);
      await db.insert(leagueSeasons).values([
        {
          id: QUEUED_SEASON_ID,
          leagueId: MEMBER_LEAGUE_ID,
          provider: "espn",
          externalKey: "11111",
          season: 2031,
          status: "active",
          currentWeek: 3,
          teamCount: 10,
          draftType: "snake",
        },
        {
          id: PROCESSING_SEASON_ID,
          leagueId: MEMBER_LEAGUE_ID,
          provider: "espn",
          externalKey: "22222",
          season: 2031,
          status: "active",
          currentWeek: 3,
          teamCount: 10,
          draftType: "snake",
        },
        {
          id: LIVE_SEASON_ID,
          leagueId: MEMBER_LEAGUE_ID,
          provider: "espn",
          externalKey: "33333",
          season: 2031,
          status: "active",
          currentWeek: 3,
          teamCount: 10,
          draftType: "snake",
        },
        {
          id: OTHER_SEASON_ID,
          leagueId: OTHER_LEAGUE_ID,
          provider: "espn",
          externalKey: "44444",
          season: 2031,
          status: "active",
          currentWeek: 3,
          teamCount: 10,
          draftType: "snake",
        },
      ]);
      await db.insert(espnLeagueSyncStates).values({
        leagueSeasonId: QUEUED_SEASON_ID,
        artifactFreshness: { core: "2031-09-19T10:00:00.000+00:00" },
      });
      await db.insert(bridgeDevices).values({
        id: DEVICE_ID,
        userId: MEMBER_ID,
        clientKind: "ios-app",
        agentCapable: true,
        name: "Integration iPhone",
        tokenHash: tokenHash(DEVICE_TOKEN),
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
        lastSeenAt: new Date(NOW.getTime() - 60_000),
        createdAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
      });
      await db.insert(bridgeDeviceLeagues).values({
        bridgeDeviceId: DEVICE_ID,
        externalLeagueId: "33333",
        season: 2031,
        leagueId: MEMBER_LEAGUE_ID,
        grantedAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
      });
    }, 90_000);

    beforeEach(async () => {
      await db.delete(refreshRequests);
      await db
        .update(bridgeDevices)
        .set({ lastSeenAt: new Date(NOW.getTime() - 60_000) })
        .where(eq(bridgeDevices.id, DEVICE_ID));
    });

    afterAll(async () => {
      await handle?.close();
      if (container?.containerName) {
        try {
          execFileSync("docker", ["rm", "-f", container.containerName], { stdio: "ignore" });
        } catch {
          // Best effort; the disposable container was started with --rm.
        }
      }
    });

    it("expires queued and processing requests, preserves live work, and repeats idempotently", async () => {
      const queuedCreatedAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
      const processingCreatedAt = new Date(NOW.getTime() - 3 * 60 * 60_000);
      const processingStartedAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
      await insertRefreshRequest({
        id: QUEUED_REQUEST_ID,
        leagueSeasonId: QUEUED_SEASON_ID,
        state: "queued",
        createdAt: queuedCreatedAt,
        expiresAt: new Date(NOW.getTime() - 60 * 60_000),
      });
      await insertRefreshRequest({
        id: PROCESSING_REQUEST_ID,
        leagueSeasonId: PROCESSING_SEASON_ID,
        state: "processing",
        createdAt: processingCreatedAt,
        startedAt: processingStartedAt,
        expiresAt: new Date(NOW.getTime() - 60 * 60_000),
      });
      await insertRefreshRequest({
        id: LIVE_REQUEST_ID,
        leagueSeasonId: LIVE_SEASON_ID,
        state: "queued",
        createdAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 60 * 60_000),
      });

      await expect(
        repository.inspectMemberTarget(MEMBER_ID, QUEUED_SEASON_ID, NOW),
      ).resolves.toBeDefined();
      await expect(
        repository.inspectMemberTarget(MEMBER_ID, PROCESSING_SEASON_ID, NOW),
      ).resolves.toBeDefined();

      const rows = await db.select().from(refreshRequests);
      const queued = rows.find((row) => row.id === QUEUED_REQUEST_ID);
      const processing = rows.find((row) => row.id === PROCESSING_REQUEST_ID);
      const live = rows.find((row) => row.id === LIVE_REQUEST_ID);
      expect(queued).toMatchObject({
        state: "cancelled",
        errorCode: "EXPIRED",
        errorDetail: EXPIRED_DETAIL,
      });
      expect(queued?.startedAt).toEqual(queuedCreatedAt);
      expect(queued?.finishedAt).toEqual(NOW);
      expect(processing).toMatchObject({
        state: "cancelled",
        errorCode: "EXPIRED",
        errorDetail: EXPIRED_DETAIL,
      });
      expect(processing?.startedAt).toEqual(processingStartedAt);
      expect(processing?.finishedAt).toEqual(NOW);
      expect(live).toMatchObject({
        state: "queued",
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorDetail: null,
      });

      const cancelledOnce = queued;
      await expect(
        repository.inspectMemberTarget(
          MEMBER_ID,
          QUEUED_SEASON_ID,
          new Date(NOW.getTime() + 5 * 60_000),
        ),
      ).resolves.toBeDefined();
      const [cancelledTwice] = await db
        .select()
        .from(refreshRequests)
        .where(eq(refreshRequests.id, QUEUED_REQUEST_ID));
      expect(cancelledTwice).toEqual(cancelledOnce);
    });

    it("serves the authenticated status route when an expired request exists", async () => {
      await insertRefreshRequest({
        id: QUEUED_REQUEST_ID,
        leagueSeasonId: QUEUED_SEASON_ID,
        state: "queued",
        createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        expiresAt: new Date(NOW.getTime() - 60 * 60_000),
      });
      const coordinator = new EspnRefreshCoordinator(
        repository,
        { directEnabled: false },
        () => NOW,
      );
      const app = await buildApp({
        environment: loadEnvironment({ NODE_ENV: "test" }),
        logger: false,
        requireAuthentication: true,
        authService: authentication(MEMBER_ID),
        espnRefresh: coordinator,
      });
      try {
        const response = await app.inject({
          method: "GET",
          url: `/v1/leagues/${QUEUED_SEASON_ID}/refresh/status`,
          headers: { cookie: COOKIE },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json<EspnLeagueRefreshStatus>();
        expect(body).toMatchObject({
          leagueSeasonId: QUEUED_SEASON_ID,
          provider: "espn",
          request: null,
        });
        expect(body.artifacts.find((artifact) => artifact.family === "core")).toMatchObject({
          family: "core",
          observedAt: "2031-09-19T10:00:00.000Z",
        });
      } finally {
        await app.close();
      }
    });

    it("creates one replacement through POST and coalesces repeats inside the cooldown", async () => {
      await insertRefreshRequest({
        id: QUEUED_REQUEST_ID,
        leagueSeasonId: QUEUED_SEASON_ID,
        state: "queued",
        createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        expiresAt: new Date(NOW.getTime() - 60 * 60_000),
      });
      const coordinator = new EspnRefreshCoordinator(
        repository,
        { directEnabled: false },
        () => NOW,
      );
      const app = await buildApp({
        environment: loadEnvironment({ NODE_ENV: "test" }),
        logger: false,
        requireAuthentication: true,
        authService: authentication(MEMBER_ID),
        espnRefresh: coordinator,
      });
      try {
        const first = await app.inject({
          method: "POST",
          url: `/v1/leagues/${QUEUED_SEASON_ID}/refresh`,
          headers: { cookie: COOKIE },
          payload: {},
        });
        const second = await app.inject({
          method: "POST",
          url: `/v1/leagues/${QUEUED_SEASON_ID}/refresh`,
          headers: { cookie: COOKIE },
          payload: {},
        });

        expect(first.statusCode).toBe(202);
        expect(second.statusCode).toBe(202);
        const firstRequestId = first.json<EspnLeagueRefreshStatus>().request?.id;
        if (!firstRequestId) throw new Error("Expected POST to return a live refresh request");
        expect(firstRequestId).not.toBe(QUEUED_REQUEST_ID);
        expect(second.json<EspnLeagueRefreshStatus>().request?.id).toBe(firstRequestId);

        const rows = await db
          .select()
          .from(refreshRequests)
          .where(eq(refreshRequests.leagueSeasonId, QUEUED_SEASON_ID));
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === QUEUED_REQUEST_ID)).toMatchObject({
          state: "cancelled",
          errorCode: "EXPIRED",
          errorDetail: EXPIRED_DETAIL,
        });
        expect(rows.find((row) => row.id === firstRequestId)).toMatchObject({
          state: "queued",
          force: false,
          requestedByUserId: MEMBER_ID,
          createdAt: NOW,
        });
      } finally {
        await app.close();
      }
    });

    it("keeps member and league-season scope enforced for GET and POST", async () => {
      const coordinator = new EspnRefreshCoordinator(
        repository,
        { directEnabled: false },
        () => NOW,
      );
      const outsiderApp = await buildApp({
        environment: loadEnvironment({ NODE_ENV: "test" }),
        logger: false,
        requireAuthentication: true,
        authService: authentication(OUTSIDER_ID),
        espnRefresh: coordinator,
      });
      const memberApp = await buildApp({
        environment: loadEnvironment({ NODE_ENV: "test" }),
        logger: false,
        requireAuthentication: true,
        authService: authentication(MEMBER_ID),
        espnRefresh: coordinator,
      });
      try {
        const outsiderGet = await outsiderApp.inject({
          method: "GET",
          url: `/v1/leagues/${QUEUED_SEASON_ID}/refresh/status`,
          headers: { cookie: COOKIE },
        });
        const outsiderPost = await outsiderApp.inject({
          method: "POST",
          url: `/v1/leagues/${QUEUED_SEASON_ID}/refresh`,
          headers: { cookie: COOKIE },
          payload: {},
        });
        const crossLeagueGet = await memberApp.inject({
          method: "GET",
          url: `/v1/leagues/${OTHER_SEASON_ID}/refresh/status`,
          headers: { cookie: COOKIE },
        });
        const crossLeaguePost = await memberApp.inject({
          method: "POST",
          url: `/v1/leagues/${OTHER_SEASON_ID}/refresh`,
          headers: { cookie: COOKIE },
          payload: {},
        });

        for (const response of [outsiderGet, outsiderPost, crossLeagueGet, crossLeaguePost]) {
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ title: "Request rejected", status: 404 });
        }
        expect(await db.select().from(refreshRequests)).toHaveLength(0);
      } finally {
        await outsiderApp.close();
        await memberApp.close();
      }
    });

    it("applies agent backoff and records the first start time without raw Date interpolation", async () => {
      await insertRefreshRequest({
        id: LIVE_REQUEST_ID,
        leagueSeasonId: LIVE_SEASON_ID,
        state: "queued",
        createdAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 60 * 60_000),
      });
      await db.insert(espnRefreshAttempts).values({
        refreshRequestId: LIVE_REQUEST_ID,
        mode: "native-agent",
        bridgeDeviceId: DEVICE_ID,
        state: "login-required",
        errorCode: "ESPN_LOGIN_REQUIRED",
        errorDetail: "The sync agent could not read ESPN without a renewed local session.",
        startedAt: new Date(NOW.getTime() - 5 * 60_000),
        finishedAt: new Date(NOW.getTime() - 5 * 60_000),
      });

      await expect(repository.pollAgent(DEVICE_TOKEN, NOW)).resolves.toMatchObject({
        requests: [],
      });
      await db.delete(espnRefreshAttempts);
      await expect(repository.pollAgent(DEVICE_TOKEN, NOW)).resolves.toMatchObject({
        requests: [{ requestId: LIVE_REQUEST_ID }],
      });

      let clock = NOW;
      const coordinator = new EspnRefreshCoordinator(
        repository,
        { directEnabled: false },
        () => clock,
      );
      await expect(
        coordinator.reportAgentAttempt(DEVICE_TOKEN, LIVE_REQUEST_ID, { state: "started" }),
      ).resolves.toMatchObject({ state: "started", recordedAt: NOW.toISOString() });
      clock = new Date(NOW.getTime() + 5 * 60_000);
      await expect(
        coordinator.reportAgentAttempt(DEVICE_TOKEN, LIVE_REQUEST_ID, { state: "started" }),
      ).resolves.toMatchObject({ state: "started", recordedAt: clock.toISOString() });

      const [request] = await db
        .select()
        .from(refreshRequests)
        .where(eq(refreshRequests.id, LIVE_REQUEST_ID));
      expect(request).toMatchObject({
        state: "processing",
        fulfillmentMode: "native-agent",
        startedAt: NOW,
        finishedAt: null,
      });
    });
  },
);
