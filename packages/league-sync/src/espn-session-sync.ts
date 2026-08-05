import {
  EspnSessionReadClient,
  EspnSessionReadError,
  normalizeEspnSupplementalSnapshot,
  normalizeEspnWebClientSnapshot,
  type EspnSessionSupplementalArtifact,
} from "@fantasy/connector-espn";
import {
  leagueMemberships,
  leagueSeasons,
  providerConnections,
  providerLeagueLinks,
  type Database,
} from "@fantasy/db";
import { and, eq } from "drizzle-orm";

import type { EspnSessionCredentialPort } from "./espn-session-connection.js";
import { DrizzleEspnSyncPersistence } from "./espn-sync-persistence.js";

export interface EspnSessionSyncReceipt {
  readonly syncRunId: string;
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly externalLeagueKey: string;
  readonly season: number;
  readonly state: "accepted" | "unchanged";
  readonly recordsWritten: number;
  readonly syncedAt: string;
  readonly supplementalAccepted: number;
  readonly supplementalFailed: number;
}

export class EspnSessionSyncError extends Error {
  readonly code:
    | "CONNECTION_NOT_FOUND"
    | "REAUTHORIZATION_REQUIRED"
    | "PROVIDER_READ_FAILED"
    | "PERSISTENCE_FAILED";
  readonly retryable: boolean;

  constructor(code: EspnSessionSyncError["code"], message: string, retryable = false) {
    super(message);
    this.name = "EspnSessionSyncError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface EspnSessionTarget {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly externalLeagueId: string;
  readonly season: number;
}

function supplementalEnvelope(artifact: EspnSessionSupplementalArtifact) {
  return {
    schemaVersion: 1 as const,
    provider: "espn" as const,
    authority: "server-session" as const,
    readOnly: true as const,
    leagueId: artifact.leagueId,
    season: artifact.season,
    capturedAt: artifact.capturedAt,
    endpoint: artifact.endpoint,
    checksumSha256: artifact.checksumSha256,
    checksumAlgorithm: "canonical-json-v1-sha256" as const,
    payload: artifact.payload,
    kind: artifact.kind,
    week: artifact.week,
    ...(artifact.matchupPeriodId === undefined
      ? {}
      : { matchupPeriodId: artifact.matchupPeriodId }),
  };
}

export class EspnSessionSyncService {
  readonly #database: Database;
  readonly #credentials: EspnSessionCredentialPort;
  readonly #client: EspnSessionReadClient;
  readonly #persistence: DrizzleEspnSyncPersistence;
  readonly #now: () => Date;

  constructor(input: {
    readonly database: Database;
    readonly credentials: EspnSessionCredentialPort;
    readonly client?: EspnSessionReadClient;
    readonly persistence?: DrizzleEspnSyncPersistence;
    readonly now?: () => Date;
  }) {
    this.#database = input.database;
    this.#credentials = input.credentials;
    this.#client = input.client ?? new EspnSessionReadClient();
    this.#persistence = input.persistence ?? new DrizzleEspnSyncPersistence(input.database);
    this.#now = input.now ?? (() => new Date());
  }

  async #target(
    userId: string,
    connectionId: string,
    leagueSeasonId: string,
  ): Promise<EspnSessionTarget | undefined> {
    const [target] = await this.#database
      .select({
        leagueId: leagueSeasons.leagueId,
        leagueSeasonId: leagueSeasons.id,
        externalLeagueId: leagueSeasons.externalKey,
        season: leagueSeasons.season,
      })
      .from(providerLeagueLinks)
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, providerLeagueLinks.leagueSeasonId))
      .innerJoin(providerConnections, eq(providerConnections.id, providerLeagueLinks.connectionId))
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
          eq(leagueMemberships.userId, providerConnections.userId),
        ),
      )
      .where(
        and(
          eq(providerLeagueLinks.connectionId, connectionId),
          eq(providerLeagueLinks.leagueSeasonId, leagueSeasonId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "espn"),
          eq(leagueSeasons.provider, "espn"),
        ),
      )
      .limit(1);
    return target;
  }

  async syncLeague(
    userId: string,
    connectionId: string,
    leagueSeasonId: string,
    signal?: AbortSignal,
  ): Promise<EspnSessionSyncReceipt> {
    const target = await this.#target(userId, connectionId, leagueSeasonId);
    if (!target) {
      throw new EspnSessionSyncError(
        "CONNECTION_NOT_FOUND",
        "ESPN connection does not authorize this league",
      );
    }
    const credential = await this.#credentials.getSession(userId, connectionId);
    let artifacts;
    try {
      artifacts = await this.#client.fetchLeague({
        credential,
        leagueId: target.externalLeagueId,
        season: target.season,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof EspnSessionReadError && error.code === "AUTHORIZATION_EXPIRED") {
        await this.#credentials.markReauthorizationRequired(
          userId,
          connectionId,
          "ESPN_SESSION_EXPIRED",
        );
        throw new EspnSessionSyncError("REAUTHORIZATION_REQUIRED", "ESPN sign-in must be renewed");
      }
      throw new EspnSessionSyncError(
        "PROVIDER_READ_FAILED",
        "ESPN league data could not be read",
        error instanceof EspnSessionReadError ? error.retryable : true,
      );
    }

    const authority = {
      mode: "server-session" as const,
      actorUserId: userId,
      connectionId,
      leagueSeasonId,
    };
    const coreEnvelope = {
      schemaVersion: 1 as const,
      provider: "espn" as const,
      authority: "server-session" as const,
      readOnly: true as const,
      leagueId: artifacts.core.leagueId,
      season: artifacts.core.season,
      capturedAt: artifacts.core.capturedAt,
      endpoint: artifacts.core.endpoint,
      checksumSha256: artifacts.core.checksumSha256,
      checksumAlgorithm: "canonical-json-v1-sha256" as const,
      payload: artifacts.core.payload,
    };
    let coreReceipt;
    try {
      const bundle = normalizeEspnWebClientSnapshot(coreEnvelope);
      coreReceipt = await this.#persistence.persist({
        authority,
        bundle,
        checksumSha256: artifacts.core.checksumSha256,
        effectiveAt: new Date(artifacts.core.capturedAt),
        idempotencyKey: `espn-session:${connectionId}:${target.externalLeagueId}:${target.season}:core:${artifacts.core.checksumSha256}`,
        kind: "espn-session",
        now: this.#now(),
      });
    } catch {
      throw new EspnSessionSyncError(
        "PERSISTENCE_FAILED",
        "ESPN league data could not be committed",
      );
    }

    let supplementalAccepted = 0;
    let supplementalFailed = artifacts.supplementalFailures.length;
    let recordsWritten = coreReceipt.recordsWritten;
    for (const artifact of artifacts.supplemental) {
      try {
        const bundle = normalizeEspnSupplementalSnapshot(supplementalEnvelope(artifact));
        const receipt = await this.#persistence.persistSupplemental({
          authority,
          bundle,
          checksumSha256: artifact.checksumSha256,
          effectiveAt: new Date(artifact.capturedAt),
          idempotencyKey: `espn-session:${connectionId}:${target.externalLeagueId}:${target.season}:${artifact.kind}:${artifact.checksumSha256}`,
          now: this.#now(),
        });
        supplementalAccepted += 1;
        recordsWritten += receipt.recordsWritten;
      } catch {
        // Each undocumented supplemental view is admitted independently. A drift in transactions
        // cannot roll back a valid roster or erase the last good waiver snapshot.
        supplementalFailed += 1;
      }
    }

    return {
      syncRunId: coreReceipt.receiptId,
      leagueId: coreReceipt.leagueId,
      leagueSeasonId: coreReceipt.leagueSeasonId,
      externalLeagueKey: target.externalLeagueId,
      season: target.season,
      state: coreReceipt.state,
      recordsWritten,
      syncedAt: artifacts.core.capturedAt,
      supplementalAccepted,
      supplementalFailed,
    };
  }
}

export type EspnSessionSyncPort = Pick<EspnSessionSyncService, "syncLeague">;
