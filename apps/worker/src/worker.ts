import { loadEnvironment } from "@laces-out/config";
import {
  drizzleChangeEventProducers,
  emitProviderSyncChangeEvents,
} from "@laces-out/change-events";
import { createDatabase } from "@laces-out/db";
import { createSmtpEmailTransport } from "@laces-out/email";
import { DrizzleInSeasonDecisionRepository, InSeasonDecisionService } from "@laces-out/decisions";
import {
  DrizzleYahooSyncRepository,
  EspnSessionConnectionService,
  EspnSessionSyncService,
  YahooConnectionService,
  YahooSyncService,
} from "@laces-out/league-sync";
import { parseCredentialKey } from "@laces-out/security";
import { PgBoss } from "pg-boss";
import pino from "pino";

import { DatabaseDataHealthService } from "./data-health.js";
import { FfcAdpRefresher } from "./ffc-adp.js";
import {
  enqueueLeagueSync,
  enqueueProjectionRefresh,
  enqueueRecommendationRecompute,
  enqueueRosProjectionRefresh,
  registerQueues,
  registerWorkers,
} from "./jobs.js";
import { createEspnDirectSyncService } from "./espn-direct-sync.js";
import {
  DrizzleConnectionCircuitStore,
  DrizzleEspnSessionAttemptStore,
  DrizzleLeagueSyncTargetReader,
  LeagueSyncService,
} from "./league-sync-service.js";
import {
  ChangeEventNotificationCollector,
  DrizzleChangeEventNotificationRepository,
} from "./change-event-notifications.js";
import { DrizzleInjuryChangeEventRepository } from "./injury-change-events.js";
import { DrizzleLeagueSyncNudgeRepository, LeagueSyncNudgeService } from "./league-sync-nudge.js";
import { DrizzleLineupLockRepository, LineupLockAlertService } from "./lineup-lock-alerts.js";
import { currentNflSeason } from "./nfl-season.js";
import {
  createNotificationSweepService,
  createWebPushTransport,
  DrizzleNotificationRepository,
  NotificationSender,
} from "./push-notifications.js";
import { NflverseCatalogRefresher } from "./nflverse-catalog.js";
import {
  FirstPartyProjectionService,
  projectionHistorySeasons,
} from "./first-party-projections.js";
import { NflverseScheduleRefresher } from "./nflverse-schedules.js";
import { NflverseWeeklyDataRefresher } from "./nflverse-weekly-data.js";
import { ProjectionLockWindowService } from "./projection-lock-window.js";
import { ProjectionRefreshOrchestrator } from "./projection-refresh-orchestrator.js";
import {
  DrizzleProviderSyncSweepTargetReader,
  ProviderSyncSweepService,
} from "./provider-sync-sweep.js";
import { createRecommendationRecomputeService } from "./recommendation-recompute-service.js";
import { SleeperDataRefresher } from "./sleeper-data.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 4);
const catalogRefresher = new NflverseCatalogRefresher({ database: database.db });
const weeklyDataRefresher = new NflverseWeeklyDataRefresher({
  database: database.db,
  // A genuinely new injury state becomes a private change event for each rostering member.
  changeEvents: new DrizzleInjuryChangeEventRepository(database.db),
  onChangeEventError: (error) =>
    logger.warn({ err: error }, "injury ingestion succeeded but change-event emission failed"),
});
const scheduleRefresher = new NflverseScheduleRefresher({ database: database.db });
const projectionLockWindow = new ProjectionLockWindowService(database.db);
const projectionService = new FirstPartyProjectionService({ database: database.db });
const sleeperRefresher = new SleeperDataRefresher({ database: database.db });
const adpRefresher = new FfcAdpRefresher({ database: database.db });
const dataHealthService = new DatabaseDataHealthService({
  database: database.db,
  activeNflSeason: currentNflSeason(),
});
// Web push is opt-in for the operator. Without a VAPID key pair the sender is simply absent and the
// scheduled sweep completes as a stated no-op, which is the default state of an existing install.
const vapid =
  environment.VAPID_PUBLIC_KEY && environment.VAPID_PRIVATE_KEY && environment.VAPID_SUBJECT
    ? {
        subject: environment.VAPID_SUBJECT,
        publicKey: environment.VAPID_PUBLIC_KEY,
        privateKey: environment.VAPID_PRIVATE_KEY,
      }
    : undefined;
const notificationSweepService = createNotificationSweepService({
  collectors: {
    "lineup-lock": new LineupLockAlertService({
      repository: new DrizzleLineupLockRepository(database.db),
    }),
    "change-event": new ChangeEventNotificationCollector({
      repository: new DrizzleChangeEventNotificationRepository(database.db),
    }),
  },
  ...(vapid
    ? {
        sender: new NotificationSender({
          repository: new DrizzleNotificationRepository(database.db),
          transport: createWebPushTransport(vapid),
        }),
      }
    : {}),
});
// Outbound email mirrors web push: without a complete SMTP identity the transport is absent and
// the scheduled email sweep completes as a stated no-op, the default state of an existing install.
const emailTransport =
  environment.SMTP_HOST &&
  environment.SMTP_USER &&
  environment.SMTP_PASSWORD &&
  environment.EMAIL_FROM
    ? createSmtpEmailTransport(
        {
          host: environment.SMTP_HOST,
          port: environment.SMTP_PORT,
          user: environment.SMTP_USER,
          password: environment.SMTP_PASSWORD,
          from: environment.EMAIL_FROM,
        },
        (failure) => logger.warn(failure, "outbound email send failed"),
      )
    : undefined;
const emailSweepService = new LeagueSyncNudgeService({
  repository: new DrizzleLeagueSyncNudgeRepository(database.db),
  ...(emailTransport ? { transport: emailTransport } : {}),
  webUrl: environment.WEB_URL,
});
// Server-held credentials are always encrypted with a deployment-owned key. Yahoo uses OAuth;
// ESPN's optional session mode is an explicit, read-only opt-in and remains disabled by default.
const credentialKey = environment.CREDENTIAL_ENCRYPTION_KEY
  ? parseCredentialKey(environment.CREDENTIAL_ENCRYPTION_KEY)
  : undefined;
const yahooConnection =
  environment.NEXT_PUBLIC_YAHOO_ACCESS_STATUS === "available" &&
  environment.YAHOO_CLIENT_ID &&
  environment.YAHOO_CLIENT_SECRET &&
  credentialKey
    ? new YahooConnectionService({
        database: database.db,
        credentialKey,
        clientId: environment.YAHOO_CLIENT_ID,
        clientSecret: environment.YAHOO_CLIENT_SECRET,
        redirectUri: environment.YAHOO_REDIRECT_URI,
      })
    : undefined;
const yahooSync = yahooConnection
  ? new YahooSyncService({
      repository: new DrizzleYahooSyncRepository(database.db),
      tokens: yahooConnection,
    })
  : undefined;
const espnSessionConnection = credentialKey
  ? new EspnSessionConnectionService({
      database: database.db,
      credentialKey,
      enabled: environment.ESPN_SERVER_SESSION_SYNC_ENABLED,
    })
  : undefined;
const espnSessionSync =
  environment.ESPN_SERVER_SESSION_SYNC_ENABLED && espnSessionConnection
    ? new EspnSessionSyncService({
        database: database.db,
        credentials: espnSessionConnection,
        observe: (event) => {
          if (event.outcome === "failed") {
            logger.warn(event, "ESPN session sync stage failed");
          } else {
            logger.info(event, "ESPN session sync stage completed");
          }
        },
      })
    : undefined;
const providerSyncChangeEvents = drizzleChangeEventProducers(database.db);
const espnDirectSync = createEspnDirectSyncService({
  database: database.db,
  enabled: environment.ESPN_PUBLIC_DIRECT_SYNC_ENABLED,
  afterCommit: async ({ receipt, season, checksumSha256, occurredAt }) => {
    await emitProviderSyncChangeEvents(
      providerSyncChangeEvents,
      {
        provider: "espn",
        state: receipt.state,
        leagueId: receipt.leagueId,
        leagueSeasonId: receipt.leagueSeasonId,
        actorUserId: null,
        artifactId: checksumSha256,
        occurredAt,
      },
      (error) =>
        logger.warn(
          { err: error, leagueSeasonId: receipt.leagueSeasonId },
          "ESPN direct sync succeeded but change-event emission failed",
        ),
    );
    if (receipt.state !== "accepted") return;
    try {
      await enqueueRecommendationRecompute(boss, {
        leagueSeasonId: receipt.leagueSeasonId,
        kinds: ["lineup", "waiver", "trade"],
      });
    } catch (error) {
      logger.warn(
        { err: error, leagueSeasonId: receipt.leagueSeasonId },
        "ESPN direct sync succeeded but recommendation enqueue failed",
      );
    }
    try {
      await enqueueProjectionRefresh(boss, {
        season,
        horizon: "weekly",
        reason: "on-demand",
      });
    } catch (error) {
      logger.warn(
        { err: error, season },
        "ESPN direct sync succeeded but projection enqueue failed",
      );
    }
  },
});
const leagueSyncService = new LeagueSyncService({
  targets: new DrizzleLeagueSyncTargetReader(database.db),
  circuit: new DrizzleConnectionCircuitStore(database.db),
  espnSessionAttempts: new DrizzleEspnSessionAttemptStore(database.db),
  espnDirect: espnDirectSync,
  ...(espnSessionSync ? { espnSessionSync } : {}),
  ...(yahooSync ? { yahooSync } : {}),
  afterYahooCommit: async (receipt) => {
    await emitProviderSyncChangeEvents(
      providerSyncChangeEvents,
      {
        provider: "yahoo",
        state: receipt.state,
        leagueId: receipt.leagueId,
        leagueSeasonId: receipt.leagueSeasonId,
        actorUserId: null,
        artifactId: receipt.syncRunId,
        occurredAt: new Date(receipt.syncedAt),
      },
      () =>
        logger.warn(
          { leagueSeasonId: receipt.leagueSeasonId },
          "Yahoo sync committed but change-event emission failed",
        ),
    );
    try {
      await enqueueRecommendationRecompute(boss, {
        leagueSeasonId: receipt.leagueSeasonId,
        kinds: ["lineup", "waiver", "trade"],
      });
    } catch {
      logger.warn(
        { leagueSeasonId: receipt.leagueSeasonId },
        "Yahoo sync committed but recommendation enqueue failed",
      );
    }
    try {
      await enqueueProjectionRefresh(boss, {
        season: receipt.season,
        horizon: "weekly",
        reason: "on-demand",
      });
    } catch {
      logger.warn({ season: receipt.season }, "Yahoo sync committed but projection enqueue failed");
    }
  },
  afterEspnCommit: async (receipt) => {
    await emitProviderSyncChangeEvents(
      providerSyncChangeEvents,
      {
        provider: "espn",
        state: receipt.state,
        leagueId: receipt.leagueId,
        leagueSeasonId: receipt.leagueSeasonId,
        actorUserId: null,
        artifactId: receipt.syncRunId,
        occurredAt: new Date(receipt.syncedAt),
      },
      () =>
        logger.warn(
          { leagueSeasonId: receipt.leagueSeasonId },
          "ESPN session sync committed but change-event emission failed",
        ),
    );
    try {
      await enqueueRecommendationRecompute(boss, {
        leagueSeasonId: receipt.leagueSeasonId,
        kinds: ["lineup", "waiver", "trade"],
      });
    } catch {
      logger.warn(
        { leagueSeasonId: receipt.leagueSeasonId },
        "ESPN session sync committed but recommendation enqueue failed",
      );
    }
    try {
      await enqueueProjectionRefresh(boss, {
        season: receipt.season,
        horizon: "weekly",
        reason: "on-demand",
      });
    } catch {
      logger.warn(
        { season: receipt.season },
        "ESPN session sync committed but projection enqueue failed",
      );
    }
  },
  observe: (event) => {
    if (
      event.event === "sync-failed" ||
      event.event === "after-commit-failed" ||
      event.event === "circuit-success-failed"
    ) {
      logger.warn(event, "provider league sync operational event");
    } else {
      logger.info(event, "provider league sync operational event");
    }
  },
});
const recommendationRecomputeService = createRecommendationRecomputeService({
  database: database.db,
  decisions: new InSeasonDecisionService(new DrizzleInSeasonDecisionRepository(database.db)),
  onChangeEventError: (error) =>
    logger.warn(
      { err: error },
      "recommendation recompute succeeded but change-event emission failed",
    ),
});

const logger = pino({
  level: environment.LOG_LEVEL,
  redact: {
    paths: [
      "*.authorization",
      "*.cookie",
      "*.access_token",
      "*.refresh_token",
      "*.espn_s2",
      "*.espnS2",
      "*.swid",
    ],
    censor: "[REDACTED]",
  },
});

const boss = new PgBoss({
  connectionString: environment.DATABASE_URL,
  application_name: "fantasy-worker",
  schema: "pgboss",
  supervise: true,
  // The API owns cron timekeeping so long-running projection work cannot swallow schedule ticks.
  schedule: false,
});
const projectionRefreshService = new ProjectionRefreshOrchestrator({
  currentSeason: currentNflSeason,
  lockWindow: projectionLockWindow,
  catalog: catalogRefresher,
  weeklyData: weeklyDataRefresher,
  sleeperCatalog: sleeperRefresher,
  schedule: scheduleRefresher,
  weeklyProjections: projectionService,
  enqueueRosProjections: (job) => enqueueRosProjectionRefresh(boss, job),
});
const providerSyncSweepService = new ProviderSyncSweepService({
  espnEnabled: environment.ESPN_PUBLIC_DIRECT_SYNC_ENABLED,
  espnSessionEnabled: espnSessionSync !== undefined,
  yahooEnabled: environment.YAHOO_AUTOMATED_SYNC_ENABLED && yahooSync !== undefined,
  targets: new DrizzleProviderSyncSweepTargetReader(database.db),
  enqueue: (job) => enqueueLeagueSync(boss, job),
  observe: (event) => {
    if (event.event === "enqueue-failed") {
      logger.warn(event, "provider sync sweep operational event");
    } else {
      logger.info(event, "provider sync sweep operational event");
    }
  },
});

boss.on("error", (error) => logger.error({ err: error }, "job queue error"));
boss.on("warning", (warning) => logger.warn({ warning }, "job queue warning"));

async function start(): Promise<void> {
  await boss.start();
  await registerQueues(boss);
  await registerWorkers(boss, logger, {
    dataHealth: dataHealthService,
    emailSweep: emailSweepService,
    leagueSync: leagueSyncService,
    notificationSweep: notificationSweepService,
    recommendationRecompute: recommendationRecomputeService,
    projectionRefresh: projectionRefreshService,
    providerSyncSweep: providerSyncSweepService,
    refreshPlayerData: async (force) => {
      const activeProjectionSeason = currentNflSeason();
      // Identity is intentionally refreshed first so Sleeper observations and trends can attach to
      // canonical players during a cold start instead of waiting for the next scheduled run.
      const nflverse = await catalogRefresher.refresh(force);
      const weeklyData = await weeklyDataRefresher.refreshCurrentWindow(
        activeProjectionSeason,
        force,
      );
      const scheduleData = Object.fromEntries(
        await Promise.all(
          projectionHistorySeasons(activeProjectionSeason).map(
            async (season) =>
              [`schedule${season}`, await scheduleRefresher.refresh(season, force)] as const,
          ),
        ),
      );
      const sleeper = await sleeperRefresher.refreshCatalog(force);
      const market = await sleeperRefresher.refreshTrends(force);
      await enqueueProjectionRefresh(boss, {
        season: activeProjectionSeason,
        horizon: force ? "full" : "weekly",
        reason: "on-demand",
      });
      return { nflverse, ...weeklyData, ...scheduleData, sleeper, market };
    },
    refreshMarketData: (force) => sleeperRefresher.refreshTrends(force),
    refreshAdpData: (force) => adpRefresher.refreshDefaultContexts(currentNflSeason(), force),
  });
  logger.info("fantasy worker started");
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping fantasy worker");
  await boss.stop({ graceful: true, timeout: 30_000 });
  await database.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await start();
} catch (error) {
  logger.fatal({ err: error }, "fantasy worker failed to start");
  process.exitCode = 1;
}
