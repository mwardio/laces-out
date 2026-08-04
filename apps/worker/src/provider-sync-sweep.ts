import {
  espnLeagueSyncStates,
  leagueSeasons,
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

const MAX_DUE_LEAGUES_PER_SWEEP = 100;

export interface ProviderSyncSweepTarget {
  readonly leagueSeasonId: string;
  readonly directCoreState: EspnDirectCapabilityState;
}

export interface ProviderSyncSweepTargetReader {
  expireRequests(now: Date): Promise<number>;
  listDue(now: Date, limit: number): Promise<readonly ProviderSyncSweepTarget[]>;
}

export class ProviderSyncSweepService implements ProviderSyncSweepServicePort {
  readonly #enabled: boolean;
  readonly #targets: ProviderSyncSweepTargetReader;
  readonly #enqueue: (job: LeagueSyncJob) => Promise<string | null>;
  readonly #now: () => Date;

  constructor(input: {
    readonly enabled: boolean;
    readonly targets: ProviderSyncSweepTargetReader;
    readonly enqueue: (job: LeagueSyncJob) => Promise<string | null>;
    readonly now?: () => Date;
  }) {
    this.#enabled = input.enabled;
    this.#targets = input.targets;
    this.#enqueue = input.enqueue;
    this.#now = input.now ?? (() => new Date());
  }

  async sweepProviderSync(
    _job: ProviderSyncSweepJob,
    context: WorkerJobContext,
  ): Promise<ProviderSyncSweepResult> {
    if (context.signal.aborted) throw new Error("Provider sync sweep was aborted during shutdown");
    const now = this.#now();
    const expired = await this.#targets.expireRequests(now);
    if (!this.#enabled) return { expired, considered: 0, enqueued: 0 };
    const targets = await this.#targets.listDue(now, MAX_DUE_LEAGUES_PER_SWEEP);
    let enqueued = 0;
    for (const target of targets) {
      if (context.signal.aborted)
        throw new Error("Provider sync sweep was aborted during shutdown");
      const jobId = await this.#enqueue({
        mode: "server-direct",
        leagueSeasonId: target.leagueSeasonId,
        reason: "provider-sweep",
        probe: target.directCoreState === "unknown" || target.directCoreState === "not-public",
      });
      if (jobId !== null) enqueued += 1;
    }
    return { expired, considered: targets.length, enqueued };
  }
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

  async listDue(now: Date, limit: number): Promise<readonly ProviderSyncSweepTarget[]> {
    return this.#database
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
  }
}
