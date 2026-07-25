import type { Job, PgBoss, Queue, SendOptions } from "pg-boss";
import type { Logger } from "pino";

export const queueNames = {
  syncLeague: "league-sync",
  refreshProjections: "projection-refresh",
  recomputeRecommendations: "recommendation-recompute",
  dataHealth: "data-health-check",
  dataRefresh: "data-refresh",
  notificationSweep: "notification-sweep",
} as const;

export const deadLetterQueueNames = {
  syncLeague: "league-sync-dead-letter",
  refreshProjections: "projection-refresh-dead-letter",
  recomputeRecommendations: "recommendation-recompute-dead-letter",
  dataHealth: "data-health-check-dead-letter",
  dataRefresh: "data-refresh-dead-letter",
  notificationSweep: "notification-sweep-dead-letter",
} as const;

export interface LeagueSyncJob {
  readonly connectionId: string;
  readonly leagueSeasonId: string;
  readonly reason: "scheduled" | "manual" | "draft";
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
export const notificationSweepKinds = ["lineup-lock"] as const;
export type NotificationSweepKind = (typeof notificationSweepKinds)[number];

export interface NotificationSweepJob {
  readonly kind: NotificationSweepKind;
  readonly reason: "scheduled" | "manual";
}

export interface NotificationSweepResult {
  readonly considered: number;
  readonly sent: number;
  readonly duplicates: number;
  readonly withoutDevices: number;
  readonly deliveries: number;
  readonly pruned: number;
  readonly failures: number;
  /** Set when the sweep did nothing on purpose, most often because VAPID keys are absent. */
  readonly skipped: string | null;
}

export interface SourceRefreshResult {
  readonly state: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsRejected: number;
}

export interface WorkerJobContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
}

export interface LeagueSyncService {
  syncLeague(job: LeagueSyncJob, context: WorkerJobContext): Promise<void>;
}

export interface ProjectionRefreshService {
  refreshProjections(job: ProjectionRefreshJob, context: WorkerJobContext): Promise<void>;
}

export interface RecommendationRecomputeService {
  recomputeRecommendations(job: RecommendationJob, context: WorkerJobContext): Promise<void>;
}

export interface DataHealthService {
  checkDataHealth(job: DataHealthJob, context: WorkerJobContext): Promise<DataHealthCheckResult>;
}

export interface DataHealthCheckResult {
  readonly checkedAt: string;
  readonly enabledSources: number;
  readonly healthySources: number;
  readonly pendingSources: number;
  readonly degradedSources: number;
  readonly failingSources: number;
  readonly staleSources: number;
  readonly degradedSourceKeys: readonly string[];
}

export interface NotificationSweepService {
  sweep(job: NotificationSweepJob, context: WorkerJobContext): Promise<NotificationSweepResult>;
}

export interface WorkerServices {
  readonly leagueSync?: LeagueSyncService;
  readonly projectionRefresh?: ProjectionRefreshService;
  readonly recommendationRecompute?: RecommendationRecomputeService;
  readonly dataHealth?: DataHealthService;
  readonly notificationSweep?: NotificationSweepService;
  readonly refreshPlayerData?: (
    force: boolean,
  ) => Promise<Readonly<Record<string, SourceRefreshResult>>>;
  readonly refreshMarketData?: (force: boolean) => Promise<SourceRefreshResult>;
  readonly refreshAdpData?: (force: boolean) => Promise<readonly SourceRefreshResult[]>;
}

type QueueConfiguration = Omit<Queue, "name" | "partition" | "policy">;

const DAY_SECONDS = 86_400;
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
    expireInSeconds: 30 * 60,
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
  return boss.send(
    queueNames.syncLeague,
    job,
    dispatchOptions(
      `league-season:${job.leagueSeasonId}`,
      `league-sync:${job.connectionId}:${job.leagueSeasonId}`,
      60,
    ),
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

/** Coalesces repeated health checks into one globally serialized check. */
export function enqueueDataHealthCheck(boss: PgBoss, job: DataHealthJob): Promise<string | null> {
  assertDataHealthJob(job);
  return boss.send(
    queueNames.dataHealth,
    job,
    dispatchOptions("data-health", "data-health", 15 * 60),
  );
}

function assertNotAborted(job: Job<unknown>): void {
  if (job.signal.aborted) throw new Error("Job was aborted during shutdown");
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid worker job: ${name} is required`);
  }
}

function assertLeagueSyncJob(job: LeagueSyncJob): void {
  assertNonEmpty(job.connectionId, "connectionId");
  assertNonEmpty(job.leagueSeasonId, "leagueSeasonId");
  if (!(["scheduled", "manual", "draft"] as const).includes(job.reason)) {
    throw new Error("Invalid worker job: unsupported league sync reason");
  }
}

function assertProjectionRefreshJob(job: ProjectionRefreshJob): void {
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

function assertRecommendationJob(job: RecommendationJob): void {
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

function assertDataHealthJob(job: DataHealthJob): void {
  if (!(["schedule", "manual"] as const).includes(job.source)) {
    throw new Error("Invalid worker job: unsupported data health source");
  }
  if (job.source === "manual") assertNonEmpty(job.requestedBy, "requestedBy");
}

function assertDataRefreshJob(job: DataRefreshJob): void {
  assertNonEmpty(job.requestedBy, "requestedBy");
  assertNonEmpty(job.requestedAt, "requestedAt");
  if (!(["player-data", "market-data", "adp-data"] as const).includes(job.scope)) {
    throw new Error("Invalid worker job: unsupported data refresh scope");
  }
  if (!(["daily", "scheduled", "user", "startup-recovery"] as const).includes(job.reason)) {
    throw new Error("Invalid worker job: unsupported data refresh reason");
  }
}

function assertNotificationSweepJob(job: NotificationSweepJob): void {
  if (!(notificationSweepKinds as readonly string[]).includes(job.kind)) {
    throw new Error("Invalid worker job: unsupported notification kind");
  }
  if (job.reason !== "scheduled" && job.reason !== "manual") {
    throw new Error("Invalid worker job: unsupported notification sweep reason");
  }
}

function requireService<T>(service: T | undefined, label: string): T {
  if (!service) throw new Error(`${label} service is not configured`);
  return service;
}

const workOptions = {
  batchSize: 1,
  groupConcurrency: 1,
} as const;

/**
 * Every handler awaits a real service. Missing services and malformed payloads throw so pg-boss
 * retries and ultimately dead-letters the job; no operational job is acknowledged by logging.
 */
export async function registerWorkers(
  boss: PgBoss,
  logger: Logger,
  services: WorkerServices = {},
): Promise<void> {
  await boss.work<LeagueSyncJob>(queueNames.syncLeague, workOptions, async (jobs) => {
    const service = requireService(services.leagueSync, "League sync");
    for (const job of jobs) {
      assertNotAborted(job);
      assertLeagueSyncJob(job.data);
      await service.syncLeague(job.data, { jobId: job.id, signal: job.signal });
      logger.info(
        { jobId: job.id, leagueSeasonId: job.data.leagueSeasonId, reason: job.data.reason },
        "league sync completed",
      );
    }
  });

  await boss.work<ProjectionRefreshJob>(
    queueNames.refreshProjections,
    workOptions,
    async (jobs) => {
      const service = requireService(services.projectionRefresh, "Projection refresh");
      for (const job of jobs) {
        assertNotAborted(job);
        assertProjectionRefreshJob(job.data);
        await service.refreshProjections(job.data, { jobId: job.id, signal: job.signal });
        logger.info({ jobId: job.id, ...job.data }, "projection refresh completed");
      }
    },
  );

  await boss.work<RecommendationJob>(
    queueNames.recomputeRecommendations,
    workOptions,
    async (jobs) => {
      const service = requireService(services.recommendationRecompute, "Recommendation recompute");
      for (const job of jobs) {
        assertNotAborted(job);
        assertRecommendationJob(job.data);
        await service.recomputeRecommendations(job.data, {
          jobId: job.id,
          signal: job.signal,
        });
        logger.info(
          { jobId: job.id, leagueSeasonId: job.data.leagueSeasonId, kinds: job.data.kinds },
          "recommendation recompute completed",
        );
      }
    },
  );

  await boss.work<DataHealthJob>(queueNames.dataHealth, workOptions, async (jobs) => {
    const service = requireService(services.dataHealth, "Data health");
    for (const job of jobs) {
      assertNotAborted(job);
      assertDataHealthJob(job.data);
      const result = await service.checkDataHealth(job.data, {
        jobId: job.id,
        signal: job.signal,
      });
      logger.info(
        { jobId: job.id, source: job.data.source, result },
        "data health check completed",
      );
    }
  });

  await boss.work<NotificationSweepJob>(queueNames.notificationSweep, workOptions, async (jobs) => {
    const service = requireService(services.notificationSweep, "Notification sweep");
    for (const job of jobs) {
      assertNotAborted(job);
      assertNotificationSweepJob(job.data);
      const result = await service.sweep(job.data, { jobId: job.id, signal: job.signal });
      // Counts only. A notification's recipient, devices, and text never reach the log.
      logger.info(
        { jobId: job.id, kind: job.data.kind, reason: job.data.reason, result },
        "notification sweep completed",
      );
    }
  });

  await boss.work<DataRefreshJob>(queueNames.dataRefresh, workOptions, async (jobs) => {
    for (const job of jobs) {
      assertNotAborted(job);
      assertDataRefreshJob(job.data);
      if (job.data.scope === "market-data") {
        const refreshMarketData = requireService(
          services.refreshMarketData,
          "Waiver-market adapter",
        );
        const result = await refreshMarketData(job.data.reason === "user");
        logger.info(
          {
            jobId: job.id,
            requestedBy: job.data.requestedBy,
            scope: job.data.scope,
            reason: job.data.reason,
            result,
          },
          "waiver-market signal check completed",
        );
        continue;
      }
      if (job.data.scope === "adp-data") {
        const refreshAdpData = requireService(services.refreshAdpData, "Draft-market ADP adapter");
        const sourceResults = await refreshAdpData(job.data.reason === "user");
        logger.info(
          {
            jobId: job.id,
            requestedBy: job.data.requestedBy,
            scope: job.data.scope,
            reason: job.data.reason,
            sourceResults,
          },
          "draft-market ADP checks completed",
        );
        continue;
      }
      const refreshPlayerData = requireService(
        services.refreshPlayerData,
        "Shared NFL player-data adapters",
      );
      const sourceResults = await refreshPlayerData(job.data.reason === "user");
      logger.info(
        {
          jobId: job.id,
          requestedBy: job.data.requestedBy,
          scope: job.data.scope,
          reason: job.data.reason,
          sourceResults,
        },
        "shared NFL player-data checks completed",
      );
    }
  });
}

export async function registerSchedules(boss: PgBoss, projectionSeason?: number): Promise<void> {
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
