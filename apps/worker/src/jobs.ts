import type { Job, PgBoss } from "pg-boss";
import type { Logger } from "pino";

import {
  assertDataHealthJob,
  assertDataRefreshJob,
  assertEmailSweepJob,
  assertLeagueSyncJob,
  assertNotificationSweepJob,
  assertProjectionRefreshJob,
  assertProviderSyncSweepJob,
  assertRecommendationJob,
  queueNames,
} from "@fantasy/jobs";
import type {
  DataHealthJob,
  DataRefreshJob,
  EmailSweepJob,
  LeagueSyncJob,
  NotificationSweepJob,
  ProjectionRefreshJob,
  ProviderSyncSweepJob,
  RecommendationJob,
} from "@fantasy/jobs";

/**
 * Queue names, payloads, reliability settings, validators, dispatch helpers, and schedules are the
 * shared process contract and live in `@fantasy/jobs` so the API cannot declare them differently.
 * What stays here is what only a worker process has: the services that execute a job, and the
 * handler registration that binds them to a queue.
 */
export * from "@fantasy/jobs";

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

export interface ProviderSyncSweepResult {
  readonly expired: number;
  readonly considered: number;
  readonly enqueued: number;
  readonly byProvider: Readonly<
    Record<"espn" | "yahoo", { readonly considered: number; readonly enqueued: number }>
  >;
}

export interface ProviderSyncSweepService {
  sweepProviderSync(
    job: ProviderSyncSweepJob,
    context: WorkerJobContext,
  ): Promise<ProviderSyncSweepResult>;
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
  /** Sources whose stored match rate is below the threshold recorded at ingestion time. */
  readonly unmatchedIdentitySources: number;
  readonly degradedSourceKeys: readonly string[];
}

export interface NotificationSweepService {
  sweep(job: NotificationSweepJob, context: WorkerJobContext): Promise<NotificationSweepResult>;
}

export interface EmailSweepResult {
  readonly considered: number;
  readonly sent: number;
  readonly duplicates: number;
  readonly failures: number;
  /** Set when the sweep did nothing on purpose, most often because SMTP is not configured. */
  readonly skipped: string | null;
}

export interface EmailSweepService {
  sweep(job: EmailSweepJob, context: WorkerJobContext): Promise<EmailSweepResult>;
}

export interface WorkerServices {
  readonly leagueSync?: LeagueSyncService;
  readonly projectionRefresh?: ProjectionRefreshService;
  readonly providerSyncSweep?: ProviderSyncSweepService;
  readonly recommendationRecompute?: RecommendationRecomputeService;
  readonly dataHealth?: DataHealthService;
  readonly notificationSweep?: NotificationSweepService;
  readonly emailSweep?: EmailSweepService;
  readonly refreshPlayerData?: (
    force: boolean,
  ) => Promise<Readonly<Record<string, SourceRefreshResult>>>;
  readonly refreshMarketData?: (force: boolean) => Promise<SourceRefreshResult>;
  readonly refreshAdpData?: (force: boolean) => Promise<readonly SourceRefreshResult[]>;
}

function assertNotAborted(job: Job<unknown>): void {
  if (job.signal.aborted) throw new Error("Job was aborted during shutdown");
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

  await boss.work<ProviderSyncSweepJob>(queueNames.providerSyncSweep, workOptions, async (jobs) => {
    const service = requireService(services.providerSyncSweep, "Provider sync sweep");
    for (const job of jobs) {
      assertNotAborted(job);
      assertProviderSyncSweepJob(job.data);
      const result = await service.sweepProviderSync(job.data, {
        jobId: job.id,
        signal: job.signal,
      });
      logger.info({ jobId: job.id, result }, "provider sync sweep completed");
    }
  });

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

  await boss.work<EmailSweepJob>(queueNames.emailSweep, workOptions, async (jobs) => {
    const service = requireService(services.emailSweep, "Email sweep");
    for (const job of jobs) {
      assertNotAborted(job);
      assertEmailSweepJob(job.data);
      const result = await service.sweep(job.data, { jobId: job.id, signal: job.signal });
      // Counts only. A recipient address or message body never reaches the log.
      logger.info(
        { jobId: job.id, kind: job.data.kind, reason: job.data.reason, result },
        "email sweep completed",
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

/**
 * Registers the CPU-heavy ROS consumer separately so a long universe simulation cannot block
 * league sync, notifications, health checks, or current-week projection work.
 */
export async function registerRosProjectionWorker(
  boss: PgBoss,
  logger: Logger,
  service: ProjectionRefreshService,
): Promise<void> {
  await boss.work<ProjectionRefreshJob>(
    queueNames.refreshRosProjections,
    workOptions,
    async (jobs) => {
      for (const job of jobs) {
        assertNotAborted(job);
        assertProjectionRefreshJob(job.data);
        if (job.data.horizon === "weekly") {
          throw new Error("ROS projection worker received weekly-only work");
        }
        await service.refreshProjections(job.data, { jobId: job.id, signal: job.signal });
        logger.info({ jobId: job.id, ...job.data }, "ROS projection refresh completed");
      }
    },
  );
}
