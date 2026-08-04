import type { PgBoss, Queue, SendOptions } from "pg-boss";

/**
 * The single source of pg-boss queue names, reliability settings, payload validation, and dispatch
 * serialization for every process.
 *
 * The API and the worker are separate processes (ADR 0001) and neither may import the other, so
 * before this package existed each hand-copied the queue configuration it needed. That copy drifted:
 * the API's `createQueue` calls omitted the dead-letter target and the retention settings the worker
 * set, so an API-dispatched job silently lost required dead-letter behavior. Nothing here is
 * exported as a raw configuration object—`registerQueues` is the only
 * way to declare a queue, and the `enqueue*` helpers are the only way to produce a singleton key —
 * so a second, different declaration cannot be written without deleting this module.
 */
export const queueNames = {
  syncLeague: "league-sync",
  refreshProjections: "projection-refresh",
  recomputeRecommendations: "recommendation-recompute",
  dataHealth: "data-health-check",
  dataRefresh: "data-refresh",
  notificationSweep: "notification-sweep",
  providerSyncSweep: "provider-sync-sweep",
} as const;

export const deadLetterQueueNames = {
  syncLeague: "league-sync-dead-letter",
  refreshProjections: "projection-refresh-dead-letter",
  recomputeRecommendations: "recommendation-recompute-dead-letter",
  dataHealth: "data-health-check-dead-letter",
  dataRefresh: "data-refresh-dead-letter",
  notificationSweep: "notification-sweep-dead-letter",
  providerSyncSweep: "provider-sync-sweep-dead-letter",
} as const;

export interface LeagueSyncJob {
  /** Omitted by legacy producers; legacy payloads are connection-mode jobs. */
  readonly mode?: "connection" | "server-direct";
  readonly connectionId?: string;
  readonly leagueSeasonId: string;
  readonly reason: "scheduled" | "manual" | "draft" | "stale-on-view" | "provider-sweep";
  readonly refreshRequestId?: string;
  readonly probe?: boolean;
}

export interface ProviderSyncSweepJob {
  readonly requestedAt: string;
}

export interface ProjectionRefreshJob {
  readonly season: number;
  readonly week?: number;
  /** Scheduled jobs re-resolve the active NFL season when they execute across a March rollover. */
  readonly reason?: "scheduled" | "lock-window" | "on-demand";
}

export const recommendationKinds = ["draft", "lineup", "waiver", "trade"] as const;
export type RecommendationKind = (typeof recommendationKinds)[number];

export interface RecommendationJob {
  readonly leagueSeasonId: string;
  readonly kinds: readonly RecommendationKind[];
}

export interface DataHealthJob {
  readonly source: "schedule" | "manual";
  readonly requestedBy?: string;
  readonly requestedAt?: string;
}

export interface DataRefreshJob {
  readonly requestedBy: string;
  readonly scope: "player-data" | "market-data" | "adp-data";
  readonly reason: "daily" | "scheduled" | "user" | "startup-recovery";
  readonly requestedAt: string;
}

/**
 * Outbound notification families. The sweep is generic over the kind so a future notification is a
 * new payload builder and a new value here, not new queue plumbing.
 */
export const notificationSweepKinds = ["lineup-lock", "change-event"] as const;
export type NotificationSweepKind = (typeof notificationSweepKinds)[number];

export interface NotificationSweepJob {
  readonly kind: NotificationSweepKind;
  readonly reason: "scheduled" | "manual";
}

type QueueConfiguration = Omit<Queue, "name" | "partition" | "policy">;

const DAY_SECONDS = 86_400;
/** Full-universe ROS simulations are intentionally allowed more time than ordinary queue work. */
export const SEASON_PROJECTION_REFRESH_EXPIRE_SECONDS = 8 * 60 * 60;
const queueConfigurations: Readonly<Record<keyof typeof queueNames, QueueConfiguration>> = {
  syncLeague: {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 15 * 60,
    expireInSeconds: 15 * 60,
    retentionSeconds: 14 * DAY_SECONDS,
    deleteAfterSeconds: 7 * DAY_SECONDS,
    deadLetter: deadLetterQueueNames.syncLeague,
    warningQueueSize: 20,
  },
  refreshProjections: {
    retryLimit: 4,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 30 * 60,
    expireInSeconds: SEASON_PROJECTION_REFRESH_EXPIRE_SECONDS,
    retentionSeconds: 14 * DAY_SECONDS,
    deleteAfterSeconds: 7 * DAY_SECONDS,
    deadLetter: deadLetterQueueNames.refreshProjections,
    warningQueueSize: 10,
  },
  recomputeRecommendations: {
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 5 * 60,
    expireInSeconds: 15 * 60,
    retentionSeconds: 14 * DAY_SECONDS,
    deleteAfterSeconds: 7 * DAY_SECONDS,
    deadLetter: deadLetterQueueNames.recomputeRecommendations,
    warningQueueSize: 20,
  },
  dataHealth: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 5 * 60,
    expireInSeconds: 5 * 60,
    retentionSeconds: 14 * DAY_SECONDS,
    deleteAfterSeconds: 7 * DAY_SECONDS,
    deadLetter: deadLetterQueueNames.dataHealth,
    warningQueueSize: 5,
  },
  dataRefresh: {
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 60 * 60,
    expireInSeconds: 30 * 60,
    retentionSeconds: 14 * DAY_SECONDS,
    deleteAfterSeconds: 7 * DAY_SECONDS,
    deadLetter: deadLetterQueueNames.dataRefresh,
    warningQueueSize: 10,
  },
  notificationSweep: {
    // A lineup alarm that arrives late is worse than one that never arrives, so the sweep retries
    // briefly and then gives the next quarter-hour tick the job instead.
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 2 * 60,
    expireInSeconds: 5 * 60,
    retentionSeconds: 14 * DAY_SECONDS,
    deleteAfterSeconds: 7 * DAY_SECONDS,
    deadLetter: deadLetterQueueNames.notificationSweep,
    warningQueueSize: 5,
  },
  providerSyncSweep: {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 5 * 60,
    expireInSeconds: 4 * 60,
    retentionSeconds: 14 * DAY_SECONDS,
    deleteAfterSeconds: 7 * DAY_SECONDS,
    deadLetter: deadLetterQueueNames.providerSyncSweep,
    warningQueueSize: 5,
  },
};

const deadLetterConfiguration: QueueConfiguration = {
  retryLimit: 0,
  // pg-boss requires expiration to be strictly less than 24 hours. Dead-letter jobs are retained
  // for 30 days after completion, but any single inspection/replay job must respect that runtime
  // ceiling so queue registration cannot prevent the worker from starting.
  expireInSeconds: 23 * 60 * 60,
  retentionSeconds: 30 * DAY_SECONDS,
  deleteAfterSeconds: 30 * DAY_SECONDS,
  warningQueueSize: 1,
};

/**
 * Queue creation is intentionally followed by an update. pg-boss treats createQueue as a no-op
 * when a queue already exists, while updateQueue applies reliability settings to deployments that
 * predate these contracts.
 */
export async function registerQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(deadLetterQueueNames)) {
    await boss.createQueue(name, deadLetterConfiguration);
    await boss.updateQueue(name, deadLetterConfiguration);
  }

  for (const key of Object.keys(queueNames) as (keyof typeof queueNames)[]) {
    const name = queueNames[key];
    const configuration = queueConfigurations[key];
    await boss.createQueue(name, configuration);
    await boss.updateQueue(name, configuration);
  }
}

function dispatchOptions(
  groupId: string,
  singletonKey: string,
  singletonSeconds: number,
): SendOptions {
  return {
    group: { id: groupId },
    singletonKey,
    singletonSeconds,
  };
}

/** Enqueues a league sync with exact-target deduplication and per-league serialization metadata. */
export function enqueueLeagueSync(boss: PgBoss, job: LeagueSyncJob): Promise<string | null> {
  assertLeagueSyncJob(job);
  const singletonKey =
    job.mode === "server-direct"
      ? `league-sync:server-direct:${job.leagueSeasonId}`
      : job.reason === "provider-sweep"
        ? `league-sync:provider-sweep:${job.leagueSeasonId}`
        : `league-sync:${job.connectionId ?? "missing"}:${job.leagueSeasonId}`;
  return boss.send(
    queueNames.syncLeague,
    job,
    dispatchOptions(`league-season:${job.leagueSeasonId}`, singletonKey, 60),
  );
}

/** Coalesces the cheap capability/due-state selector independently from provider reads. */
export function enqueueProviderSyncSweep(
  boss: PgBoss,
  job: ProviderSyncSweepJob,
): Promise<string | null> {
  assertProviderSyncSweepJob(job);
  return boss.send(
    queueNames.providerSyncSweep,
    job,
    dispatchOptions("provider-sync-sweep", "provider-sync-sweep", 5 * 60),
  );
}

/** Enqueues one projection horizon while preventing concurrent writes for the same season. */
export function enqueueProjectionRefresh(
  boss: PgBoss,
  job: ProjectionRefreshJob,
): Promise<string | null> {
  assertProjectionRefreshJob(job);
  const horizon = job.week === undefined ? "season" : `week-${job.week}`;
  return boss.send(
    queueNames.refreshProjections,
    job,
    dispatchOptions("projections", `projection-refresh:${job.season}:${horizon}`, 5 * 60),
  );
}

/** Deduplicates equivalent work while serializing all recomputations for one league season. */
export function enqueueRecommendationRecompute(
  boss: PgBoss,
  job: RecommendationJob,
): Promise<string | null> {
  assertRecommendationJob(job);
  const kinds = [...new Set(job.kinds)].sort().join(",");
  return boss.send(
    queueNames.recomputeRecommendations,
    job,
    dispatchOptions(
      `league-season:${job.leagueSeasonId}`,
      `recommendations:${job.leagueSeasonId}:${kinds}`,
      30,
    ),
  );
}

/**
 * Coalesces a shared-NFL-data refresh onto the one global key. The group matters: the daily cron
 * and the startup recovery already dispatch under `shared-nfl-data`, so a user-requested refresh
 * that omitted it could run concurrently with them against the same sources.
 */
export function enqueueDataRefresh(boss: PgBoss, job: DataRefreshJob): Promise<string | null> {
  assertDataRefreshJob(job);
  return boss.send(
    queueNames.dataRefresh,
    job,
    dispatchOptions("shared-nfl-data", "shared-nfl-data", 60),
  );
}

/** Coalesces repeated health checks into one globally serialized check. */
export function enqueueDataHealthCheck(boss: PgBoss, job: DataHealthJob): Promise<string | null> {
  assertDataHealthJob(job);
  return boss.send(
    queueNames.dataHealth,
    job,
    dispatchOptions("data-health", "data-health", 15 * 60),
  );
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid worker job: ${name} is required`);
  }
}

export function assertLeagueSyncJob(job: LeagueSyncJob): void {
  assertNonEmpty(job.leagueSeasonId, "leagueSeasonId");
  if (
    !(["scheduled", "manual", "draft", "stale-on-view", "provider-sweep"] as const).includes(
      job.reason,
    )
  ) {
    throw new Error("Invalid worker job: unsupported league sync reason");
  }
  const mode = job.mode ?? "connection";
  if (mode !== "connection" && mode !== "server-direct") {
    throw new Error("Invalid worker job: unsupported league sync mode");
  }
  if (mode === "connection") {
    assertNonEmpty(job.connectionId, "connectionId");
    if (job.refreshRequestId !== undefined || job.probe !== undefined) {
      throw new Error("Invalid worker job: direct fields require server-direct mode");
    }
    return;
  }
  if (job.connectionId !== undefined) {
    throw new Error("Invalid worker job: server-direct mode cannot name a connection");
  }
  if (job.refreshRequestId !== undefined) assertNonEmpty(job.refreshRequestId, "refreshRequestId");
  if (job.probe !== undefined && typeof job.probe !== "boolean") {
    throw new Error("Invalid worker job: probe must be boolean");
  }
}

export function assertProviderSyncSweepJob(job: ProviderSyncSweepJob): void {
  assertNonEmpty(job.requestedAt, "requestedAt");
  if (job.requestedAt !== "scheduled" && !Number.isFinite(Date.parse(job.requestedAt))) {
    throw new Error("Invalid worker job: requestedAt must be an ISO timestamp");
  }
}

export function assertProjectionRefreshJob(job: ProjectionRefreshJob): void {
  if (!Number.isInteger(job.season) || job.season < 2000 || job.season > 2100) {
    throw new Error("Invalid worker job: season must be between 2000 and 2100");
  }
  if (job.week !== undefined && (!Number.isInteger(job.week) || job.week < 1 || job.week > 25)) {
    throw new Error("Invalid worker job: week must be between 1 and 25");
  }
  if (
    job.reason !== undefined &&
    job.reason !== "scheduled" &&
    job.reason !== "lock-window" &&
    job.reason !== "on-demand"
  ) {
    throw new Error("Invalid worker job: unsupported projection refresh reason");
  }
}

export function assertRecommendationJob(job: RecommendationJob): void {
  assertNonEmpty(job.leagueSeasonId, "leagueSeasonId");
  const kinds: unknown = job.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new Error("Invalid worker job: at least one recommendation kind is required");
  }
  const allowedKinds = new Set<string>(recommendationKinds);
  if (kinds.some((kind: unknown) => typeof kind !== "string" || !allowedKinds.has(kind))) {
    throw new Error("Invalid worker job: unsupported recommendation kind");
  }
}

export function assertDataHealthJob(job: DataHealthJob): void {
  if (!(["schedule", "manual"] as const).includes(job.source)) {
    throw new Error("Invalid worker job: unsupported data health source");
  }
  if (job.source === "manual") assertNonEmpty(job.requestedBy, "requestedBy");
}

export function assertDataRefreshJob(job: DataRefreshJob): void {
  assertNonEmpty(job.requestedBy, "requestedBy");
  assertNonEmpty(job.requestedAt, "requestedAt");
  if (!(["player-data", "market-data", "adp-data"] as const).includes(job.scope)) {
    throw new Error("Invalid worker job: unsupported data refresh scope");
  }
  if (!(["daily", "scheduled", "user", "startup-recovery"] as const).includes(job.reason)) {
    throw new Error("Invalid worker job: unsupported data refresh reason");
  }
}

export function assertNotificationSweepJob(job: NotificationSweepJob): void {
  if (!(notificationSweepKinds as readonly string[]).includes(job.kind)) {
    throw new Error("Invalid worker job: unsupported notification kind");
  }
  if (job.reason !== "scheduled" && job.reason !== "manual") {
    throw new Error("Invalid worker job: unsupported notification sweep reason");
  }
}

export async function registerSchedules(boss: PgBoss, projectionSeason?: number): Promise<void> {
  // Older deployments registered these schedules before keyed schedules were introduced. pg-boss
  // treats a different key as a separate schedule, so leaving either row behind runs the same work
  // twice forever. Unscheduling a missing row is safe and keeps upgrades idempotent.
  await boss.unschedule(queueNames.providerSyncSweep, "espn-provider-sync-sweep");
  await boss.unschedule(queueNames.dataHealth);
  await boss.unschedule(queueNames.dataRefresh, "daily-nflverse-player-catalog");
  await boss.schedule(
    queueNames.providerSyncSweep,
    "*/5 * * * *",
    { requestedAt: "scheduled" } satisfies ProviderSyncSweepJob,
    {
      tz: "UTC",
      key: "provider-sync-sweep",
      group: { id: "provider-sync-sweep" },
      singletonKey: "provider-sync-sweep",
    },
  );
  await boss.schedule(
    queueNames.dataHealth,
    "*/15 * * * *",
    { source: "schedule" } satisfies DataHealthJob,
    {
      ...dispatchOptions("data-health", "data-health", 15 * 60),
      key: "scheduled-data-health",
    },
  );
  await boss.schedule(
    queueNames.dataRefresh,
    "17 5 * * *",
    {
      requestedBy: "system",
      scope: "player-data",
      reason: "daily",
      requestedAt: "scheduled",
    } satisfies DataRefreshJob,
    {
      tz: "UTC",
      key: "daily-shared-nfl-player-data",
      group: { id: "shared-nfl-data" },
      singletonKey: "shared-nfl-data",
    },
  );
  await boss.schedule(
    queueNames.dataRefresh,
    "47 5 * * *",
    {
      requestedBy: "system",
      scope: "adp-data",
      reason: "daily",
      requestedAt: "scheduled",
    } satisfies DataRefreshJob,
    {
      tz: "UTC",
      key: "daily-draft-market-adp",
      group: { id: "draft-market-adp" },
      singletonKey: "draft-market-adp",
    },
  );
  await boss.schedule(
    queueNames.dataRefresh,
    "23 * * * *",
    {
      requestedBy: "system",
      scope: "market-data",
      reason: "scheduled",
      requestedAt: "scheduled",
    } satisfies DataRefreshJob,
    {
      tz: "UTC",
      key: "hourly-waiver-market-data",
      group: { id: "waiver-market-data" },
      singletonKey: "waiver-market-data",
    },
  );
  // Offset from the other quarter-hour schedules so a lineup-lock sweep never queues behind the
  // source health check. The sweep itself decides which send window, if any, is live.
  await boss.schedule(
    queueNames.notificationSweep,
    "4,19,34,49 * * * *",
    { kind: "lineup-lock", reason: "scheduled" } satisfies NotificationSweepJob,
    {
      tz: "UTC",
      key: "lineup-lock-alerts",
      group: { id: "notifications" },
      singletonKey: "notification-sweep:lineup-lock",
    },
  );
  // Offset from both the lineup-lock sweep (minutes 4/19/34/49) and the quarter-hour health check.
  // One digest per member per sweep; the collector decides whether anything is actually pending.
  await boss.schedule(
    queueNames.notificationSweep,
    "9,24,39,54 * * * *",
    { kind: "change-event", reason: "scheduled" } satisfies NotificationSweepJob,
    {
      tz: "UTC",
      key: "change-event-alerts",
      group: { id: "notifications" },
      singletonKey: "notification-sweep:change-event",
    },
  );
  if (projectionSeason !== undefined) {
    assertProjectionRefreshJob({ season: projectionSeason });
    await boss.schedule(
      queueNames.refreshProjections,
      "*/10 * * * *",
      { season: projectionSeason, reason: "lock-window" } satisfies ProjectionRefreshJob,
      {
        tz: "UTC",
        key: "near-lock-first-party-projections",
        group: { id: "projections" },
        singletonKey: `projection-lock-window:${projectionSeason}`,
      },
    );
    await boss.schedule(
      queueNames.refreshProjections,
      "11 * * * *",
      { season: projectionSeason, reason: "scheduled" } satisfies ProjectionRefreshJob,
      {
        tz: "UTC",
        key: "hourly-first-party-projections",
        // The worker resolves the active NFL season again at execution time. A season-neutral
        // group therefore keeps scheduled and on-demand refreshes serialized across March
        // rollover even when the long-running schedule payload still names the prior season.
        group: { id: "projections" },
        singletonKey: `projection-refresh:${projectionSeason}:season`,
      },
    );
  }
}

export async function ensureDailyRefresh(boss: PgBoss, now = new Date()): Promise<void> {
  const dateKey = now.toISOString().slice(0, 10);
  await boss.send(
    queueNames.dataRefresh,
    {
      requestedBy: "system",
      scope: "player-data",
      reason: "startup-recovery",
      requestedAt: now.toISOString(),
    } satisfies DataRefreshJob,
    {
      group: { id: "shared-nfl-data" },
      singletonKey: `startup-daily:${dateKey}`,
      singletonSeconds: DAY_SECONDS,
    },
  );
  await boss.send(
    queueNames.dataRefresh,
    {
      requestedBy: "system",
      scope: "adp-data",
      reason: "startup-recovery",
      requestedAt: now.toISOString(),
    } satisfies DataRefreshJob,
    {
      // Startup ADP recovery shares the catalog group so the player identity refresh enqueued
      // immediately above completes first on a cold database.
      group: { id: "shared-nfl-data" },
      singletonKey: `startup-adp:${dateKey}`,
      singletonSeconds: DAY_SECONDS,
    },
  );
}
