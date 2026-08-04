import { createHash } from "node:crypto";

import {
  espnLeagueSyncStates,
  leagueMemberships,
  leagues,
  leagueSeasons,
  providerConnections,
  providerLeagueLinks,
  refreshRequests,
  type Database,
  type EspnDirectCapabilityState,
} from "@fantasy/db";
import type { LeagueSyncJob, ProviderSyncSweepJob } from "@fantasy/jobs";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";

import type {
  ProviderSyncSweepResult,
  ProviderSyncSweepService as ProviderSyncSweepServicePort,
  WorkerJobContext,
} from "./jobs.js";
import { currentNflSeason } from "./nfl-season.js";

const MAX_DUE_LEAGUES_PER_PROVIDER = 100;

export const YAHOO_ACTIVE_SYNC_INTERVAL_MS = 30 * 60 * 1_000;
export const YAHOO_OFFSEASON_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/** Less than one scheduler period, so jitter spreads reads without silently changing cadence. */
export const YAHOO_SYNC_JITTER_WINDOW_MS = 5 * 60 * 1_000;

export interface EspnProviderSyncSweepTarget {
  readonly provider: "espn";
  readonly leagueSeasonId: string;
  readonly directCoreState: EspnDirectCapabilityState;
}

export interface YahooProviderSyncSweepTarget {
  readonly provider: "yahoo";
  readonly leagueSeasonId: string;
  readonly connectionId: string;
  readonly dueAt: Date;
}

export type ProviderSyncSweepTarget = EspnProviderSyncSweepTarget | YahooProviderSyncSweepTarget;

export interface ProviderSyncSweepTargetReader {
  expireRequests(now: Date): Promise<number>;
  listDueEspn(now: Date, limit: number): Promise<readonly EspnProviderSyncSweepTarget[]>;
  listDueYahoo(now: Date, limit: number): Promise<readonly YahooProviderSyncSweepTarget[]>;
}

export type ProviderSyncSweepOperationalEvent =
  | {
      readonly event: "due-targets-selected";
      readonly espn: number;
      readonly yahoo: number;
    }
  | {
      readonly event: "enqueue-result";
      readonly provider: "espn" | "yahoo";
      readonly considered: number;
      readonly enqueued: number;
      readonly deduplicated: number;
    }
  | {
      readonly event: "enqueue-failed";
      readonly provider: "espn" | "yahoo";
      readonly leagueSeasonId: string;
    };

/**
 * Stable traffic spreading only; MD5 is deliberately not used for authentication or secrecy.
 * PostgreSQL has the same built-in digest, keeping policy tests and the due-target query identical.
 */
export function yahooSyncJitterMs(leagueSeasonId: string): number {
  const prefix = createHash("md5").update(leagueSeasonId, "utf8").digest("hex").slice(0, 8);
  return Number.parseInt(prefix, 16) % YAHOO_SYNC_JITTER_WINDOW_MS;
}

export function nextYahooAutomatedSyncAt(input: {
  readonly leagueSeasonId: string;
  readonly season: number;
  readonly status: string;
  readonly archived: boolean;
  readonly lastSyncedAt: Date | null;
  readonly createdAt: Date;
  readonly now: Date;
}): Date | null {
  if (input.archived) return null;
  const activeSeason = currentNflSeason(input.now);
  let intervalMs: number;
  if (input.status === "active" && input.season === activeSeason) {
    intervalMs = YAHOO_ACTIVE_SYNC_INTERVAL_MS;
  } else if (
    (input.status === "preseason" || input.status === "offseason") &&
    input.season >= activeSeason
  ) {
    intervalMs = YAHOO_OFFSEASON_SYNC_INTERVAL_MS;
  } else {
    // Completed, archived, past-season, future-active, and unknown states all fail closed.
    return null;
  }
  const freshness = input.lastSyncedAt ?? input.createdAt;
  return new Date(freshness.getTime() + intervalMs + yahooSyncJitterMs(input.leagueSeasonId));
}

export class ProviderSyncSweepService implements ProviderSyncSweepServicePort {
  readonly #espnEnabled: boolean;
  readonly #yahooEnabled: boolean;
  readonly #targets: ProviderSyncSweepTargetReader;
  readonly #enqueue: (job: LeagueSyncJob) => Promise<string | null>;
  readonly #observe: ((event: ProviderSyncSweepOperationalEvent) => void) | undefined;
  readonly #now: () => Date;

  constructor(input: {
    readonly espnEnabled: boolean;
    readonly yahooEnabled: boolean;
    readonly targets: ProviderSyncSweepTargetReader;
    readonly enqueue: (job: LeagueSyncJob) => Promise<string | null>;
    readonly observe?: (event: ProviderSyncSweepOperationalEvent) => void;
    readonly now?: () => Date;
  }) {
    this.#espnEnabled = input.espnEnabled;
    this.#yahooEnabled = input.yahooEnabled;
    this.#targets = input.targets;
    this.#enqueue = input.enqueue;
    this.#observe = input.observe;
    this.#now = input.now ?? (() => new Date());
  }

  #emit(event: ProviderSyncSweepOperationalEvent): void {
    try {
      this.#observe?.(event);
    } catch {
      // Metrics and logging cannot alter sweep acknowledgement or retry behavior.
    }
  }

  async sweepProviderSync(
    _job: ProviderSyncSweepJob,
    context: WorkerJobContext,
  ): Promise<ProviderSyncSweepResult> {
    if (context.signal.aborted) throw new Error("Provider sync sweep was aborted during shutdown");
    const now = this.#now();
    const expired = await this.#targets.expireRequests(now);
    const [espnTargets, yahooTargets] = await Promise.all([
      this.#espnEnabled
        ? this.#targets.listDueEspn(now, MAX_DUE_LEAGUES_PER_PROVIDER)
        : Promise.resolve([]),
      this.#yahooEnabled
        ? this.#targets.listDueYahoo(now, MAX_DUE_LEAGUES_PER_PROVIDER)
        : Promise.resolve([]),
    ]);
    const targets: readonly ProviderSyncSweepTarget[] = [...espnTargets, ...yahooTargets];
    this.#emit({
      event: "due-targets-selected",
      espn: espnTargets.length,
      yahoo: yahooTargets.length,
    });
    const enqueued = { espn: 0, yahoo: 0 };
    for (const target of targets) {
      if (context.signal.aborted)
        throw new Error("Provider sync sweep was aborted during shutdown");
      let jobId: string | null;
      try {
        jobId = await this.#enqueue(
          target.provider === "espn"
            ? {
                mode: "server-direct",
                leagueSeasonId: target.leagueSeasonId,
                reason: "provider-sweep",
                probe:
                  target.directCoreState === "unknown" || target.directCoreState === "not-public",
              }
            : {
                mode: "connection",
                connectionId: target.connectionId,
                leagueSeasonId: target.leagueSeasonId,
                reason: "provider-sweep",
              },
        );
      } catch (error) {
        this.#emit({
          event: "enqueue-failed",
          provider: target.provider,
          leagueSeasonId: target.leagueSeasonId,
        });
        throw error;
      }
      if (jobId !== null) enqueued[target.provider] += 1;
    }
    for (const provider of ["espn", "yahoo"] as const) {
      const considered = provider === "espn" ? espnTargets.length : yahooTargets.length;
      this.#emit({
        event: "enqueue-result",
        provider,
        considered,
        enqueued: enqueued[provider],
        deduplicated: considered - enqueued[provider],
      });
    }
    return {
      expired,
      considered: targets.length,
      enqueued: enqueued.espn + enqueued.yahoo,
      byProvider: {
        espn: { considered: espnTargets.length, enqueued: enqueued.espn },
        yahoo: { considered: yahooTargets.length, enqueued: enqueued.yahoo },
      },
    };
  }
}

interface YahooDueTargetRow extends Record<string, unknown> {
  readonly leagueSeasonId: string;
  readonly connectionId: string;
  readonly dueAt: Date | string;
}

export class DrizzleProviderSyncSweepTargetReader implements ProviderSyncSweepTargetReader {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async expireRequests(now: Date): Promise<number> {
    const expired = await this.#database
      .update(refreshRequests)
      .set({
        state: "cancelled",
        startedAt: sql`coalesce(${refreshRequests.startedAt}, ${refreshRequests.createdAt})`,
        finishedAt: now,
        errorCode: "EXPIRED",
        errorDetail: "No authorized sync path fulfilled this request before it expired.",
      })
      .where(
        and(
          eq(refreshRequests.kind, "league"),
          inArray(refreshRequests.state, ["queued", "processing"]),
          lte(refreshRequests.expiresAt, now),
        ),
      )
      .returning({ id: refreshRequests.id });
    return expired.length;
  }

  async listDueEspn(now: Date, limit: number): Promise<readonly EspnProviderSyncSweepTarget[]> {
    const targets = await this.#database
      .select({
        leagueSeasonId: espnLeagueSyncStates.leagueSeasonId,
        directCoreState: espnLeagueSyncStates.directCoreState,
      })
      .from(espnLeagueSyncStates)
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, espnLeagueSyncStates.leagueSeasonId))
      .where(
        and(
          eq(leagueSeasons.provider, "espn"),
          ne(espnLeagueSyncStates.preferredMode, "assisted"),
          or(
            inArray(espnLeagueSyncStates.directCoreState, ["available", "degraded"]),
            and(
              eq(espnLeagueSyncStates.preferredMode, "direct"),
              inArray(espnLeagueSyncStates.directCoreState, ["unknown", "not-public"]),
            ),
          ),
          or(isNull(espnLeagueSyncStates.nextProbeAt), lte(espnLeagueSyncStates.nextProbeAt, now)),
          or(
            isNull(espnLeagueSyncStates.circuitOpenUntil),
            lte(espnLeagueSyncStates.circuitOpenUntil, now),
          ),
        ),
      )
      .orderBy(asc(espnLeagueSyncStates.nextProbeAt), asc(espnLeagueSyncStates.leagueSeasonId))
      .limit(limit);
    return targets.map((target) => ({ provider: "espn", ...target }));
  }

  async listDueYahoo(now: Date, limit: number): Promise<readonly YahooProviderSyncSweepTarget[]> {
    const activeSeason = currentNflSeason(now);
    const nowIso = now.toISOString();
    const rows = await this.#database.execute<YahooDueTargetRow>(sql`
      with eligible_connections as (
        select
          ${leagueSeasons.id} as league_season_id,
          ${providerConnections.id} as connection_id,
          ${leagueSeasons.season} as season,
          ${leagueSeasons.status} as status,
          ${leagueSeasons.lastSyncedAt} as last_synced_at,
          ${leagueSeasons.createdAt} as season_created_at,
          row_number() over (
            partition by ${leagueSeasons.id}
            order by
              case when ${providerConnections.id} = ${leagueSeasons.connectionId} then 0 else 1 end,
              ${providerConnections.createdAt},
              ${providerConnections.id}
          ) as connection_rank
        from ${leagueSeasons}
        inner join ${leagues}
          on ${leagues.id} = ${leagueSeasons.leagueId}
        inner join ${providerLeagueLinks}
          on ${providerLeagueLinks.leagueSeasonId} = ${leagueSeasons.id}
        inner join ${providerConnections}
          on ${providerConnections.id} = ${providerLeagueLinks.connectionId}
        inner join ${leagueMemberships}
          on ${leagueMemberships.leagueId} = ${leagues.id}
         and ${leagueMemberships.userId} = ${providerConnections.userId}
        where ${leagueSeasons.provider} = 'yahoo'
          and ${providerConnections.provider} = 'yahoo'
          and ${leagues.archived} = false
          and ${providerConnections.health} = 'healthy'
          and ${providerConnections.encryptedCredential} is not null
          and (
            ${providerConnections.circuitOpenUntil} is null
            or ${providerConnections.circuitOpenUntil} <= ${nowIso}::timestamptz
          )
          and (
            (${leagueSeasons.status} = 'active' and ${leagueSeasons.season} = ${activeSeason})
            or (
              ${leagueSeasons.status} in ('preseason', 'offseason')
              and ${leagueSeasons.season} >= ${activeSeason}
            )
          )
      ), selected_connections as (
        select
          league_season_id,
          connection_id,
          season,
          status,
          last_synced_at,
          season_created_at
        from eligible_connections
        where connection_rank = 1
      ), due_targets as (
        select
          league_season_id,
          connection_id,
          coalesce(last_synced_at, season_created_at)
            + case
                when status = 'active'
                  then ${YAHOO_ACTIVE_SYNC_INTERVAL_MS} * interval '1 millisecond'
                else ${YAHOO_OFFSEASON_SYNC_INTERVAL_MS} * interval '1 millisecond'
              end
            + (
                (('x' || substr(md5(league_season_id::text), 1, 8))::bit(32)::bigint
                  % ${YAHOO_SYNC_JITTER_WINDOW_MS})
                * interval '1 millisecond'
              ) as due_at
        from selected_connections
      )
      select
        league_season_id as "leagueSeasonId",
        connection_id as "connectionId",
        due_at as "dueAt"
      from due_targets
      where due_at <= ${nowIso}::timestamptz
      order by due_at, league_season_id
      limit ${limit}
    `);
    return rows.map((row) => ({
      provider: "yahoo",
      leagueSeasonId: row.leagueSeasonId,
      connectionId: row.connectionId,
      dueAt: row.dueAt instanceof Date ? row.dueAt : new Date(row.dueAt),
    }));
  }
}
