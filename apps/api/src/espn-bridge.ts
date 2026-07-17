import { createHash, randomBytes } from "node:crypto";

import { normalizeEspnWebClientSnapshot } from "@fantasy/connector-espn";
import type { EspnBridgeSnapshot } from "@fantasy/contracts";
import { bridgeDeviceLeagues, bridgeDevices, leagues, type Database } from "@fantasy/db";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";

import { DrizzleEspnSyncPersistence } from "./espn-sync-persistence.js";

const deviceLifetimeMs = 365 * 24 * 60 * 60 * 1000;
const maximumSnapshotAgeMs = 24 * 60 * 60 * 1000;
const maximumFutureSkewMs = 5 * 60 * 1000;

type BridgeErrorCode = "UNAUTHORIZED" | "OUT_OF_SCOPE" | "STALE" | "CHECKSUM" | "INVALID";

export class EspnBridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly statusCode: number;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "EspnBridgeError";
    this.code = code;
    this.statusCode = code === "UNAUTHORIZED" ? 401 : code === "OUT_OF_SCOPE" ? 403 : 400;
  }
}

export interface EspnBridgeDeviceStatus {
  readonly deviceId: string;
  readonly name: string;
  readonly state: "active" | "expired" | "revoked";
  readonly allowedLeagues: readonly {
    readonly externalLeagueId: string;
    readonly season: number | null;
    readonly leagueId: string | null;
    readonly leagueName: string | null;
  }[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
}

export interface EspnBridgeDeviceList {
  readonly generatedAt: string;
  readonly devices: readonly EspnBridgeDeviceStatus[];
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function canonicalChecksum(payload: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new EspnBridgeError("INVALID", "ESPN bridge payload is not JSON serializable");
  }
  if (serialized === undefined) {
    throw new EspnBridgeError("INVALID", "ESPN bridge payload is empty");
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export class EspnBridgeService {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #persistence: DrizzleEspnSyncPersistence;

  constructor(
    database: Database,
    now: () => Date = () => new Date(),
    persistence: DrizzleEspnSyncPersistence = new DrizzleEspnSyncPersistence(database),
  ) {
    this.#database = database;
    this.#now = now;
    this.#persistence = persistence;
  }

  async listDevices(userId: string): Promise<EspnBridgeDeviceList> {
    const now = this.#now();
    const rows = await this.#database
      .select({
        deviceId: bridgeDevices.id,
        name: bridgeDevices.name,
        createdAt: bridgeDevices.createdAt,
        expiresAt: bridgeDevices.expiresAt,
        lastSeenAt: bridgeDevices.lastSeenAt,
        revokedAt: bridgeDevices.revokedAt,
        externalLeagueId: bridgeDeviceLeagues.externalLeagueId,
        season: bridgeDeviceLeagues.season,
        leagueId: bridgeDeviceLeagues.leagueId,
        leagueName: leagues.name,
      })
      .from(bridgeDevices)
      .leftJoin(bridgeDeviceLeagues, eq(bridgeDeviceLeagues.bridgeDeviceId, bridgeDevices.id))
      .leftJoin(leagues, eq(leagues.id, bridgeDeviceLeagues.leagueId))
      .where(eq(bridgeDevices.userId, userId))
      .orderBy(desc(bridgeDevices.createdAt), asc(bridgeDeviceLeagues.externalLeagueId));

    const devices = new Map<string, EspnBridgeDeviceStatus>();
    for (const row of rows) {
      let device = devices.get(row.deviceId);
      if (!device) {
        const state = row.revokedAt
          ? "revoked"
          : row.expiresAt && row.expiresAt.getTime() <= now.getTime()
            ? "expired"
            : "active";
        device = {
          deviceId: row.deviceId,
          name: row.name,
          state,
          allowedLeagues: [],
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null,
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
        };
        devices.set(row.deviceId, device);
      }
      if (row.externalLeagueId) {
        (device.allowedLeagues as Array<EspnBridgeDeviceStatus["allowedLeagues"][number]>).push({
          externalLeagueId: row.externalLeagueId,
          season: row.season,
          leagueId: row.leagueId,
          leagueName: row.leagueName,
        });
      }
    }

    return { generatedAt: now.toISOString(), devices: [...devices.values()] };
  }

  async revokeDevice(
    userId: string,
    deviceId: string,
  ): Promise<{ readonly deviceId: string; readonly revokedAt: string } | undefined> {
    const now = this.#now();
    const [revoked] = await this.#database
      .update(bridgeDevices)
      .set({ revokedAt: now })
      .where(
        and(
          eq(bridgeDevices.id, deviceId),
          eq(bridgeDevices.userId, userId),
          isNull(bridgeDevices.revokedAt),
        ),
      )
      .returning({ deviceId: bridgeDevices.id, revokedAt: bridgeDevices.revokedAt });
    if (revoked?.revokedAt) {
      return { deviceId: revoked.deviceId, revokedAt: revoked.revokedAt.toISOString() };
    }

    const [existing] = await this.#database
      .select({ deviceId: bridgeDevices.id, revokedAt: bridgeDevices.revokedAt })
      .from(bridgeDevices)
      .where(and(eq(bridgeDevices.id, deviceId), eq(bridgeDevices.userId, userId)))
      .limit(1);
    return existing?.revokedAt
      ? { deviceId: existing.deviceId, revokedAt: existing.revokedAt.toISOString() }
      : undefined;
  }

  async registerDevice(
    userId: string,
    input: { readonly name: string; readonly allowedLeagueIds: readonly string[] },
  ): Promise<{
    readonly deviceId: string;
    readonly deviceToken: string;
    readonly expiresAt: string;
  }> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + deviceLifetimeMs);
    const deviceToken = `lo_espn_${randomBytes(32).toString("base64url")}`;
    const device = await this.#database.transaction(async (transaction) => {
      const [stored] = await transaction
        .insert(bridgeDevices)
        .values({
          userId,
          provider: "espn",
          name: input.name.trim(),
          tokenHash: tokenHash(deviceToken),
          expiresAt,
        })
        .returning({ id: bridgeDevices.id });
      if (!stored) throw new Error("ESPN bridge device could not be created");
      await transaction.insert(bridgeDeviceLeagues).values(
        input.allowedLeagueIds.map((externalLeagueId) => ({
          bridgeDeviceId: stored.id,
          externalLeagueId,
        })),
      );
      return stored;
    });
    return { deviceId: device.id, deviceToken, expiresAt: expiresAt.toISOString() };
  }

  async acceptSnapshot(
    deviceToken: string,
    snapshot: EspnBridgeSnapshot,
  ): Promise<{
    readonly receiptId: string;
    readonly state: "accepted" | "unchanged";
    readonly receivedAt: string;
  }> {
    const now = this.#now();
    const [device] = await this.#database
      .select()
      .from(bridgeDevices)
      .where(
        and(
          eq(bridgeDevices.tokenHash, tokenHash(deviceToken)),
          eq(bridgeDevices.provider, "espn"),
          isNull(bridgeDevices.revokedAt),
          or(isNull(bridgeDevices.expiresAt), gt(bridgeDevices.expiresAt, now)),
        ),
      )
      .limit(1);
    if (!device) throw new EspnBridgeError("UNAUTHORIZED", "ESPN bridge device is not active");

    const [scope] = await this.#database
      .select()
      .from(bridgeDeviceLeagues)
      .where(
        and(
          eq(bridgeDeviceLeagues.bridgeDeviceId, device.id),
          eq(bridgeDeviceLeagues.externalLeagueId, snapshot.leagueId),
          or(isNull(bridgeDeviceLeagues.season), eq(bridgeDeviceLeagues.season, snapshot.season)),
        ),
      )
      .limit(1);
    if (!scope) {
      throw new EspnBridgeError("OUT_OF_SCOPE", "ESPN league is outside this bridge device scope");
    }

    const capturedAt = new Date(snapshot.capturedAt);
    const snapshotAge = now.getTime() - capturedAt.getTime();
    if (snapshotAge > maximumSnapshotAgeMs || snapshotAge < -maximumFutureSkewMs) {
      throw new EspnBridgeError("STALE", "ESPN bridge snapshot capture time is not current");
    }
    if (canonicalChecksum(snapshot.payload) !== snapshot.checksumSha256) {
      throw new EspnBridgeError("CHECKSUM", "ESPN bridge snapshot checksum does not match payload");
    }

    const bundle = normalizeEspnWebClientSnapshot(snapshot);
    const receipt = await this.#persistence.persist({
      authority: {
        mode: "bridge",
        actorUserId: device.userId,
        bridgeDeviceId: device.id,
        bridgeScopeId: scope.id,
      },
      bundle,
      checksumSha256: snapshot.checksumSha256,
      effectiveAt: capturedAt,
      idempotencyKey: `espn-bridge:${device.id}:${snapshot.leagueId}:${snapshot.season}:${snapshot.checksumSha256}`,
      kind: "espn-bridge",
      now,
    });
    return {
      receiptId: receipt.receiptId,
      state: receipt.state,
      receivedAt: now.toISOString(),
    };
  }
}
