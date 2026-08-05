import { createHash, createHmac } from "node:crypto";

import {
  ESPN_SERVER_SESSION_CAPABILITIES,
  normalizeEspnSessionCredential,
  type EspnSessionCredential,
} from "@fantasy/connector-espn";
import type {
  EspnSessionConnection,
  EspnSessionConnectionList,
  EspnSessionGrantRequest,
  EspnSessionGrantResponse,
} from "@fantasy/contracts";
import {
  auditEvents,
  bridgeDeviceLeagues,
  bridgeDevices,
  leagueMemberships,
  leagues,
  leagueSeasons,
  providerConnections,
  providerLeagueLinks,
  type Database,
} from "@fantasy/db";
import { decryptCredential, encryptCredential, type CredentialKey } from "@fantasy/security";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";

const maximumCaptureAgeMs = 10 * 60 * 1_000;
const maximumFutureSkewMs = 5 * 60 * 1_000;

interface StoredEspnSessionCredential {
  readonly credentialVersion: 1;
  readonly capturedAt: string;
  readonly session: EspnSessionCredential;
}

export class EspnSessionConnectionError extends Error {
  readonly code:
    | "UNAVAILABLE"
    | "UNAUTHORIZED"
    | "STALE_CAPTURE"
    | "CONNECTION_NOT_FOUND"
    | "REAUTHORIZATION_REQUIRED"
    | "CREDENTIAL_INVALID";
  readonly statusCode: number;

  constructor(code: EspnSessionConnectionError["code"], message: string) {
    super(message);
    this.name = "EspnSessionConnectionError";
    this.code = code;
    this.statusCode =
      code === "UNAUTHORIZED"
        ? 401
        : code === "CONNECTION_NOT_FOUND"
          ? 404
          : code === "UNAVAILABLE"
            ? 503
            : code === "REAUTHORIZATION_REQUIRED"
              ? 409
              : 400;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function accountFingerprint(key: CredentialKey, swid: string): string {
  return `swid-hmac:${createHmac("sha256", key.keyBytes).update(swid, "utf8").digest("base64url")}`;
}

function credentialPurpose(userId: string, externalAccountId: string): string {
  return `espn-session:${userId}:${externalAccountId}`;
}

function safeCorrelationId(value: string): string {
  return value.slice(0, 128);
}

export interface EspnSessionCredentialPort {
  getSession(userId: string, connectionId: string): Promise<EspnSessionCredential>;
  markReauthorizationRequired(
    userId: string,
    connectionId: string,
    errorCode: string,
  ): Promise<void>;
}

export class EspnSessionConnectionService implements EspnSessionCredentialPort {
  readonly #database: Database;
  readonly #key: CredentialKey;
  readonly #enabled: boolean;
  readonly #now: () => Date;

  constructor(input: {
    readonly database: Database;
    readonly credentialKey: CredentialKey;
    readonly enabled: boolean;
    readonly now?: () => Date;
  }) {
    this.#database = input.database;
    this.#key = input.credentialKey;
    this.#enabled = input.enabled;
    this.#now = input.now ?? (() => new Date());
  }

  async grantFromBridge(
    deviceToken: string,
    input: EspnSessionGrantRequest,
    correlationId: string,
  ): Promise<EspnSessionGrantResponse> {
    if (!this.#enabled) {
      throw new EspnSessionConnectionError(
        "UNAVAILABLE",
        "Always-on ESPN sync is not enabled on this Laces Out instance",
      );
    }
    const now = this.#now();
    const capturedAt = new Date(input.capturedAt);
    const captureAge = now.getTime() - capturedAt.getTime();
    if (
      !Number.isFinite(capturedAt.getTime()) ||
      captureAge > maximumCaptureAgeMs ||
      captureAge < -maximumFutureSkewMs
    ) {
      throw new EspnSessionConnectionError(
        "STALE_CAPTURE",
        "ESPN authorization capture is no longer current",
      );
    }
    let session: EspnSessionCredential;
    try {
      session = normalizeEspnSessionCredential({ swid: input.swid, espnS2: input.espnS2 });
    } catch {
      throw new EspnSessionConnectionError(
        "CREDENTIAL_INVALID",
        "ESPN authorization capture is invalid",
      );
    }

    return this.#database.transaction(async (transaction) => {
      const [device] = await transaction
        .select({
          id: bridgeDevices.id,
          userId: bridgeDevices.userId,
          clientKind: bridgeDevices.clientKind,
        })
        .from(bridgeDevices)
        .where(
          and(
            eq(bridgeDevices.tokenHash, tokenHash(deviceToken)),
            eq(bridgeDevices.provider, "espn"),
            inArray(bridgeDevices.clientKind, ["chrome-extension", "ios-app"]),
            eq(bridgeDevices.agentCapable, true),
            isNull(bridgeDevices.revokedAt),
            or(isNull(bridgeDevices.expiresAt), gt(bridgeDevices.expiresAt, now)),
          ),
        )
        .limit(1)
        .for("update");
      if (!device) {
        throw new EspnSessionConnectionError("UNAUTHORIZED", "ESPN sync device is not active");
      }

      const externalAccountId = accountFingerprint(this.#key, session.swid);
      const encryptedCredential = encryptCredential(
        {
          credentialVersion: 1,
          capturedAt: capturedAt.toISOString(),
          session,
        } satisfies StoredEspnSessionCredential,
        this.#key,
        { purpose: credentialPurpose(device.userId, externalAccountId), now: () => now },
      );
      const capabilities = JSON.parse(JSON.stringify(ESPN_SERVER_SESSION_CAPABILITIES)) as Record<
        string,
        unknown
      >;
      const [connection] = await transaction
        .insert(providerConnections)
        .values({
          userId: device.userId,
          provider: "espn",
          externalAccountId,
          displayName: "ESPN Fantasy",
          encryptedCredential: encryptedCredential as unknown as Record<string, unknown>,
          credentialVersion: 1,
          capabilities,
          health: "healthy",
        })
        .onConflictDoUpdate({
          target: [
            providerConnections.userId,
            providerConnections.provider,
            providerConnections.externalAccountId,
          ],
          set: {
            encryptedCredential: encryptedCredential as unknown as Record<string, unknown>,
            credentialVersion: 1,
            capabilities,
            health: "healthy",
            lastErrorCode: null,
            lastErrorAt: null,
            lastErrorDetail: null,
            consecutiveFailures: 0,
            circuitOpenUntil: null,
            updatedAt: now,
          },
        })
        .returning({ id: providerConnections.id });
      if (!connection) throw new Error("ESPN server-session connection could not be stored");

      await transaction
        .update(bridgeDevices)
        .set({ connectionId: connection.id, lastSeenAt: now })
        .where(eq(bridgeDevices.id, device.id));

      const scopedSeasons = await transaction
        .select({
          leagueSeasonId: leagueSeasons.id,
          currentConnectionId: leagueSeasons.connectionId,
        })
        .from(bridgeDeviceLeagues)
        .innerJoin(
          leagueSeasons,
          and(
            eq(leagueSeasons.provider, "espn"),
            eq(leagueSeasons.externalKey, bridgeDeviceLeagues.externalLeagueId),
            or(
              isNull(bridgeDeviceLeagues.season),
              eq(leagueSeasons.season, bridgeDeviceLeagues.season),
            ),
          ),
        )
        .innerJoin(
          leagueMemberships,
          and(
            eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
            eq(leagueMemberships.userId, device.userId),
          ),
        )
        .where(eq(bridgeDeviceLeagues.bridgeDeviceId, device.id));
      if (scopedSeasons.length > 0) {
        await transaction
          .insert(providerLeagueLinks)
          .values(
            scopedSeasons.map((season) => ({
              connectionId: connection.id,
              leagueSeasonId: season.leagueSeasonId,
              discoveredAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoNothing();
        const unassignedSeasonIds = scopedSeasons
          .filter((season) => season.currentConnectionId === null)
          .map((season) => season.leagueSeasonId);
        if (unassignedSeasonIds.length > 0) {
          await transaction
            .update(leagueSeasons)
            .set({ connectionId: connection.id, updatedAt: now })
            .where(
              and(
                inArray(leagueSeasons.id, unassignedSeasonIds),
                isNull(leagueSeasons.connectionId),
              ),
            );
        }
      }

      await transaction.insert(auditEvents).values({
        userId: device.userId,
        action: "espn.connection.server_session_enabled",
        targetType: "provider_connection",
        targetId: connection.id,
        correlationId: safeCorrelationId(correlationId),
        metadata: {
          provider: "espn",
          readOnly: true,
          encryptedAtRest: true,
          grantClientKind: device.clientKind,
          linkedLeagueSeasonCount: scopedSeasons.length,
        },
        occurredAt: now,
      });

      return {
        connectionId: connection.id,
        state: "healthy" as const,
        linkedLeagueCount: scopedSeasons.length,
      };
    });
  }

  async listConnections(userId: string): Promise<EspnSessionConnectionList> {
    if (!this.#enabled) return { available: false, connections: [] };
    const rows = await this.#database
      .select({
        id: providerConnections.id,
        displayName: providerConnections.displayName,
        health: providerConnections.health,
        lastSuccessfulAt: providerConnections.lastSuccessfulAt,
        lastErrorCode: providerConnections.lastErrorCode,
        lastErrorAt: providerConnections.lastErrorAt,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "espn"),
          isNotNull(providerConnections.encryptedCredential),
        ),
      )
      .orderBy(asc(providerConnections.createdAt));
    if (rows.length === 0) return { available: true, connections: [] };
    const links = await this.#database
      .select({
        connectionId: providerLeagueLinks.connectionId,
        leagueId: leagues.id,
        leagueSeasonId: leagueSeasons.id,
        name: leagues.name,
        externalKey: leagueSeasons.externalKey,
        season: leagueSeasons.season,
        linkLastSyncedAt: providerLeagueLinks.lastSyncedAt,
        seasonLastSyncedAt: leagueSeasons.lastSyncedAt,
      })
      .from(providerLeagueLinks)
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, providerLeagueLinks.leagueSeasonId))
      .innerJoin(leagues, eq(leagues.id, leagueSeasons.leagueId))
      .where(
        inArray(
          providerLeagueLinks.connectionId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(leagues.name), asc(leagueSeasons.season));
    const byConnection = new Map<string, EspnSessionConnection["leagues"][number][]>();
    for (const link of links) {
      const list = byConnection.get(link.connectionId) ?? [];
      list.push({
        leagueId: link.leagueId,
        leagueSeasonId: link.leagueSeasonId,
        name: link.name,
        externalKey: link.externalKey,
        season: link.season,
        lastSyncedAt: (link.linkLastSyncedAt ?? link.seasonLastSyncedAt)?.toISOString() ?? null,
      });
      byConnection.set(link.connectionId, list);
    }
    return {
      available: true,
      connections: rows.map((row) => ({
        connectionId: row.id,
        displayName: row.displayName ?? "ESPN Fantasy",
        health: row.health,
        lastSuccessfulAt: row.lastSuccessfulAt?.toISOString() ?? null,
        lastErrorCode: row.lastErrorCode,
        lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
        leagues: byConnection.get(row.id) ?? [],
      })),
    };
  }

  async disconnectConnection(
    userId: string,
    connectionId: string,
    correlationId: string,
  ): Promise<boolean> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, connectionId),
            eq(providerConnections.userId, userId),
            eq(providerConnections.provider, "espn"),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection) return false;
      const linked = await transaction
        .select({ id: providerLeagueLinks.leagueSeasonId })
        .from(providerLeagueLinks)
        .where(eq(providerLeagueLinks.connectionId, connectionId));
      await transaction
        .update(leagueSeasons)
        .set({ connectionId: null, updatedAt: now })
        .where(eq(leagueSeasons.connectionId, connectionId));
      await transaction
        .update(bridgeDevices)
        .set({ connectionId: null })
        .where(eq(bridgeDevices.connectionId, connectionId));
      const deleted = await transaction
        .delete(providerConnections)
        .where(
          and(
            eq(providerConnections.id, connectionId),
            eq(providerConnections.userId, userId),
            eq(providerConnections.provider, "espn"),
          ),
        )
        .returning({ id: providerConnections.id });
      if (deleted.length !== 1) throw new Error("ESPN connection disappeared during disconnect");
      await transaction.insert(auditEvents).values({
        userId,
        action: "espn.connection.server_session_removed",
        targetType: "provider_connection",
        targetId: connectionId,
        correlationId: safeCorrelationId(correlationId),
        metadata: {
          provider: "espn",
          localCredentialRemoved: true,
          linkedLeagueSeasonCount: linked.length,
          synchronizedLeagueData: "preserved_last_known",
        },
        occurredAt: now,
      });
      return true;
    });
  }

  async getSession(userId: string, connectionId: string): Promise<EspnSessionCredential> {
    const [connection] = await this.#database
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "espn"),
        ),
      )
      .limit(1);
    if (!connection?.encryptedCredential) {
      throw new EspnSessionConnectionError("CONNECTION_NOT_FOUND", "ESPN connection was not found");
    }
    if (connection.health === "reauthorize" || connection.health === "disabled") {
      throw new EspnSessionConnectionError(
        "REAUTHORIZATION_REQUIRED",
        "ESPN sign-in must be renewed",
      );
    }
    try {
      const stored = decryptCredential<StoredEspnSessionCredential>(
        connection.encryptedCredential,
        this.#key,
        { expectedPurpose: credentialPurpose(userId, connection.externalAccountId) },
      );
      if (stored.credentialVersion !== 1) throw new Error("Unsupported credential version");
      return normalizeEspnSessionCredential(stored.session);
    } catch {
      throw new EspnSessionConnectionError(
        "CREDENTIAL_INVALID",
        "Stored ESPN authorization could not be read",
      );
    }
  }

  async markReauthorizationRequired(
    userId: string,
    connectionId: string,
    errorCode: string,
  ): Promise<void> {
    const now = this.#now();
    await this.#database
      .update(providerConnections)
      .set({
        health: "reauthorize",
        lastErrorCode: errorCode.slice(0, 64),
        lastErrorAt: now,
        lastErrorDetail: "ESPN sign-in must be renewed.",
        updatedAt: now,
      })
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "espn"),
        ),
      );
  }
}

export type EspnSessionConnectionPort = Pick<
  EspnSessionConnectionService,
  "grantFromBridge" | "listConnections" | "disconnectConnection"
>;
