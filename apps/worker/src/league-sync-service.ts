import {
  CONNECTION_CIRCUIT_FAILURE_THRESHOLD,
  evaluateConnectionCircuit,
  nextCircuitOpenUntil,
  providerSupportsServerRefresh,
  type EspnDirectSyncPort,
  type YahooSyncPort,
} from "@fantasy/league-sync";
import {
  leagueSeasons,
  providerConnections,
  type ConnectionHealth,
  type Database,
  type ProviderName,
} from "@fantasy/db";
import { and, eq, sql } from "drizzle-orm";

import type {
  LeagueSyncJob,
  LeagueSyncService as LeagueSyncServicePort,
  WorkerJobContext,
} from "./jobs.js";

/**
 * Executes a queued `league-sync` job.
 *
 * Provider capability is resolved at the target and mode level. Yahoo connection jobs use the
 * server-held OAuth refresh token. ESPN server-direct jobs use only the credential-free public-read
 * port after league-level evidence verification; private ESPN leagues remain assisted-agent work.
 *
 * Every stated no-op therefore *resolves*. Only a genuine retryable provider failure throws, so what
 * reaches `league-sync-dead-letter` is a real fault rather than a permanently impossible job.
 */

export type LeagueSyncOutcome =
  | { readonly state: "synced"; readonly recordsWritten: number; readonly syncRunId: string }
  | { readonly state: "unchanged"; readonly syncRunId: string }
  | { readonly state: "external-companion-required"; readonly provider: ProviderName }
  | { readonly state: "provider-unconfigured"; readonly provider: ProviderName }
  | { readonly state: "reauthorization-required"; readonly connectionId: string }
  | { readonly state: "circuit-open"; readonly retryAfterSeconds: number }
  | { readonly state: "target-missing" };

export interface LeagueSyncTarget {
  readonly userId: string;
  readonly provider: ProviderName;
  readonly externalKey: string;
  readonly connectionHealth: ConnectionHealth;
  readonly consecutiveFailures: number;
  readonly circuitOpenUntil: Date | null;
}

export interface LeagueSyncTargetReader {
  findSyncTarget(input: {
    readonly connectionId: string;
    readonly leagueSeasonId: string;
  }): Promise<LeagueSyncTarget | undefined>;
}

export interface ConnectionCircuitStore {
  recordSuccess(connectionId: string, at: Date): Promise<void>;
  recordFailure(input: {
    readonly connectionId: string;
    readonly at: Date;
    readonly errorCode: string;
    readonly errorDetail: string;
  }): Promise<{ readonly state: "closed" | "open"; readonly consecutiveFailures: number }>;
}

function abortIfCancelled(context: WorkerJobContext): void {
  if (context.signal.aborted) throw new Error("League sync was aborted during shutdown");
}

function failureCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && code.length > 0) return code.slice(0, 64);
  }
  return "PROVIDER_SYNC_FAILED";
}

function failureDetail(error: unknown): string {
  // Message only, truncated. A provider error must never carry a token or cookie into the row.
  return (error instanceof Error ? error.message : "Provider sync failed").slice(0, 500);
}

export class LeagueSyncService implements LeagueSyncServicePort {
  readonly #targets: LeagueSyncTargetReader;
  readonly #yahooSync: YahooSyncPort | undefined;
  readonly #espnDirect: EspnDirectSyncPort | undefined;
  readonly #circuit: ConnectionCircuitStore;
  readonly #now: () => Date;

  constructor(input: {
    readonly targets: LeagueSyncTargetReader;
    readonly yahooSync?: YahooSyncPort;
    readonly espnDirect?: EspnDirectSyncPort;
    readonly circuit: ConnectionCircuitStore;
    readonly now?: () => Date;
  }) {
    this.#targets = input.targets;
    this.#yahooSync = input.yahooSync;
    this.#espnDirect = input.espnDirect;
    this.#circuit = input.circuit;
    this.#now = input.now ?? (() => new Date());
  }

  /** Adapts the typed outcome to the queue handler's `Promise<void>` contract. */
  async syncLeague(job: LeagueSyncJob, context: WorkerJobContext): Promise<void> {
    await this.runLeagueSync(job, context);
  }

  async runLeagueSync(job: LeagueSyncJob, context: WorkerJobContext): Promise<LeagueSyncOutcome> {
    abortIfCancelled(context);

    if (job.mode === "server-direct") {
      if (!this.#espnDirect) return { state: "provider-unconfigured", provider: "espn" };
      const outcome = await this.#espnDirect.syncLeague(
        {
          leagueSeasonId: job.leagueSeasonId,
          ...(job.refreshRequestId ? { refreshRequestId: job.refreshRequestId } : {}),
          probe: job.probe ?? false,
        },
        context.signal,
      );
      if (outcome.state === "accepted") {
        return {
          state: "synced",
          recordsWritten: outcome.recordsWritten,
          syncRunId: outcome.syncRunId,
        };
      }
      if (outcome.state === "unchanged") {
        return { state: "unchanged", syncRunId: outcome.syncRunId };
      }
      if (outcome.state === "target-missing") return { state: "target-missing" };
      if (outcome.state === "circuit-open") {
        return { state: "circuit-open", retryAfterSeconds: outcome.retryAfterSeconds };
      }
      if (outcome.state === "disabled") {
        return { state: "provider-unconfigured", provider: "espn" };
      }
      return { state: "external-companion-required", provider: "espn" };
    }

    const connectionId = job.connectionId;
    if (!connectionId) return { state: "target-missing" };

    // One query joining the league season to its connection, filtered on both ids. A job naming a
    // connection that does not own the league season therefore finds nothing and resolves, rather
    // than syncing a league the connection has no claim to.
    const target = await this.#targets.findSyncTarget({
      connectionId,
      leagueSeasonId: job.leagueSeasonId,
    });
    if (!target) return { state: "target-missing" };

    // Derived from the existing capability objects: a connection whose credential mode is not
    // server-refreshable cannot be refreshed here, and pretending otherwise would either fetch
    // without authorization or dead-letter a job that can never succeed.
    if (!providerSupportsServerRefresh(target.provider)) {
      return { state: "external-companion-required", provider: target.provider };
    }

    if (target.connectionHealth === "reauthorize" || target.connectionHealth === "disabled") {
      // Terminal, not retryable: no amount of backoff produces a valid credential.
      return { state: "reauthorization-required", connectionId };
    }

    const circuit = evaluateConnectionCircuit({
      consecutiveFailures: target.consecutiveFailures,
      circuitOpenUntil: target.circuitOpenUntil,
      now: this.#now(),
    });
    if (circuit.state === "open") {
      return { state: "circuit-open", retryAfterSeconds: circuit.retryAfterSeconds ?? 0 };
    }

    if (!this.#yahooSync) {
      // A deployment without Yahoo credentials configured is a stated no-op, not a fault.
      return { state: "provider-unconfigured", provider: target.provider };
    }

    let receipt;
    try {
      receipt = await this.#yahooSync.syncLeague(target.userId, connectionId, target.externalKey);
    } catch (error) {
      await this.#circuit.recordFailure({
        connectionId,
        at: this.#now(),
        errorCode: failureCode(error),
        errorDetail: failureDetail(error),
      });
      // Rethrown so pg-boss consumes one of `league-sync`'s five retries with exponential backoff
      // and, once exhausted, lands the job in `league-sync-dead-letter`.
      throw error;
    }

    abortIfCancelled(context);
    await this.#circuit.recordSuccess(connectionId, this.#now());
    return receipt.state === "accepted"
      ? {
          state: "synced",
          recordsWritten: receipt.recordsWritten,
          syncRunId: receipt.syncRunId,
        }
      : { state: "unchanged", syncRunId: receipt.syncRunId };
  }
}

/** Resolves the sync target with one authorized join. */
export class DrizzleLeagueSyncTargetReader implements LeagueSyncTargetReader {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findSyncTarget(input: {
    readonly connectionId: string;
    readonly leagueSeasonId: string;
  }): Promise<LeagueSyncTarget | undefined> {
    const [row] = await this.#database
      .select({
        userId: providerConnections.userId,
        provider: leagueSeasons.provider,
        externalKey: leagueSeasons.externalKey,
        connectionHealth: providerConnections.health,
        consecutiveFailures: providerConnections.consecutiveFailures,
        circuitOpenUntil: providerConnections.circuitOpenUntil,
      })
      .from(leagueSeasons)
      .innerJoin(providerConnections, eq(providerConnections.id, leagueSeasons.connectionId))
      .where(
        and(
          eq(leagueSeasons.id, input.leagueSeasonId),
          eq(leagueSeasons.connectionId, input.connectionId),
        ),
      )
      .limit(1);
    return row;
  }
}

/**
 * Writes circuit state to the one `provider_connections` row. Nothing else reads these columns, so
 * an open circuit cannot reach another connection, another provider, another league's analysis, or
 * the `recommendation-recompute` queue.
 */
export class DrizzleConnectionCircuitStore implements ConnectionCircuitStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async recordSuccess(connectionId: string, at: Date): Promise<void> {
    await this.#database
      .update(providerConnections)
      .set({
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastSuccessfulAt: at,
        lastErrorCode: null,
        lastErrorDetail: null,
        // A connection that just synced is healthy again. `degraded` is otherwise a one-way door:
        // its only other writer sets it on the first error and never clears it.
        health: "healthy",
        updatedAt: at,
      })
      .where(eq(providerConnections.id, connectionId));
  }

  async recordFailure(input: {
    readonly connectionId: string;
    readonly at: Date;
    readonly errorCode: string;
    readonly errorDetail: string;
  }): Promise<{ readonly state: "closed" | "open"; readonly consecutiveFailures: number }> {
    // Incremented in the statement so two workers failing the same connection cannot both read the
    // same prior count and lose one failure.
    const [row] = await this.#database
      .update(providerConnections)
      .set({
        consecutiveFailures: sql`${providerConnections.consecutiveFailures} + 1`,
        lastErrorAt: input.at,
        lastErrorCode: input.errorCode,
        lastErrorDetail: input.errorDetail,
        health: "degraded",
        updatedAt: input.at,
      })
      .where(eq(providerConnections.id, input.connectionId))
      .returning({ consecutiveFailures: providerConnections.consecutiveFailures });
    const consecutiveFailures = row?.consecutiveFailures ?? 0;
    const openUntil = nextCircuitOpenUntil({ consecutiveFailures, now: input.at });
    if (openUntil) {
      await this.#database
        .update(providerConnections)
        .set({ circuitOpenUntil: openUntil })
        .where(eq(providerConnections.id, input.connectionId));
    }
    return {
      state: consecutiveFailures >= CONNECTION_CIRCUIT_FAILURE_THRESHOLD ? "open" : "closed",
      consecutiveFailures,
    };
  }
}
