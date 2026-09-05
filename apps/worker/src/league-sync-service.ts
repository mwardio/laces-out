import {
  CONNECTION_CIRCUIT_FAILURE_THRESHOLD,
  evaluateConnectionCircuit,
  nextCircuitOpenUntil,
  connectionSupportsServerRefresh,
  EspnSessionSyncError,
  type EspnDirectSyncPort,
  type EspnSessionSyncPort,
  type EspnSessionSyncReceipt,
  YahooSyncError,
  type YahooSyncPort,
  type YahooSyncReceipt,
} from "@laces-out/league-sync";
import {
  leagueMemberships,
  leagues,
  leagueSeasons,
  espnRefreshAttempts,
  providerConnections,
  providerLeagueLinks,
  refreshRequests,
  type ConnectionHealth,
  type Database,
  type ProviderName,
} from "@laces-out/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

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
  | { readonly state: "provider-rejected"; readonly provider: "espn"; readonly errorCode: string }
  | { readonly state: "target-missing" };

export interface LeagueSyncTarget {
  readonly userId: string;
  readonly provider: ProviderName;
  readonly externalKey: string;
  readonly connectionCapabilities: unknown;
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
  recordSuccess(input: {
    readonly provider: "yahoo" | "espn";
    readonly connectionId: string;
    readonly leagueSeasonId: string;
    readonly at: Date;
  }): Promise<void>;
  recordFailure(input: {
    readonly provider: "yahoo" | "espn";
    readonly connectionId: string;
    readonly leagueSeasonId: string;
    readonly at: Date;
    readonly errorCode: string;
    readonly errorDetail: string;
  }): Promise<{ readonly state: "closed" | "open"; readonly consecutiveFailures: number }>;
}

export interface EspnSessionAttemptStore {
  recordStarted(input: {
    readonly refreshRequestId: string;
    readonly leagueSeasonId: string;
    readonly at: Date;
  }): Promise<void>;
  recordFailure(input: {
    readonly refreshRequestId: string;
    readonly leagueSeasonId: string;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly retryable: boolean;
    readonly at: Date;
  }): Promise<void>;
}

export type LeagueSyncOperationalEvent =
  | {
      readonly event: "circuit-cooldown";
      readonly provider: "yahoo" | "espn";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
      readonly retryAfterSeconds: number;
    }
  | {
      readonly event: "reauthorization-required";
      readonly provider: "yahoo" | "espn";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
    }
  | {
      readonly event: "sync-failed";
      readonly provider: "yahoo" | "espn";
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
      readonly provider: "yahoo" | "espn";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
      readonly state: "accepted" | "unchanged";
      readonly recordsWritten: number;
    }
  | {
      readonly event: "after-commit-failed";
      readonly provider: "yahoo" | "espn";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
    }
  | {
      readonly event: "circuit-success-failed";
      readonly provider: "yahoo" | "espn";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
    }
  | {
      readonly event: "refresh-attempt-bookkeeping-failed";
      readonly provider: "espn";
      readonly connectionId: string;
      readonly leagueSeasonId: string;
      readonly phase: "started" | "failed";
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
  readonly #espnSessionSync: EspnSessionSyncPort | undefined;
  readonly #espnDirect: EspnDirectSyncPort | undefined;
  readonly #circuit: ConnectionCircuitStore;
  readonly #espnSessionAttempts: EspnSessionAttemptStore | undefined;
  readonly #afterYahooCommit: ((receipt: YahooSyncReceipt) => Promise<void>) | undefined;
  readonly #afterEspnCommit: ((receipt: EspnSessionSyncReceipt) => Promise<void>) | undefined;
  readonly #observe: ((event: LeagueSyncOperationalEvent) => void) | undefined;
  readonly #now: () => Date;

  constructor(input: {
    readonly targets: LeagueSyncTargetReader;
    readonly yahooSync?: YahooSyncPort;
    readonly espnSessionSync?: EspnSessionSyncPort;
    readonly espnDirect?: EspnDirectSyncPort;
    readonly circuit: ConnectionCircuitStore;
    readonly espnSessionAttempts?: EspnSessionAttemptStore;
    readonly afterYahooCommit?: (receipt: YahooSyncReceipt) => Promise<void>;
    readonly afterEspnCommit?: (receipt: EspnSessionSyncReceipt) => Promise<void>;
    readonly observe?: (event: LeagueSyncOperationalEvent) => void;
    readonly now?: () => Date;
  }) {
    this.#targets = input.targets;
    this.#yahooSync = input.yahooSync;
    this.#espnSessionSync = input.espnSessionSync;
    this.#espnDirect = input.espnDirect;
    this.#circuit = input.circuit;
    this.#espnSessionAttempts = input.espnSessionAttempts;
    this.#afterYahooCommit = input.afterYahooCommit;
    this.#afterEspnCommit = input.afterEspnCommit;
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
    if (!connectionSupportsServerRefresh(target.provider, target.connectionCapabilities)) {
      return { state: "external-companion-required", provider: target.provider };
    }

    if (target.connectionHealth === "reauthorize" || target.connectionHealth === "disabled") {
      if (target.provider === "espn" && job.refreshRequestId && this.#espnSessionAttempts) {
        try {
          await this.#espnSessionAttempts.recordFailure({
            refreshRequestId: job.refreshRequestId,
            leagueSeasonId: job.leagueSeasonId,
            errorCode:
              target.connectionHealth === "reauthorize"
                ? "REAUTHORIZATION_REQUIRED"
                : "CONNECTION_DISABLED",
            errorDetail:
              target.connectionHealth === "reauthorize"
                ? "ESPN sign-in must be renewed."
                : "Always-on ESPN sync is disabled.",
            retryable: false,
            at: this.#now(),
          });
        } catch {
          this.#emit({
            event: "refresh-attempt-bookkeeping-failed",
            provider: "espn",
            connectionId,
            leagueSeasonId: job.leagueSeasonId,
            phase: "failed",
          });
        }
      }
      // Terminal, not retryable: no amount of backoff produces a valid credential.
      this.#emit({
        event: "reauthorization-required",
        provider: target.provider === "espn" ? "espn" : "yahoo",
        connectionId,
        leagueSeasonId: job.leagueSeasonId,
      });
      return { state: "reauthorization-required", connectionId };
    }

    const circuit = evaluateConnectionCircuit({
      consecutiveFailures: target.consecutiveFailures,
      circuitOpenUntil: target.circuitOpenUntil,
      now: this.#now(),
    });
    if (circuit.state === "open") {
      if (target.provider === "espn" && job.refreshRequestId && this.#espnSessionAttempts) {
        try {
          await this.#espnSessionAttempts.recordFailure({
            refreshRequestId: job.refreshRequestId,
            leagueSeasonId: job.leagueSeasonId,
            errorCode: "CIRCUIT_COOLDOWN",
            errorDetail: "Automatic ESPN refresh is cooling down before its next retry.",
            retryable: true,
            at: this.#now(),
          });
        } catch {
          this.#emit({
            event: "refresh-attempt-bookkeeping-failed",
            provider: "espn",
            connectionId,
            leagueSeasonId: job.leagueSeasonId,
            phase: "failed",
          });
        }
      }
      this.#emit({
        event: "circuit-cooldown",
        provider: target.provider === "espn" ? "espn" : "yahoo",
        connectionId,
        leagueSeasonId: job.leagueSeasonId,
        retryAfterSeconds: circuit.retryAfterSeconds ?? 0,
      });
      return { state: "circuit-open", retryAfterSeconds: circuit.retryAfterSeconds ?? 0 };
    }

    const providerSync =
      target.provider === "yahoo"
        ? this.#yahooSync
        : target.provider === "espn"
          ? this.#espnSessionSync
          : undefined;
    if (!providerSync) {
      return { state: "provider-unconfigured", provider: target.provider };
    }

    let receipt: YahooSyncReceipt | EspnSessionSyncReceipt;
    if (target.provider === "espn" && job.refreshRequestId && this.#espnSessionAttempts) {
      try {
        await this.#espnSessionAttempts.recordStarted({
          refreshRequestId: job.refreshRequestId,
          leagueSeasonId: job.leagueSeasonId,
          at: this.#now(),
        });
      } catch {
        this.#emit({
          event: "refresh-attempt-bookkeeping-failed",
          provider: "espn",
          connectionId,
          leagueSeasonId: job.leagueSeasonId,
          phase: "started",
        });
      }
    }
    try {
      receipt =
        target.provider === "espn"
          ? job.reason === "identity-bootstrap"
            ? await (providerSync as EspnSessionSyncPort).syncIdentity(
                target.userId,
                connectionId,
                job.leagueSeasonId,
                context.signal,
              )
            : await (providerSync as EspnSessionSyncPort).syncLeague(
                target.userId,
                connectionId,
                job.leagueSeasonId,
                context.signal,
              )
          : await (providerSync as YahooSyncPort).syncLeague(
              target.userId,
              connectionId,
              target.externalKey,
            );
    } catch (error) {
      // Caller cancellation is queue shutdown control flow, not a provider/circuit failure. Internal
      // provider timeouts do not abort this signal and retain their retryable failure behavior.
      abortIfCancelled(context);
      const errorCode = failureCode(error);
      const errorDetail = failureDetail(error);
      const reauthorizationRequired =
        target.provider === "espn" && errorCode === "REAUTHORIZATION_REQUIRED";
      if (target.provider === "espn" && job.refreshRequestId && this.#espnSessionAttempts) {
        try {
          await this.#espnSessionAttempts.recordFailure({
            refreshRequestId: job.refreshRequestId,
            leagueSeasonId: job.leagueSeasonId,
            errorCode,
            errorDetail,
            retryable:
              !reauthorizationRequired && error instanceof EspnSessionSyncError && error.retryable,
            at: this.#now(),
          });
        } catch {
          this.#emit({
            event: "refresh-attempt-bookkeeping-failed",
            provider: "espn",
            connectionId,
            leagueSeasonId: job.leagueSeasonId,
            phase: "failed",
          });
        }
      }
      if (reauthorizationRequired) {
        this.#emit({
          event: "reauthorization-required",
          provider: "espn",
          connectionId,
          leagueSeasonId: job.leagueSeasonId,
        });
        return { state: "reauthorization-required", connectionId };
      }
      const yahooCircuitAlreadyOpened =
        target.provider === "yahoo" && error instanceof YahooSyncError && error.cooldown;
      // YahooSyncService reports `cooldown` only after it has durably opened or observed the shared
      // connection circuit. Writing the generic failure too would immediately change health to
      // `degraded`, excluding the connection after expiry and preventing sync/draft self-healing.
      const circuitFailure = yahooCircuitAlreadyOpened
        ? { state: "open" as const, consecutiveFailures: target.consecutiveFailures }
        : await this.#circuit.recordFailure({
            provider: target.provider === "espn" ? "espn" : "yahoo",
            connectionId,
            leagueSeasonId: job.leagueSeasonId,
            at: this.#now(),
            errorCode,
            errorDetail,
          });
      this.#emit({
        event: "sync-failed",
        provider: target.provider === "espn" ? "espn" : "yahoo",
        connectionId,
        leagueSeasonId: job.leagueSeasonId,
        errorCode,
        throttled: error instanceof YahooSyncError && error.throttled,
        retryAfterSeconds:
          error instanceof YahooSyncError && error.retryAfterMs !== null
            ? Math.ceil(error.retryAfterMs / 1_000)
            : null,
        circuitState: circuitFailure.state,
        consecutiveFailures: circuitFailure.consecutiveFailures,
      });
      if (target.provider === "espn" && error instanceof EspnSessionSyncError && !error.retryable) {
        return { state: "provider-rejected", provider: "espn", errorCode: error.code };
      }
      // Rethrown so pg-boss consumes one of `league-sync`'s five retries with exponential backoff
      // and, once exhausted, lands the job in `league-sync-dead-letter`.
      throw error;
    }

    // Receipt resolution is the durable no-cancel boundary. Run the durable follow-up before
    // noncritical circuit bookkeeping so a bookkeeping outage cannot strand recomputation.
    const espnReceipt =
      target.provider === "espn" ? (receipt as EspnSessionSyncReceipt) : undefined;
    if (receipt.state === "accepted" || espnReceipt?.identityChanged === true) {
      try {
        if (target.provider === "espn") {
          await this.#afterEspnCommit?.(receipt as EspnSessionSyncReceipt);
        } else {
          await this.#afterYahooCommit?.(receipt);
        }
      } catch {
        // A committed provider artifact must not be retried because downstream notification or
        // queue infrastructure failed. Retrying would turn the same artifact into `unchanged` and
        // still not repair that downstream system.
        this.#emit({
          event: "after-commit-failed",
          provider: target.provider === "espn" ? "espn" : "yahoo",
          connectionId,
          leagueSeasonId: receipt.leagueSeasonId,
        });
      }
    }
    try {
      await this.#circuit.recordSuccess({
        provider: target.provider === "espn" ? "espn" : "yahoo",
        connectionId,
        leagueSeasonId: job.leagueSeasonId,
        at: this.#now(),
      });
    } catch {
      // A committed provider artifact must not be retried for circuit bookkeeping. The event is
      // intentionally closed and never includes the thrown error or credential material.
      this.#emit({
        event: "circuit-success-failed",
        provider: target.provider === "espn" ? "espn" : "yahoo",
        connectionId,
        leagueSeasonId: receipt.leagueSeasonId,
      });
    }
    this.#emit({
      event: "sync-completed",
      provider: target.provider === "espn" ? "espn" : "yahoo",
      connectionId,
      leagueSeasonId: receipt.leagueSeasonId,
      state: receipt.state,
      recordsWritten: receipt.recordsWritten,
    });
    if (espnReceipt?.reauthorizationRequired === true) {
      this.#emit({
        event: "reauthorization-required",
        provider: "espn",
        connectionId,
        leagueSeasonId: job.leagueSeasonId,
      });
      return { state: "reauthorization-required", connectionId };
    }
    if (
      target.provider === "espn" &&
      job.refreshRequestId &&
      this.#espnSessionAttempts &&
      espnReceipt?.supplementalFailures.length
    ) {
      const failure =
        espnReceipt.supplementalFailures.find((candidate) => !candidate.retryable) ??
        espnReceipt.supplementalFailures[0]!;
      try {
        await this.#espnSessionAttempts.recordFailure({
          refreshRequestId: job.refreshRequestId,
          leagueSeasonId: job.leagueSeasonId,
          errorCode: failure.code,
          errorDetail:
            failure.kind === null
              ? "One or more ESPN supplemental reads did not complete."
              : `The ${failure.kind} ESPN artifact did not complete.`,
          // This queue job has already committed its valid artifacts and will be acknowledged.
          // Scheduled provider sweeps still retry the failed artifact, but this member request is
          // no longer actively running and must not remain `processing` for its full 24-hour TTL.
          retryable: false,
          at: this.#now(),
        });
      } catch {
        this.#emit({
          event: "refresh-attempt-bookkeeping-failed",
          provider: "espn",
          connectionId,
          leagueSeasonId: job.leagueSeasonId,
          phase: "failed",
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

/** Durable status for member-triggered always-on refreshes; provider sweeps need no attempt row. */
export class DrizzleEspnSessionAttemptStore implements EspnSessionAttemptStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async recordStarted(input: {
    readonly refreshRequestId: string;
    readonly leagueSeasonId: string;
    readonly at: Date;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [request] = await transaction
        .select({ id: refreshRequests.id })
        .from(refreshRequests)
        .where(
          and(
            eq(refreshRequests.id, input.refreshRequestId),
            eq(refreshRequests.leagueSeasonId, input.leagueSeasonId),
            eq(refreshRequests.kind, "league"),
            inArray(refreshRequests.state, ["queued", "processing"]),
          ),
        )
        .limit(1);
      if (!request) return;
      await transaction.insert(espnRefreshAttempts).values({
        refreshRequestId: request.id,
        mode: "server-session",
        state: "started",
        startedAt: input.at,
      });
      await transaction
        .update(refreshRequests)
        .set({
          state: "processing",
          fulfillmentMode: "server-session",
          startedAt: sql`coalesce(${refreshRequests.startedAt}, ${input.at.toISOString()}::timestamptz)`,
        })
        .where(eq(refreshRequests.id, request.id));
    });
  }

  async recordFailure(input: {
    readonly refreshRequestId: string;
    readonly leagueSeasonId: string;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly retryable: boolean;
    readonly at: Date;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [request] = await transaction
        .select({ id: refreshRequests.id, state: refreshRequests.state })
        .from(refreshRequests)
        .where(
          and(
            eq(refreshRequests.id, input.refreshRequestId),
            eq(refreshRequests.leagueSeasonId, input.leagueSeasonId),
            eq(refreshRequests.kind, "league"),
            inArray(refreshRequests.state, ["queued", "processing"]),
          ),
        )
        .limit(1);
      if (!request) return;
      const state = input.retryable ? "retryable-error" : "rejected";
      const completed = await transaction
        .update(espnRefreshAttempts)
        .set({
          state,
          errorCode: input.errorCode.slice(0, 64),
          errorDetail: input.errorDetail.slice(0, 500),
          finishedAt: input.at,
        })
        .where(
          and(
            eq(espnRefreshAttempts.refreshRequestId, request.id),
            eq(espnRefreshAttempts.mode, "server-session"),
            isNull(espnRefreshAttempts.bridgeDeviceId),
            inArray(espnRefreshAttempts.state, ["offered", "started"]),
          ),
        )
        .returning({ id: espnRefreshAttempts.id });
      if (completed.length === 0) {
        await transaction.insert(espnRefreshAttempts).values({
          refreshRequestId: request.id,
          mode: "server-session",
          state,
          errorCode: input.errorCode.slice(0, 64),
          errorDetail: input.errorDetail.slice(0, 500),
          startedAt: input.at,
          finishedAt: input.at,
        });
      }
      if (!input.retryable) {
        await transaction
          .update(refreshRequests)
          .set({
            state: "failed",
            fulfillmentMode: "server-session",
            startedAt: sql`coalesce(${refreshRequests.startedAt}, ${input.at.toISOString()}::timestamptz)`,
            finishedAt: input.at,
            errorCode: input.errorCode.slice(0, 64),
            errorDetail: input.errorDetail.slice(0, 500),
          })
          .where(eq(refreshRequests.id, request.id));
      }
    });
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
        connectionCapabilities: providerConnections.capabilities,
        connectionHealth: providerConnections.health,
        connectionConsecutiveFailures: providerConnections.consecutiveFailures,
        connectionCircuitOpenUntil: providerConnections.circuitOpenUntil,
        leagueConsecutiveFailures: providerLeagueLinks.consecutiveFailures,
        leagueCircuitOpenUntil: providerLeagueLinks.circuitOpenUntil,
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
    if (!row) return undefined;
    return {
      userId: row.userId,
      provider: row.provider,
      externalKey: row.externalKey,
      connectionCapabilities: row.connectionCapabilities,
      connectionHealth: row.connectionHealth,
      consecutiveFailures:
        row.provider === "espn" ? row.leagueConsecutiveFailures : row.connectionConsecutiveFailures,
      circuitOpenUntil:
        row.provider === "espn" ? row.leagueCircuitOpenUntil : row.connectionCircuitOpenUntil,
    };
  }
}

/**
 * Yahoo OAuth failures remain connection-scoped. ESPN session reads are league-scoped because one
 * league can legitimately expose a provider shape that another league on the same login does not.
 * This keeps a malformed ESPN roster from pausing unrelated leagues while preserving backoff.
 */
export class DrizzleConnectionCircuitStore implements ConnectionCircuitStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async recordSuccess(input: {
    readonly provider: "yahoo" | "espn";
    readonly connectionId: string;
    readonly leagueSeasonId: string;
    readonly at: Date;
  }): Promise<void> {
    if (input.provider === "espn") {
      await this.#database
        .update(providerLeagueLinks)
        .set({
          consecutiveFailures: 0,
          circuitOpenUntil: null,
          lastErrorCode: null,
          lastErrorAt: null,
          lastErrorDetail: null,
          updatedAt: input.at,
        })
        .where(
          and(
            eq(providerLeagueLinks.connectionId, input.connectionId),
            eq(providerLeagueLinks.leagueSeasonId, input.leagueSeasonId),
          ),
        );
    }
    await this.#database
      .update(providerConnections)
      .set({
        // Also clear legacy ESPN connection-wide cooldowns written by pre-league-scoped workers.
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastSuccessfulAt: input.at,
        lastErrorCode: sql<string | null>`case
          when ${providerConnections.health} in ('reauthorize', 'disabled')
            then ${providerConnections.lastErrorCode}
          else null
        end`,
        lastErrorDetail: sql<string | null>`case
          when ${providerConnections.health} in ('reauthorize', 'disabled')
            then ${providerConnections.lastErrorDetail}
          else null
        end`,
        // A successful durable receipt clears circuit degradation, but cannot undo a terminal
        // reauthorization/disabled decision made by the credential boundary during the same sync.
        health: sql<ConnectionHealth>`case
          when ${providerConnections.health} in ('reauthorize', 'disabled')
            then ${providerConnections.health}
          else 'healthy'
        end`,
        updatedAt: input.at,
      })
      .where(eq(providerConnections.id, input.connectionId));
  }

  async recordFailure(input: {
    readonly provider: "yahoo" | "espn";
    readonly connectionId: string;
    readonly leagueSeasonId: string;
    readonly at: Date;
    readonly errorCode: string;
    readonly errorDetail: string;
  }): Promise<{ readonly state: "closed" | "open"; readonly consecutiveFailures: number }> {
    // Incremented in the statement so two workers failing the same circuit target cannot both read
    // the same prior count and lose one failure.
    const [row] =
      input.provider === "espn"
        ? await this.#database
            .update(providerLeagueLinks)
            .set({
              consecutiveFailures: sql`${providerLeagueLinks.consecutiveFailures} + 1`,
              lastErrorAt: input.at,
              lastErrorCode: input.errorCode,
              lastErrorDetail: input.errorDetail,
              updatedAt: input.at,
            })
            .where(
              and(
                eq(providerLeagueLinks.connectionId, input.connectionId),
                eq(providerLeagueLinks.leagueSeasonId, input.leagueSeasonId),
              ),
            )
            .returning({ consecutiveFailures: providerLeagueLinks.consecutiveFailures })
        : await this.#database
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
    if (!row) throw new Error("Provider sync circuit target disappeared");
    const consecutiveFailures = row?.consecutiveFailures ?? 0;
    const openUntil = nextCircuitOpenUntil({ consecutiveFailures, now: input.at });
    if (openUntil) {
      if (input.provider === "espn") {
        await this.#database
          .update(providerLeagueLinks)
          .set({ circuitOpenUntil: openUntil })
          .where(
            and(
              eq(providerLeagueLinks.connectionId, input.connectionId),
              eq(providerLeagueLinks.leagueSeasonId, input.leagueSeasonId),
            ),
          );
      } else {
        await this.#database
          .update(providerConnections)
          .set({ circuitOpenUntil: openUntil })
          .where(eq(providerConnections.id, input.connectionId));
      }
    }
    return {
      state: consecutiveFailures >= CONNECTION_CIRCUIT_FAILURE_THRESHOLD ? "open" : "closed",
      consecutiveFailures,
    };
  }
}
