import { createHash, randomBytes } from "node:crypto";

import {
  canonicalEspnPayloadChecksumV1,
  espnPayloadChecksumMatches,
  normalizeEspnSupplementalSnapshot,
  normalizeEspnWebClientSnapshot,
} from "@laces-out/connector-espn";
import type { EspnBridgeSnapshot, EspnSupplementalBridgeSnapshot } from "@laces-out/contracts";
import {
  bridgeDeviceLeagues,
  bridgeDevices,
  bridgePairingSessions,
  leagueMemberships,
  leagueSeasons,
  leagueSyncExclusions,
  leagues,
  type Database,
} from "@laces-out/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";

import {
  emitProviderSyncChangeEvents,
  type ChangeEventProducerDependencies,
} from "./change-event-producers.js";
import { DrizzleEspnSyncPersistence } from "./espn-sync-persistence.js";

const deviceLifetimeMs = 365 * 24 * 60 * 60 * 1000;
const pairingSessionLifetimeMs = 10 * 60 * 1000;
const maximumSnapshotAgeMs = 24 * 60 * 60 * 1000;
const maximumFutureSkewMs = 5 * 60 * 1000;
const pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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
  readonly clientKind: "chrome-extension" | "ios-app";
  readonly agentCapable: boolean;
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

export function createEspnBridgePairingCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let buffer = 0;
  let code = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += pairingAlphabet[(buffer >>> bits) & 31]!;
    }
  }
  return code.match(/.{1,4}/gu)?.join("-") ?? code;
}

function normalizedPairingCode(value: string): string {
  return value.trim().toUpperCase();
}

function storedLeagueIds(value: readonly string[]): readonly string[] {
  if (
    value.length < 1 ||
    value.length > 32 ||
    value.some((leagueId) => !/^\d{1,20}$/u.test(leagueId)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Stored ESPN bridge pairing scope is invalid");
  }
  return value;
}

function payloadChecksumMatches(input: {
  readonly payload: unknown;
  readonly checksumSha256: string;
  readonly authority: "browser-local" | "native-local";
}): boolean {
  try {
    return espnPayloadChecksumMatches(input);
  } catch {
    throw new EspnBridgeError("INVALID", "ESPN bridge payload is not JSON serializable");
  }
}

export function espnBridgeAuthorityMatchesClient(
  clientKind: "chrome-extension" | "ios-app",
  authority: "browser-local" | "native-local",
): boolean {
  return clientKind === "ios-app" ? authority === "native-local" : authority === "browser-local";
}

type EspnBridgeTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function knownMemberLeagueIds(
  transaction: EspnBridgeTransaction,
  input: {
    readonly userId: string;
    readonly externalLeagueIds: readonly string[];
    readonly season: number | undefined;
  },
): Promise<ReadonlyMap<string, string>> {
  if (input.season === undefined) return new Map();
  const rows = await transaction
    .select({ externalLeagueId: leagueSeasons.externalKey, leagueId: leagueSeasons.leagueId })
    .from(leagueSeasons)
    .innerJoin(
      leagueMemberships,
      and(
        eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
        eq(leagueMemberships.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(leagueSeasons.provider, "espn"),
        eq(leagueSeasons.season, input.season),
        inArray(leagueSeasons.externalKey, input.externalLeagueIds),
      ),
    );
  return new Map(rows.map((row) => [row.externalLeagueId, row.leagueId]));
}

async function restoreExplicitEspnScopes(
  transaction: EspnBridgeTransaction,
  input: {
    readonly userId: string;
    readonly externalLeagueIds: readonly string[];
    readonly season: number | undefined;
  },
): Promise<void> {
  if (input.season === undefined) return;
  await transaction
    .delete(leagueSyncExclusions)
    .where(
      and(
        eq(leagueSyncExclusions.userId, input.userId),
        eq(leagueSyncExclusions.provider, "espn"),
        eq(leagueSyncExclusions.season, input.season),
        inArray(leagueSyncExclusions.externalKey, input.externalLeagueIds),
      ),
    );
}

export class EspnBridgeService {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #persistence: DrizzleEspnSyncPersistence;
  readonly #changeEvents: ChangeEventProducerDependencies | undefined;
  readonly #onChangeEventError: (error: unknown) => void;

  constructor(
    database: Database,
    now: () => Date = () => new Date(),
    persistence: DrizzleEspnSyncPersistence = new DrizzleEspnSyncPersistence(database),
    /**
     * Optional so an existing fake-database test constructs the service unchanged. When absent no
     * change event is emitted, which is a stated no-op rather than a failure.
     */
    changeEvents?: {
      readonly producers: ChangeEventProducerDependencies;
      readonly onError?: (error: unknown) => void;
    },
  ) {
    this.#database = database;
    this.#now = now;
    this.#persistence = persistence;
    this.#changeEvents = changeEvents?.producers;
    this.#onChangeEventError = changeEvents?.onError ?? (() => undefined);
  }

  /**
   * Emitted *after* the persister's transaction has committed, so the new roster snapshot and its
   * predecessor are both visible. Failures never reach the caller: a change event is an
   * observability surface and must not turn an admitted snapshot into a 500.
   */
  async #emitSyncChangeEvents(input: {
    readonly state: "accepted" | "unchanged";
    readonly leagueId: string;
    readonly leagueSeasonId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly occurredAt: Date;
  }): Promise<void> {
    if (!this.#changeEvents) return;
    await emitProviderSyncChangeEvents(
      this.#changeEvents,
      { provider: "espn", ...input },
      this.#onChangeEventError,
    );
  }

  async listDevices(userId: string): Promise<EspnBridgeDeviceList> {
    const now = this.#now();
    const rows = await this.#database
      .select({
        deviceId: bridgeDevices.id,
        clientKind: bridgeDevices.clientKind,
        agentCapable: bridgeDevices.agentCapable,
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
          clientKind: row.clientKind,
          agentCapable: row.agentCapable,
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
    input: {
      readonly name: string;
      readonly clientKind: "chrome-extension" | "ios-app";
      readonly agentCapabilities: readonly "refresh-intents-v1"[];
      readonly season?: number;
      readonly allowedLeagueIds: readonly string[];
    },
  ): Promise<{
    readonly deviceId: string;
    readonly clientKind: "chrome-extension" | "ios-app";
    readonly agentCapable: boolean;
    readonly deviceToken: string;
    readonly expiresAt: string;
  }> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + deviceLifetimeMs);
    const deviceToken = `lo_espn_${randomBytes(32).toString("base64url")}`;
    const agentCapable = input.agentCapabilities.includes("refresh-intents-v1");
    if (input.clientKind === "ios-app" && (!agentCapable || input.season === undefined)) {
      throw new EspnBridgeError(
        "INVALID",
        "iOS sync devices require agent capability and an exact season",
      );
    }
    const device = await this.#database.transaction(async (transaction) => {
      await restoreExplicitEspnScopes(transaction, {
        userId,
        externalLeagueIds: input.allowedLeagueIds,
        season: input.season,
      });
      const knownLeagues = await knownMemberLeagueIds(transaction, {
        userId,
        externalLeagueIds: input.allowedLeagueIds,
        season: input.season,
      });
      const [stored] = await transaction
        .insert(bridgeDevices)
        .values({
          userId,
          provider: "espn",
          clientKind: input.clientKind,
          agentCapable,
          name: input.name.trim(),
          tokenHash: tokenHash(deviceToken),
          expiresAt,
        })
        .returning({ id: bridgeDevices.id });
      if (!stored) throw new Error("ESPN bridge device could not be created");
      await transaction.insert(bridgeDeviceLeagues).values(
        input.allowedLeagueIds.map((externalLeagueId) => {
          const leagueId = knownLeagues.get(externalLeagueId);
          return {
            bridgeDeviceId: stored.id,
            externalLeagueId,
            season: input.season,
            ...(leagueId ? { leagueId } : {}),
          };
        }),
      );
      return stored;
    });
    return {
      deviceId: device.id,
      clientKind: input.clientKind,
      agentCapable,
      deviceToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async createPairingSession(
    userId: string,
    input: {
      readonly name: string;
      readonly agentCapabilities: readonly "refresh-intents-v1"[];
      readonly allowedLeagueIds: readonly string[];
      readonly season: number;
    },
  ): Promise<{ readonly pairingCode: string; readonly expiresAt: string }> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + pairingSessionLifetimeMs);
    const pairingCode = createEspnBridgePairingCode();
    await this.#database
      .delete(bridgePairingSessions)
      .where(
        and(
          eq(bridgePairingSessions.userId, userId),
          or(
            lte(bridgePairingSessions.expiresAt, now),
            isNotNull(bridgePairingSessions.consumedAt),
          ),
        ),
      );
    await this.#database.insert(bridgePairingSessions).values({
      userId,
      codeHash: tokenHash(pairingCode),
      deviceName: input.name.trim(),
      allowedLeagueIds: [...input.allowedLeagueIds],
      season: input.season,
      expiresAt,
    });
    return { pairingCode, expiresAt: expiresAt.toISOString() };
  }

  async redeemPairingSession(pairingCode: string): Promise<
    | {
        readonly deviceId: string;
        readonly clientKind: "chrome-extension";
        readonly agentCapable: true;
        readonly deviceToken: string;
        readonly expiresAt: string;
        readonly leagueIds: readonly string[];
        readonly season: number;
        readonly automaticSync: true;
      }
    | undefined
  > {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + deviceLifetimeMs);
    const deviceToken = `lo_espn_${randomBytes(32).toString("base64url")}`;
    return this.#database.transaction(async (transaction) => {
      // Updating first makes redemption single-use even when two extension requests race. If any
      // later insert fails, the transaction rolls this consumption marker back with it.
      const [session] = await transaction
        .update(bridgePairingSessions)
        .set({ consumedAt: now })
        .where(
          and(
            eq(bridgePairingSessions.codeHash, tokenHash(normalizedPairingCode(pairingCode))),
            isNull(bridgePairingSessions.consumedAt),
            gt(bridgePairingSessions.expiresAt, now),
          ),
        )
        .returning({
          userId: bridgePairingSessions.userId,
          deviceName: bridgePairingSessions.deviceName,
          allowedLeagueIds: bridgePairingSessions.allowedLeagueIds,
          season: bridgePairingSessions.season,
        });
      if (!session) return undefined;

      const leagueIds = storedLeagueIds(session.allowedLeagueIds);
      await restoreExplicitEspnScopes(transaction, {
        userId: session.userId,
        externalLeagueIds: leagueIds,
        season: session.season,
      });
      const knownLeagues = await knownMemberLeagueIds(transaction, {
        userId: session.userId,
        externalLeagueIds: leagueIds,
        season: session.season,
      });
      const [device] = await transaction
        .insert(bridgeDevices)
        .values({
          userId: session.userId,
          provider: "espn",
          clientKind: "chrome-extension",
          agentCapable: true,
          name: session.deviceName,
          tokenHash: tokenHash(deviceToken),
          expiresAt,
        })
        .returning({ id: bridgeDevices.id });
      if (!device) throw new Error("ESPN bridge device could not be created");
      await transaction.insert(bridgeDeviceLeagues).values(
        leagueIds.map((externalLeagueId) => {
          const leagueId = knownLeagues.get(externalLeagueId);
          return {
            bridgeDeviceId: device.id,
            externalLeagueId,
            season: session.season,
            ...(leagueId ? { leagueId } : {}),
          };
        }),
      );
      return {
        deviceId: device.id,
        clientKind: "chrome-extension" as const,
        agentCapable: true as const,
        deviceToken,
        expiresAt: expiresAt.toISOString(),
        leagueIds,
        season: session.season,
        automaticSync: true as const,
      };
    });
  }

  async acceptSnapshot(
    deviceToken: string,
    snapshot: EspnBridgeSnapshot,
  ): Promise<{
    readonly receiptId: string;
    readonly state: "accepted" | "unchanged";
    readonly receivedAt: string;
    /** Reported so the route can queue downstream work for the league season that actually changed. */
    readonly leagueSeasonId: string;
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
    if (!espnBridgeAuthorityMatchesClient(device.clientKind, snapshot.authority)) {
      throw new EspnBridgeError(
        "INVALID",
        "ESPN snapshot authority does not match the registered sync device",
      );
    }

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
    if (!payloadChecksumMatches(snapshot)) {
      throw new EspnBridgeError("CHECKSUM", "ESPN bridge snapshot checksum does not match payload");
    }

    const canonicalChecksumSha256 = canonicalEspnPayloadChecksumV1(snapshot.payload);
    const idempotencyKey = `espn-core:${snapshot.leagueId}:${snapshot.season}:${canonicalChecksumSha256}:${snapshot.capturedAt}`;
    const bundle = normalizeEspnWebClientSnapshot({
      ...snapshot,
      checksumSha256: canonicalChecksumSha256,
    });
    const receipt = await this.#persistence.persist({
      authority: {
        mode: "bridge",
        actorUserId: device.userId,
        bridgeDeviceId: device.id,
        bridgeScopeId: scope.id,
        clientKind: device.clientKind,
      },
      bundle,
      checksumSha256: canonicalChecksumSha256,
      ...(snapshot.checksumSha256 === canonicalChecksumSha256
        ? {}
        : { checksumAliases: [snapshot.checksumSha256] }),
      effectiveAt: capturedAt,
      idempotencyKey,
      kind: "espn-bridge",
      now,
    });
    await this.#emitSyncChangeEvents({
      state: receipt.state,
      leagueId: receipt.leagueId,
      leagueSeasonId: receipt.leagueSeasonId,
      actorUserId: device.userId,
      artifactId: canonicalChecksumSha256,
      occurredAt: now,
    });
    return {
      receiptId: receipt.receiptId,
      state: receipt.state,
      receivedAt: now.toISOString(),
      leagueSeasonId: receipt.leagueSeasonId,
    };
  }

  async acceptSupplementalSnapshot(
    deviceToken: string,
    snapshot: EspnSupplementalBridgeSnapshot,
  ): Promise<{
    readonly receiptId: string;
    readonly state: "accepted" | "unchanged";
    readonly receivedAt: string;
    /** Reported so the route can queue downstream work for the league season that actually changed. */
    readonly leagueSeasonId: string;
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
    if (!espnBridgeAuthorityMatchesClient(device.clientKind, snapshot.authority)) {
      throw new EspnBridgeError(
        "INVALID",
        "ESPN snapshot authority does not match the registered sync device",
      );
    }

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
    if (!payloadChecksumMatches(snapshot)) {
      throw new EspnBridgeError("CHECKSUM", "ESPN bridge snapshot checksum does not match payload");
    }

    const canonicalChecksumSha256 = canonicalEspnPayloadChecksumV1(snapshot.payload);
    const idempotencyKey = `espn-supplemental:${snapshot.leagueId}:${snapshot.season}:${snapshot.kind}:${canonicalChecksumSha256}:${snapshot.capturedAt}`;
    const bundle = normalizeEspnSupplementalSnapshot({
      ...snapshot,
      checksumSha256: canonicalChecksumSha256,
    });
    const receipt = await this.#persistence.persistSupplemental({
      authority: {
        mode: "bridge",
        actorUserId: device.userId,
        bridgeDeviceId: device.id,
        bridgeScopeId: scope.id,
        clientKind: device.clientKind,
      },
      bundle,
      checksumSha256: canonicalChecksumSha256,
      ...(snapshot.checksumSha256 === canonicalChecksumSha256
        ? {}
        : { checksumAliases: [snapshot.checksumSha256] }),
      effectiveAt: capturedAt,
      idempotencyKey,
      now,
    });
    return {
      receiptId: receipt.receiptId,
      state: receipt.state,
      receivedAt: now.toISOString(),
      leagueSeasonId: receipt.leagueSeasonId,
    };
  }
}
