import {
  EspnSessionReadClient,
  EspnSessionReadError,
  normalizeEspnSupplementalSnapshot,
  normalizeEspnWebClientSnapshot,
  type EspnSessionArtifact,
  type EspnSessionLeagueRequest,
  type EspnSessionSupplementalArtifacts,
  type EspnSessionSupplementalArtifact,
} from "@laces-out/connector-espn";
import type { LeagueSupplementalBundle, LeagueSyncBundle } from "@laces-out/connectors";
import {
  leagueMemberships,
  leagueSeasons,
  providerConnections,
  providerLeagueLinks,
  type Database,
} from "@laces-out/db";
import { and, eq } from "drizzle-orm";

import type { EspnSessionCredentialPort } from "./espn-session-connection.js";
import {
  DrizzleEspnSyncPersistence,
  type PersistEspnSupplementalReceipt,
  type PersistEspnSyncReceipt,
} from "./espn-sync-persistence.js";

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
  /** Internal durable-change signal used to run post-commit work on an unchanged core. */
  readonly identityChanged: boolean;
  /** Internal terminal-health signal discovered only after the core became durable. */
  readonly reauthorizationRequired: boolean;
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

export interface EspnSessionTarget {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly externalLeagueId: string;
  readonly season: number;
}

export interface EspnSessionReadPort {
  fetchCore(input: EspnSessionLeagueRequest): Promise<EspnSessionArtifact>;
  fetchSupplemental(input: {
    readonly credential: EspnSessionLeagueRequest["credential"];
    readonly core: EspnSessionArtifact;
    readonly signal?: AbortSignal;
  }): Promise<EspnSessionSupplementalArtifacts>;
}

interface EspnSessionAuthority {
  readonly mode: "server-session";
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly leagueSeasonId: string;
}

export interface EspnSessionPersistencePort {
  persist(input: {
    readonly authority: EspnSessionAuthority;
    readonly bundle: LeagueSyncBundle;
    readonly checksumSha256: string;
    readonly effectiveAt: Date;
    readonly idempotencyKey: string;
    readonly kind: "espn-session";
    readonly now: Date;
  }): Promise<PersistEspnSyncReceipt>;
  persistSupplemental(input: {
    readonly authority: EspnSessionAuthority;
    readonly bundle: LeagueSupplementalBundle;
    readonly checksumSha256: string;
    readonly effectiveAt: Date;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<PersistEspnSupplementalReceipt>;
}

interface EspnSessionCoreSyncResult {
  readonly authority: EspnSessionAuthority;
  readonly core: EspnSessionArtifact;
  readonly credential: EspnSessionLeagueRequest["credential"];
  readonly receipt: EspnSessionSyncReceipt;
  readonly target: EspnSessionTarget;
}

export interface EspnSessionSyncOperationalEvent {
  readonly event: "espn-session-stage-duration";
  readonly stage:
    | "target-resolution"
    | "credential-load"
    | "core-read"
    | "core-admission-persist"
    | "supplemental-read"
    | "supplemental-admission-persist"
    | "reauthorization-state-persist";
  readonly connectionId: string;
  readonly leagueSeasonId: string;
  readonly durationMs: number;
  readonly outcome: "succeeded" | "failed";
  readonly supplementalAccepted?: number;
  readonly supplementalFailed?: number;
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
  readonly #client: EspnSessionReadPort;
  readonly #persistence: EspnSessionPersistencePort;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  readonly #observe: ((event: EspnSessionSyncOperationalEvent) => void) | undefined;
  readonly #findTarget:
    | ((
        userId: string,
        connectionId: string,
        leagueSeasonId: string,
      ) => Promise<EspnSessionTarget | undefined>)
    | undefined;

  constructor(input: {
    readonly database: Database;
    readonly credentials: EspnSessionCredentialPort;
    readonly client?: EspnSessionReadPort;
    readonly persistence?: EspnSessionPersistencePort;
    readonly now?: () => Date;
    readonly monotonicNow?: () => number;
    readonly observe?: (event: EspnSessionSyncOperationalEvent) => void;
    readonly findTarget?: (
      userId: string,
      connectionId: string,
      leagueSeasonId: string,
    ) => Promise<EspnSessionTarget | undefined>;
  }) {
    this.#database = input.database;
    this.#credentials = input.credentials;
    this.#client = input.client ?? new EspnSessionReadClient();
    this.#persistence = input.persistence ?? new DrizzleEspnSyncPersistence(input.database);
    this.#now = input.now ?? (() => new Date());
    this.#monotonicNow = input.monotonicNow ?? (() => performance.now());
    this.#observe = input.observe;
    this.#findTarget = input.findTarget;
  }

  #emit(
    stage: EspnSessionSyncOperationalEvent["stage"],
    startedAt: number,
    input: Omit<EspnSessionSyncOperationalEvent, "event" | "stage" | "durationMs">,
  ): void {
    try {
      this.#observe?.({
        event: "espn-session-stage-duration",
        stage,
        durationMs: Math.max(0, Math.round(this.#monotonicNow() - startedAt)),
        ...input,
      });
    } catch {
      // Observability is deliberately isolated from provider reads, persistence, and queue retry.
    }
  }

  async #target(
    userId: string,
    connectionId: string,
    leagueSeasonId: string,
  ): Promise<EspnSessionTarget | undefined> {
    if (this.#findTarget) return this.#findTarget(userId, connectionId, leagueSeasonId);
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

  async #syncCore(
    userId: string,
    connectionId: string,
    leagueSeasonId: string,
    signal?: AbortSignal,
  ): Promise<EspnSessionCoreSyncResult> {
    signal?.throwIfAborted();
    const targetStartedAt = this.#monotonicNow();
    const target = await this.#target(userId, connectionId, leagueSeasonId);
    this.#emit("target-resolution", targetStartedAt, {
      connectionId,
      leagueSeasonId,
      outcome: target ? "succeeded" : "failed",
    });
    signal?.throwIfAborted();
    if (!target) {
      throw new EspnSessionSyncError(
        "CONNECTION_NOT_FOUND",
        "ESPN connection does not authorize this league",
      );
    }
    const credentialStartedAt = this.#monotonicNow();
    let credential: EspnSessionLeagueRequest["credential"];
    try {
      credential = await this.#credentials.getSession(userId, connectionId);
    } catch (error) {
      this.#emit("credential-load", credentialStartedAt, {
        connectionId,
        leagueSeasonId,
        outcome: "failed",
      });
      signal?.throwIfAborted();
      throw error;
    }
    this.#emit("credential-load", credentialStartedAt, {
      connectionId,
      leagueSeasonId,
      outcome: "succeeded",
    });
    let core: EspnSessionArtifact;
    const coreReadStartedAt = this.#monotonicNow();
    try {
      core = await this.#client.fetchCore({
        credential,
        leagueId: target.externalLeagueId,
        season: target.season,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      this.#emit("core-read", coreReadStartedAt, {
        connectionId,
        leagueSeasonId,
        outcome: "failed",
      });
      signal?.throwIfAborted();
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
    this.#emit("core-read", coreReadStartedAt, {
      connectionId,
      leagueSeasonId,
      outcome: "succeeded",
    });
    // This is the last caller-cancellable point. Persistence is the durable no-cancel boundary.
    signal?.throwIfAborted();

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
      leagueId: core.leagueId,
      season: core.season,
      capturedAt: core.capturedAt,
      endpoint: core.endpoint,
      checksumSha256: core.checksumSha256,
      checksumAlgorithm: "canonical-json-v1-sha256" as const,
      payload: core.payload,
    };
    let coreReceipt;
    const corePersistStartedAt = this.#monotonicNow();
    try {
      // The SWID is the authenticated ESPN member identity for this encrypted server session.
      // It is supplied only as normalizer context: the connector may mark one exact owner-matched
      // team as current, but the credential itself never enters the normalized bundle or storage.
      const bundle = normalizeEspnWebClientSnapshot(coreEnvelope, {
        activeMemberId: credential.swid,
      });
      coreReceipt = await this.#persistence.persist({
        authority,
        bundle,
        checksumSha256: core.checksumSha256,
        effectiveAt: new Date(core.capturedAt),
        idempotencyKey: `espn-session:${connectionId}:${target.externalLeagueId}:${target.season}:core:${core.checksumSha256}`,
        kind: "espn-session",
        now: this.#now(),
      });
    } catch {
      this.#emit("core-admission-persist", corePersistStartedAt, {
        connectionId,
        leagueSeasonId,
        outcome: "failed",
      });
      throw new EspnSessionSyncError(
        "PERSISTENCE_FAILED",
        "ESPN league data could not be committed",
      );
    }
    this.#emit("core-admission-persist", corePersistStartedAt, {
      connectionId,
      leagueSeasonId,
      outcome: "succeeded",
    });

    return {
      authority,
      core,
      credential,
      target,
      receipt: {
        syncRunId: coreReceipt.receiptId,
        leagueId: coreReceipt.leagueId,
        leagueSeasonId: coreReceipt.leagueSeasonId,
        externalLeagueKey: target.externalLeagueId,
        season: target.season,
        state: coreReceipt.state,
        recordsWritten: coreReceipt.recordsWritten,
        syncedAt: core.capturedAt,
        supplementalAccepted: 0,
        supplementalFailed: 0,
        identityChanged: coreReceipt.identityChanged,
        reauthorizationRequired: false,
      },
    };
  }

  /** Persists exact authenticated team and commissioner identity without supplemental reads. */
  async syncIdentity(
    userId: string,
    connectionId: string,
    leagueSeasonId: string,
    signal?: AbortSignal,
  ): Promise<EspnSessionSyncReceipt> {
    return (await this.#syncCore(userId, connectionId, leagueSeasonId, signal)).receipt;
  }

  async syncLeague(
    userId: string,
    connectionId: string,
    leagueSeasonId: string,
    signal?: AbortSignal,
  ): Promise<EspnSessionSyncReceipt> {
    const {
      authority,
      core,
      credential,
      receipt: identityReceipt,
      target,
    } = await this.#syncCore(userId, connectionId, leagueSeasonId, signal);

    // Identity has converged at this point. Every read below is supplemental and independently
    // admitted; slow or drifting undocumented views cannot delay the exact team/manager evidence.
    const supplementalReadStartedAt = this.#monotonicNow();
    let artifacts: EspnSessionSupplementalArtifacts;
    let supplementalReadFailures = 0;
    let reauthorizationRequired = false;
    try {
      artifacts = await this.#client.fetchSupplemental({
        credential,
        core,
        ...(signal ? { signal } : {}),
      });
      this.#emit("supplemental-read", supplementalReadStartedAt, {
        connectionId,
        leagueSeasonId,
        outcome: "succeeded",
        supplementalAccepted: artifacts.supplemental.length,
        supplementalFailed: artifacts.supplementalFailures.length,
      });
    } catch (error) {
      if (error instanceof EspnSessionReadError && error.code === "AUTHORIZATION_EXPIRED") {
        this.#emit("supplemental-read", supplementalReadStartedAt, {
          connectionId,
          leagueSeasonId,
          outcome: "failed",
          supplementalAccepted: 0,
          supplementalFailed: 1,
        });
        const reauthorizationPersistStartedAt = this.#monotonicNow();
        try {
          await this.#credentials.markReauthorizationRequired(
            userId,
            connectionId,
            "ESPN_SESSION_EXPIRED",
          );
          reauthorizationRequired = true;
          this.#emit("reauthorization-state-persist", reauthorizationPersistStartedAt, {
            connectionId,
            leagueSeasonId,
            outcome: "succeeded",
          });
        } catch {
          // The core is already durable, so a health-state write cannot turn this into a provider
          // retry. The closed operational event surfaces the failure without exposing its error.
          this.#emit("reauthorization-state-persist", reauthorizationPersistStartedAt, {
            connectionId,
            leagueSeasonId,
            outcome: "failed",
          });
        }
        artifacts = { supplemental: [], supplementalFailures: [] };
        supplementalReadFailures = 1;
      } else {
        // The admitted core is already durable. An unexpected supplemental orchestration failure
        // is closed as one failed best-effort stage and never rolls back or retries core identity.
        artifacts = { supplemental: [], supplementalFailures: [] };
        supplementalReadFailures = 1;
        this.#emit("supplemental-read", supplementalReadStartedAt, {
          connectionId,
          leagueSeasonId,
          outcome: "failed",
          supplementalAccepted: 0,
          supplementalFailed: supplementalReadFailures,
        });
      }
    }

    let supplementalAccepted = 0;
    let supplementalFailed = artifacts.supplementalFailures.length + supplementalReadFailures;
    let supplementalPersistenceFailed = 0;
    let recordsWritten = identityReceipt.recordsWritten;
    const supplementalPersistStartedAt = this.#monotonicNow();
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
        supplementalPersistenceFailed += 1;
      }
    }
    this.#emit("supplemental-admission-persist", supplementalPersistStartedAt, {
      connectionId,
      leagueSeasonId,
      outcome: supplementalPersistenceFailed === 0 ? "succeeded" : "failed",
      supplementalAccepted,
      supplementalFailed: supplementalPersistenceFailed,
    });

    return {
      ...identityReceipt,
      recordsWritten,
      supplementalAccepted,
      supplementalFailed,
      reauthorizationRequired,
    };
  }
}

export type EspnSessionSyncPort = Pick<EspnSessionSyncService, "syncIdentity" | "syncLeague">;
