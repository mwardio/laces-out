import { loadEnvironment } from "@fantasy/config";
import { createDatabase } from "@fantasy/db";
import { DrizzleInSeasonDecisionRepository, InSeasonDecisionService } from "@fantasy/decisions";
import {
  DrizzleYahooSyncRepository,
  YahooConnectionService,
  YahooSyncService,
} from "@fantasy/league-sync";
import { parseCredentialKey } from "@fantasy/security";
import { PgBoss } from "pg-boss";
import pino from "pino";

import { DatabaseDataHealthService } from "./data-health.js";
import { FfcAdpRefresher } from "./ffc-adp.js";
import {
  enqueueProjectionRefresh,
  ensureDailyRefresh,
  registerQueues,
  registerSchedules,
  registerWorkers,
} from "./jobs.js";
import {
  DrizzleConnectionCircuitStore,
  DrizzleLeagueSyncTargetReader,
  LeagueSyncService,
} from "./league-sync-service.js";
import {
  ChangeEventNotificationCollector,
  DrizzleChangeEventNotificationRepository,
} from "./change-event-notifications.js";
import { DrizzleInjuryChangeEventRepository } from "./injury-change-events.js";
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
import { databaseFirstPartyRosCandidateProvider } from "./first-party-ros-candidate-provider.js";
import { FirstPartyRosProjectionShadowService } from "./first-party-ros-projections.js";
import { NflverseScheduleRefresher } from "./nflverse-schedules.js";
import { NflverseWeeklyDataRefresher } from "./nflverse-weekly-data.js";
import { ProjectionLockWindowService } from "./projection-lock-window.js";
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
const rosProjectionShadowService = new FirstPartyRosProjectionShadowService({
  database: database.db,
  candidateProvider: databaseFirstPartyRosCandidateProvider({ database: database.db }),
});
const sleeperRefresher = new SleeperDataRefresher({ database: database.db });
const adpRefresher = new FfcAdpRefresher({ database: database.db });
const dataHealthService = new DatabaseDataHealthService({ database: database.db });
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
// Yahoo is the only provider whose credential the server may hold and replay, and only when the
// operator has configured all three secrets. Without them, `leagueSync` is simply absent and the
// queue's handler reports a stated no-op rather than dead-lettering. ESPN is never constructed
// here at all: its credential stays in the browser (ADR 0002).
const credentialKey = environment.CREDENTIAL_ENCRYPTION_KEY
  ? parseCredentialKey(environment.CREDENTIAL_ENCRYPTION_KEY)
  : undefined;
const yahooConnection =
  environment.YAHOO_CLIENT_ID && environment.YAHOO_CLIENT_SECRET && credentialKey
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
const leagueSyncService = new LeagueSyncService({
  targets: new DrizzleLeagueSyncTargetReader(database.db),
  circuit: new DrizzleConnectionCircuitStore(database.db),
  ...(yahooSync ? { yahooSync } : {}),
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
    paths: ["*.authorization", "*.cookie", "*.access_token", "*.refresh_token", "*.espn_s2"],
    censor: "[REDACTED]",
  },
});

const boss = new PgBoss({
  connectionString: environment.DATABASE_URL,
  application_name: "fantasy-worker",
  schema: "pgboss",
  supervise: true,
  schedule: true,
});

boss.on("error", (error) => logger.error({ err: error }, "job queue error"));
boss.on("warning", (warning) => logger.warn({ warning }, "job queue warning"));

async function start(): Promise<void> {
  const projectionSeason = currentNflSeason();
  await boss.start();
  await registerQueues(boss);
  await registerWorkers(boss, logger, {
    dataHealth: dataHealthService,
    leagueSync: leagueSyncService,
    notificationSweep: notificationSweepService,
    recommendationRecompute: recommendationRecomputeService,
    projectionRefresh: {
      refreshProjections: async (job, context) => {
        const effectiveJob =
          job.reason === "scheduled" || job.reason === "lock-window"
            ? { ...job, season: currentNflSeason() }
            : job;
        const lockWindow =
          effectiveJob.reason === "lock-window"
            ? await projectionLockWindow.check(effectiveJob.season)
            : null;
        if (lockWindow !== null && !lockWindow.active) return;
        // The final near-lock pass bypasses conditional source clocks once, inside a bounded
        // ten-minute window. Other frequent cron ticks remain conditional and cheap.
        const forceCurrentInputs = lockWindow?.forceFinalCheck === true;
        // Refresh every current-season model input before forecasting. Each source owns a claim
        // window and conditional request, so overlapping/manual sweeps coalesce and unchanged
        // artifacts do not produce new immutable observations.
        await weeklyDataRefresher.refreshWeeklyStats(effectiveJob.season, forceCurrentInputs);
        await weeklyDataRefresher.refreshSnapCounts(effectiveJob.season, forceCurrentInputs);
        await weeklyDataRefresher.refreshWeeklyRosters(effectiveJob.season, forceCurrentInputs);
        await weeklyDataRefresher.refreshInjuries(effectiveJob.season, forceCurrentInputs);
        await weeklyDataRefresher.refreshTeamWeeklyStats(effectiveJob.season, forceCurrentInputs);
        await sleeperRefresher.refreshCatalog(forceCurrentInputs);
        // Historical schedules remain part of the reproducible training selection; their longer
        // source cadence makes these calls cheap no-ops outside an actual correction.
        for (const season of projectionHistorySeasons(effectiveJob.season)) {
          await scheduleRefresher.refresh(
            season,
            forceCurrentInputs && season === effectiveJob.season,
          );
        }
        await projectionService.refreshProjections(effectiveJob, context);
        // ROS consumes only the immutable weekly artifacts written above. It remains isolated from
        // projection sets and recommendations until its held-out evidence and interval gate clear.
        await rosProjectionShadowService.refreshProjections(effectiveJob, context);
      },
    },
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
        reason: "on-demand",
      });
      return { nflverse, ...weeklyData, ...scheduleData, sleeper, market };
    },
    refreshMarketData: (force) => sleeperRefresher.refreshTrends(force),
    refreshAdpData: (force) => adpRefresher.refreshDefaultContexts(currentNflSeason(), force),
  });
  await registerSchedules(boss, projectionSeason);
  await ensureDailyRefresh(boss);
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
