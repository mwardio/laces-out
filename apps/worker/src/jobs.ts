import type { Job, PgBoss } from "pg-boss";
import type { Logger } from "pino";

export const queueNames = {
  syncLeague: "league-sync",
  refreshProjections: "projection-refresh",
  recomputeRecommendations: "recommendation-recompute",
  dataHealth: "data-health-check",
  dataRefresh: "data-refresh",
} as const;

interface LeagueSyncJob {
  readonly connectionId: string;
  readonly leagueSeasonId: string;
  readonly reason: "scheduled" | "manual" | "draft";
}

interface ProjectionRefreshJob {
  readonly season: number;
  readonly week?: number;
}

interface RecommendationJob {
  readonly leagueSeasonId: string;
  readonly kinds: readonly ("draft" | "lineup" | "waiver" | "trade")[];
}

interface DataRefreshJob {
  readonly requestedBy: string;
  readonly scope: "player-data" | "market-data";
  readonly reason: "daily" | "scheduled" | "user" | "startup-recovery";
  readonly requestedAt: string;
}

interface SourceRefreshResult {
  readonly state: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsRejected: number;
}

export interface WorkerServices {
  readonly refreshPlayerData?: (
    force: boolean,
  ) => Promise<Readonly<Record<string, SourceRefreshResult>>>;
  readonly refreshMarketData?: (force: boolean) => Promise<SourceRefreshResult>;
}

export async function registerQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue("league-sync-dead-letter");
  await boss.createQueue(queueNames.syncLeague, {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    deadLetter: "league-sync-dead-letter",
    warningQueueSize: 20,
  });
  await boss.createQueue(queueNames.refreshProjections, {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });
  await boss.createQueue(queueNames.recomputeRecommendations, {
    retryLimit: 2,
    retryDelay: 10,
  });
  await boss.createQueue(queueNames.dataHealth, {
    retryLimit: 2,
    retryDelay: 60,
  });
  await boss.createQueue(queueNames.dataRefresh, {
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    warningQueueSize: 10,
  });
}

function assertNotAborted(job: Job<unknown>): void {
  if (job.signal.aborted) throw new Error("Job was aborted during shutdown");
}

/**
 * Provider, projection, recommendation, and health handlers currently establish
 * durable boundaries without pretending a connector is configured. Data refresh
 * is intentionally narrower: it fails closed without the shared NFL-data adapters
 * and never stands in for provider sync or projection imports.
 */
export async function registerWorkers(
  boss: PgBoss,
  logger: Logger,
  services: WorkerServices = {},
): Promise<void> {
  await boss.work<LeagueSyncJob>(queueNames.syncLeague, (jobs) => {
    for (const job of jobs) {
      assertNotAborted(job);
      logger.info(
        { jobId: job.id, leagueSeasonId: job.data.leagueSeasonId, reason: job.data.reason },
        "league sync job accepted; connector dispatch is not configured yet",
      );
    }
    return Promise.resolve();
  });

  await boss.work<ProjectionRefreshJob>(queueNames.refreshProjections, (jobs) => {
    for (const job of jobs) {
      assertNotAborted(job);
      logger.info({ jobId: job.id, ...job.data }, "projection refresh job accepted");
    }
    return Promise.resolve();
  });

  await boss.work<RecommendationJob>(queueNames.recomputeRecommendations, (jobs) => {
    for (const job of jobs) {
      assertNotAborted(job);
      logger.info(
        { jobId: job.id, leagueSeasonId: job.data.leagueSeasonId, kinds: job.data.kinds },
        "recommendation recompute job accepted",
      );
    }
    return Promise.resolve();
  });

  await boss.work(queueNames.dataHealth, (jobs) => {
    for (const job of jobs) {
      assertNotAborted(job);
      logger.debug({ jobId: job.id }, "data health check");
    }
    return Promise.resolve();
  });

  await boss.work<DataRefreshJob>(queueNames.dataRefresh, async (jobs) => {
    for (const job of jobs) {
      assertNotAborted(job);
      if (job.data.scope === "market-data") {
        if (!services.refreshMarketData) {
          throw new Error("The waiver-market adapter is not configured");
        }
        const result = await services.refreshMarketData(job.data.reason === "user");
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
      if (!services.refreshPlayerData) {
        throw new Error("The shared NFL player-data adapters are not configured");
      }
      const sourceResults = await services.refreshPlayerData(job.data.reason === "user");
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

export async function registerSchedules(boss: PgBoss): Promise<void> {
  await boss.schedule(queueNames.dataHealth, "*/15 * * * *", { source: "schedule" });
  await boss.schedule(
    queueNames.dataRefresh,
    "17 5 * * *",
    {
      requestedBy: "system",
      scope: "player-data",
      reason: "daily",
      requestedAt: "scheduled",
    } satisfies DataRefreshJob,
    { tz: "UTC", key: "daily-shared-nfl-player-data" },
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
    { tz: "UTC", key: "hourly-waiver-market-data" },
  );
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
    { singletonKey: `startup-daily:${dateKey}`, singletonSeconds: 86_400 },
  );
}
