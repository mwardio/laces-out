import {
  CONNECTION_CIRCUIT_FAILURE_THRESHOLD,
  evaluateConnectionCircuit,
  nextCircuitOpenUntil,
  providerSupportsServerRefresh,
  type EspnDirectSyncPort,
  YahooSyncError,
  type YahooSyncPort,
  type YahooSyncReceipt,
} from "@fantasy/league-sync";
import {
  leagueMemberships,
  leagues,
  leagueSeasons,
  providerConnections,
  providerLeagueLinks,
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

export type LeagueSyncOperationalEvent =
  | {
      readonly event: "circuit-cooldown";
      readonly provider: "yahoo";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
      readonly retryAfterSeconds: number;
    }
  | {
      readonly event: "reauthorization-required";
      readonly provider: "yahoo";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
    }
  | {
      readonly event: "sync-failed";
      readonly provider: "yahoo";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
      readonly errorCode: string;
      readonly throttled: boolean;
      readonly retryAfterSeconds: number | null;
      readonly circuitState: "closed" | "open";
      readonly consecutiveFailures: number;
    }
  | {
      readonly event: "sync-completed";
      readonly provider: "yahoo";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
      readonly state: "accepted" | "unchanged";
      readonly recordsWritten: number;
    }
  | {
      readonly event: "after-commit-failed";
      readonly provider: "yahoo";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
    };

function abortIfCancelled(context: WorkerJobContext): void {
  if (context.signal.aborted) throw new Error("League sync was aborted during shutdown");
}

function failureCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(code)) return code;
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
  readonly #afterYahooCommit: ((receipt: YahooSyncReceipt) => Promise<void>) | undefined;
  readonly #observe: ((event: LeagueSyncOperationalEvent) => void) | undefined;
  readonly #now: () => Date;

  constructor(input: {
    readonly targets: LeagueSyncTargetReader;
    readonly yahooSync?: YahooSyncPort;
    readonly espnDirect?: EspnDirectSyncPort;
    readonly circuit: ConnectionCircuitStore;
    readonly afterYahooCommit?: (receipt: YahooSyncReceipt) => Promise<void>;
    readonly observe?: (event: LeagueSyncOperationalEvent) => void;
    readonly now?: () => Date;
  }) {
    this.#targets = input.targets;
    this.#yahooSync = input.yahooSync;
    this.#espnDirect = input.espnDirect;
    this.#circuit = input.circuit;
    this.#afterYahooCommit = input.afterYahooCommit;
    this.#observe = input.observe;
    this.#now = input.now ?? (() => new Date());
  }

  #emit(event: LeagueSyncOperationalEvent): void {
    // Operational visibility must never change queue acknowledgement or retry behavior.
    try {
      this.#observe?.(event);
    } catch {
      // The event vocabulary contains only internal ids, closed codes, counts, and durations.
    }
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
      if (target.provider === "yahoo") {
        this.#emit({
          event: "reauthorization-required",
          provider: "yahoo",
          connectionId,
          leagueSeasonId: job.leagueSeasonId,
        });
      }
      return { state: "reauthorization-required", connectionId };
    }

    const circuit = evaluateConnectionCircuit({
      consecutiveFailures: target.consecutiveFailures,
      circuitOpenUntil: target.circuitOpenUntil,
      now: this.#now(),
    });
    if (circuit.state === "open") {
      if (target.provider === "yahoo") {
        this.#emit({
          event: "circuit-cooldown",
          provider: "yahoo",
          connectionId,
          leagueSeasonId: job.leagueSeasonId,
          retryAfterSeconds: circuit.retryAfterSeconds ?? 0,
        });
      }
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
      const circuitFailure = await this.#circuit.recordFailure({
        connectionId,
        at: this.#now(),
        errorCode: failureCode(error),
        errorDetail: failureDetail(error),
      });
      this.#emit({
        event: "sync-failed",
        provider: "yahoo",
        connectionId,
        leagueSeasonId: job.leagueSeasonId,
        errorCode: failureCode(error),
        throttled: error instanceof YahooSyncError && error.throttled,
        retryAfterSeconds:
          error instanceof YahooSyncError && error.retryAfterMs !== null
            ? Math.ceil(error.retryAfterMs / 1_000)
            : null,
        circuitState: circuitFailure.state,
        consecutiveFailures: circuitFailure.consecutiveFailures,
      });
      // Rethrown so pg-boss consumes one of `league-sync`'s five retries with exponential backoff
      // and, once exhausted, lands the job in `league-sync-dead-letter`.
      throw error;
    }

    abortIfCancelled(context);
    await this.#circuit.recordSuccess(connectionId, this.#now());
    this.#emit({
      event: "sync-completed",
      provider: "yahoo",
      connectionId,
      leagueSeasonId: receipt.leagueSeasonId,
      state: receipt.state,
      recordsWritten: receipt.recordsWritten,
    });
    if (receipt.state === "accepted" && this.#afterYahooCommit) {
      try {
        await this.#afterYahooCommit(receipt);
      } catch {
        // A committed provider artifact must not be retried because downstream notification or
        // queue infrastructure failed. Retrying would turn the same artifact into `unchanged` and
        // still not repair that downstream system.
        this.#emit({
          event: "after-commit-failed",
          provider: "yahoo",
          connectionId,
          leagueSeasonId: receipt.leagueSeasonId,
        });
      }
    }
    return receipt.state === "accepted"
      ? {
          state: "synced",
          recordsWritten: receipt.recordsWritten,
          syncRunId: receipt.syncRunId,
        }
      : { state: "unchanged", syncRunId: receipt.syncRunId };
  }
}

/** Resolves the sync target through exact provider-link provenance and league membership. */
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
      .from(providerLeagueLinks)
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, providerLeagueLinks.leagueSeasonId))
      .innerJoin(providerConnections, eq(providerConnections.id, providerLeagueLinks.connectionId))
      .innerJoin(leagues, eq(leagues.id, leagueSeasons.leagueId))
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagues.id),
          eq(leagueMemberships.userId, providerConnections.userId),
        ),
      )
      .where(
        and(
          eq(leagueSeasons.id, input.leagueSeasonId),
          eq(providerLeagueLinks.connectionId, input.connectionId),
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.provider, leagueSeasons.provider),
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
