import { loadEnvironment } from "@laces-out/config";
import { createDatabase } from "@laces-out/db";
import { currentNflSeason } from "@laces-out/domain";
import { EspnSessionConnectionService } from "@laces-out/league-sync";
import {
  enqueueDataRefresh,
  enqueueLeagueSync,
  enqueueProjectionRefresh,
  enqueueRecommendationRecompute,
  ensureDailyRefresh,
  registerQueues,
  registerSchedules,
} from "@laces-out/jobs";
import { parseCredentialKey } from "@laces-out/security";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";

import { createSmtpEmailTransport, type SmtpSendFailure } from "@laces-out/email";

import { buildApp } from "./app.js";
import { DrizzleAccountDataRepository } from "./account-data.js";
import { BrowserHandoffService, DrizzleBrowserHandoffStore } from "./browser-handoff.js";
import { createAiProviderAdapters } from "./ai-provider-adapters.js";
import { AiService, DrizzleAiRepository } from "./ai-service.js";
import { DrizzleAuthRepository } from "./auth-repository.js";
import { drizzleChangeEventProducers } from "./change-event-producers.js";
import { ChangeEventService, DrizzleChangeEventRepository } from "./change-events.js";
import { AuthService } from "./auth.js";
import { DraftAnalysisService, DrizzleDraftProjectionSource } from "./draft-analysis.js";
import { DraftSessionService, DrizzleDraftSessionRepository } from "./draft-session.js";
import { DraftMarketService } from "./draft-market.js";
import { EspnBridgeService } from "./espn-bridge.js";
import { DrizzleEspnLiveDraftRepository } from "./espn-live-draft-persistence.js";
import { EspnLiveDraftService } from "./espn-live-draft-service.js";
import { DrizzleEspnRefreshRepository, EspnRefreshCoordinator } from "./espn-refresh.js";
import { DrizzleEspnSyncPersistence } from "./espn-sync-persistence.js";
import {
  DrizzleInSeasonDecisionRepository,
  InSeasonDecisionService,
} from "./in-season-decisions.js";
import { DrizzleLeagueAnalyticsRepository, LeagueAnalyticsService } from "./league-analytics.js";
import { DrizzleInvitationRepository } from "./invitation-repository.js";
import { deriveInvitationKeyring, InvitationService } from "./invitation.js";
import { DrizzleLeagueDashboardRepository, LeagueDashboardService } from "./league-dashboard.js";
import { LeagueMembershipService } from "./league-membership.js";
import { DrizzleProjectionImportRepository, ProjectionImportService } from "./projection-import.js";
import { DrizzleRefreshAuthorization } from "./refresh-authorization.js";
import { RosProjectionStatusService } from "./ros-projection-status.js";
import { DrizzleRankingRepository } from "./ranking-repository.js";
import { deriveRankingShareKeyring, RankingService } from "./ranking-service.js";
import { DrizzleRecapRepository, RecapService } from "./recap-service.js";
import { DrizzleRegistrationRepository } from "./registration-repository.js";
import { RegistrationService } from "./registration.js";
import {
  createEmailConfirmationDelivery,
  createPasswordResetEmailDelivery,
} from "./email-delivery.js";
import { DrizzleEmailVerificationRepository } from "./email-verification-repository.js";
import { EmailVerificationService } from "./email-verification.js";
import { DrizzlePasswordResetRepository } from "./password-reset-repository.js";
import { PasswordResetService } from "./password-reset.js";
import { DrizzlePreferencesRepository, PreferencesService } from "./preferences.js";
import {
  createWebPushSender,
  DrizzlePushSubscriptionRepository,
  PushSubscriptionService,
} from "./push-subscriptions.js";
import { DrizzleScheduleRepository, ScheduleService } from "./schedule.js";
import { DrizzleScheduleEdgeRepository, ScheduleEdgeService } from "./schedule-edge.js";
import { DataQualityService, DrizzleDataQualityRepository } from "./data-quality.js";
import { DrizzleStatsCenterRepository, StatsCenterService } from "./stats-center.js";
import { YahooConnectionService } from "./yahoo-connection.js";
import { DrizzleYahooDraftPollRepository, YahooDraftPollService } from "./yahoo-draft-service.js";
import { DrizzleYahooSyncRepository, YahooSyncService } from "./yahoo-sync.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL);
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
const authService = new AuthService(new DrizzleAuthRepository(database.db));
const accountData = new DrizzleAccountDataRepository(database.db);
const browserHandoffs = new BrowserHandoffService(
  new DrizzleBrowserHandoffStore(database.db),
  environment.API_URL,
);
const espnLiveDraftRepository = new DrizzleEspnLiveDraftRepository(database.db);
const yahooDraftRepository = new DrizzleYahooDraftPollRepository(database.db);
const draftSessions = new DraftSessionService(
  new DrizzleDraftSessionRepository(database.db, {
    loadFeedStatus: async (draftId) =>
      (await espnLiveDraftRepository.loadFeedStatus(draftId)) ??
      yahooDraftRepository.loadFeedStatus(draftId),
  }),
  () => new Date(),
  {
    yahooDraftAssistEnabled:
      environment.YAHOO_AUTOMATED_SYNC_ENABLED && yahooConnection !== undefined,
  },
);
const draftMarket = new DraftMarketService(database.db);
const draftAnalysis = new DraftAnalysisService(
  draftSessions,
  draftMarket,
  new DrizzleDraftProjectionSource(database.db),
);
const espnPersistence = new DrizzleEspnSyncPersistence(database.db);
const espnSessionConnections = credentialKey
  ? new EspnSessionConnectionService({
      database: database.db,
      credentialKey,
      enabled: environment.ESPN_SERVER_SESSION_SYNC_ENABLED,
    })
  : undefined;
// Change-event producers write; the service is the only authorized reader.
const changeEventProducers = drizzleChangeEventProducers(database.db);
const changeEvents = new ChangeEventService(new DrizzleChangeEventRepository(database.db));
const espnBridge = new EspnBridgeService(database.db, () => new Date(), espnPersistence, {
  producers: changeEventProducers,
  onError: (error) => app.log.warn({ err: error }, "ESPN sync change-event emission failed"),
});
// Constructed unconditionally so the flag is enforced in one place inside the service; the route
// still serves 503 for a deployment that has never configured live draft sync at all.
const espnLiveDraft = new EspnLiveDraftService(espnLiveDraftRepository, {
  enabled: environment.ESPN_LIVE_DRAFT_SYNC,
});
const decisions = new InSeasonDecisionService(new DrizzleInSeasonDecisionRepository(database.db));
const analytics = new LeagueAnalyticsService(new DrizzleLeagueAnalyticsRepository(database.db));
// Also the AiService recap prompt port, so persona cards reach the prompt without the service
// cycle a RecapService-implemented port would create.
const recapRepository = new DrizzleRecapRepository(database.db);
const schedule = new ScheduleService(new DrizzleScheduleRepository(database.db));
const scheduleEdge = new ScheduleEdgeService(new DrizzleScheduleEdgeRepository(database.db));
const dataQuality = new DataQualityService(new DrizzleDataQualityRepository(database.db));
const preferences = new PreferencesService(new DrizzlePreferencesRepository(database.db));
// Constructed unconditionally so device management and the config probe answer consistently. The
// service reports the feature unavailable, and refuses to register or test, when the operator has
// not configured a VAPID key pair — the default state of every existing deployment.
const vapid =
  environment.VAPID_PUBLIC_KEY && environment.VAPID_PRIVATE_KEY && environment.VAPID_SUBJECT
    ? {
        subject: environment.VAPID_SUBJECT,
        publicKey: environment.VAPID_PUBLIC_KEY,
        privateKey: environment.VAPID_PRIVATE_KEY,
      }
    : undefined;
const push = new PushSubscriptionService({
  repository: new DrizzlePushSubscriptionRepository(database.db),
  ...(vapid ? { publicKey: vapid.publicKey, sender: createWebPushSender(vapid) } : {}),
});
// The schedule doubles as the bye source so a player's game log can mark an idle week.
const statsCenter = new StatsCenterService(
  new DrizzleStatsCenterRepository(database.db),
  () => new Date(),
  schedule,
);
const leagueDashboard = new LeagueDashboardService(
  new DrizzleLeagueDashboardRepository(database.db),
);
const leagueMemberships = new LeagueMembershipService(database.db);
const ai = credentialKey
  ? new AiService({
      repository: new DrizzleAiRepository(database.db),
      credentialKey,
      adapters: createAiProviderAdapters(environment.WEB_URL),
      leagueDashboard,
      decisions,
      analytics,
      recapPrompt: recapRepository,
      ...(environment.GEMINI_API_KEY
        ? {
            managedGemini: {
              apiKey: environment.GEMINI_API_KEY,
              dailyRequestLimit: environment.MANAGED_AI_DAILY_REQUEST_LIMIT,
              maxOutputTokens: environment.MANAGED_AI_MAX_OUTPUT_TOKENS,
            },
          }
        : {}),
      ...(environment.OPENROUTER_API_KEY
        ? {
            managedRecapOpenRouter: {
              apiKey: environment.OPENROUTER_API_KEY,
              maxOutputTokens: environment.MANAGED_AI_MAX_OUTPUT_TOKENS,
            },
          }
        : {}),
    })
  : undefined;
const recaps = new RecapService({
  repository: recapRepository,
  analytics,
  ...(ai ? { ai } : {}),
});
const projectionImports = new ProjectionImportService(
  new DrizzleProjectionImportRepository(database.db),
);
const refreshAuthorization = new DrizzleRefreshAuthorization(database.db);
const rosProjectionStatus = new RosProjectionStatusService(database.db);
const rankings = environment.SESSION_SECRET
  ? new RankingService(
      new DrizzleRankingRepository(database.db),
      deriveRankingShareKeyring(Buffer.from(environment.SESSION_SECRET, "utf8")),
    )
  : undefined;
// SMTP support and verification enforcement roll out independently. `app` is bound lazily in
// these callbacks; nothing sends before it listens.
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
        (failure: SmtpSendFailure) => app.log.warn(failure, "outbound email send failed"),
      )
    : undefined;
const emailVerificationEnabled =
  environment.EMAIL_VERIFICATION_ENABLED && emailTransport !== undefined;
const registrationRepository = new DrizzleRegistrationRepository(database.db);
const registration =
  environment.SESSION_SECRET &&
  (environment.REGISTRATION_OPEN || environment.REGISTRATION_INVITE_CODE)
    ? new RegistrationService(
        registrationRepository,
        environment.SESSION_SECRET,
        environment.REGISTRATION_OPEN ? undefined : environment.REGISTRATION_INVITE_CODE,
        emailVerificationEnabled && emailTransport
          ? {
              confirmation: {
                repository: registrationRepository,
                delivery: createEmailConfirmationDelivery(emailTransport),
                webUrl: environment.WEB_URL,
                onDeliveryError: (error: unknown) =>
                  app.log.warn({ err: error }, "confirmation email failed"),
              },
            }
          : {},
      )
    : undefined;
const emailVerification = emailTransport
  ? new EmailVerificationService({
      repository: new DrizzleEmailVerificationRepository(database.db),
      delivery: createEmailConfirmationDelivery(emailTransport),
      webUrl: environment.WEB_URL,
    })
  : undefined;
const invitations = environment.SESSION_SECRET
  ? new InvitationService(
      new DrizzleInvitationRepository(database.db),
      deriveInvitationKeyring(environment.SESSION_SECRET),
      emailVerificationEnabled && emailTransport
        ? {
            confirmation: {
              delivery: createEmailConfirmationDelivery(emailTransport),
              webUrl: environment.WEB_URL,
              onDeliveryError: (error: unknown) =>
                app.log.warn({ err: error }, "invitation confirmation email failed"),
            },
          }
        : {},
    )
  : undefined;
const passwordReset = emailTransport
  ? new PasswordResetService({
      repository: new DrizzlePasswordResetRepository(database.db),
      delivery: createPasswordResetEmailDelivery(emailTransport),
      webUrl: environment.WEB_URL,
    })
  : undefined;
const yahooSync = yahooConnection
  ? new YahooSyncService({
      repository: new DrizzleYahooSyncRepository(database.db),
      tokens: yahooConnection,
    })
  : undefined;
const yahooDraftPoll =
  environment.YAHOO_AUTOMATED_SYNC_ENABLED && yahooConnection
    ? new YahooDraftPollService({
        repository: yahooDraftRepository,
        sessions: draftSessions,
        tokens: yahooConnection,
      })
    : undefined;
const jobs = new PgBoss({
  connectionString: environment.DATABASE_URL,
  application_name: "fantasy-api-jobs",
  schema: "pgboss",
  supervise: false,
  // Scheduling stays in the lightweight API process. Projection assembly can occupy the worker's
  // event loop for twenty minutes; letting that process own cron silently dropped one-minute
  // schedule windows while a model run was active.
  schedule: true,
});
await jobs.start();
// One registration function for both processes. The API used to hand-copy two queue definitions
// here and had already lost the dead-letter target and retention settings the worker applied.
await registerQueues(jobs);
await registerSchedules(jobs, currentNflSeason());
await ensureDailyRefresh(jobs);
const espnRefresh = new EspnRefreshCoordinator(new DrizzleEspnRefreshRepository(database.db), {
  directEnabled: environment.ESPN_PUBLIC_DIRECT_SYNC_ENABLED,
  enqueueDirect: ({ leagueSeasonId, refreshRequestId }) =>
    enqueueLeagueSync(jobs, {
      mode: "server-direct",
      leagueSeasonId,
      refreshRequestId,
      reason: "stale-on-view",
      probe: false,
    }),
  ...(environment.ESPN_SERVER_SESSION_SYNC_ENABLED && espnSessionConnections
    ? {
        enqueueSession: ({ connectionId, leagueSeasonId, refreshRequestId }) =>
          enqueueLeagueSync(jobs, {
            mode: "connection",
            connectionId,
            leagueSeasonId,
            refreshRequestId,
            reason: "stale-on-view",
          }),
      }
    : {}),
});
const app = await buildApp({
  environment,
  authService,
  accountData,
  browserHandoffs,
  draftSessions,
  draftMarket,
  draftAnalysis,
  ...(yahooDraftPoll ? { draftProviderRefresh: yahooDraftPoll } : {}),
  // Same service, two doors: bridge-authenticated ingest and the cookie-authenticated freeze.
  draftManualBackup: espnLiveDraft,
  espnBridge,
  ...(espnSessionConnections ? { espnSessionConnections } : {}),
  espnRefresh,
  espnLiveDraft,
  decisions,
  analytics,
  statsCenter,
  schedule,
  scheduleEdge,
  changeEvents,
  changeEventProducers,
  dataQuality,
  preferences,
  push,
  ...(ai ? { ai } : {}),
  recaps,
  ...(invitations ? { invitations } : {}),
  leagueDashboard,
  leagueMemberships,
  projectionImports,
  refreshAuthorization,
  ...(rankings ? { rankings } : {}),
  rosProjectionStatus,
  ...(registration ? { registration } : {}),
  ...(emailVerification ? { emailVerification } : {}),
  ...(passwordReset ? { passwordReset } : {}),
  ...(yahooConnection ? { yahooConnection } : {}),
  ...(yahooSync ? { yahooSync } : {}),
  yahooNativeConnectLandingAvailable: true,
  // Queue and schedule registration completed above; the worker uses this same fail-closed flag.
  yahooAutomatedSyncAvailable: environment.YAHOO_AUTOMATED_SYNC_ENABLED && yahooSync !== undefined,
  requireAuthentication: true,
  readinessCheck: async () => {
    try {
      await database.db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  },
  enqueueRefresh: async ({ requestedBy, refresh, requestedAt }) =>
    enqueueDataRefresh(jobs, {
      requestedBy,
      scope: refresh.scope,
      reason: "user",
      requestedAt: requestedAt.toISOString(),
    }),
  enqueueProjectionRefresh: async ({ season }) =>
    enqueueProjectionRefresh(jobs, { season, horizon: "weekly", reason: "on-demand" }),
  ...(environment.ESPN_SERVER_SESSION_SYNC_ENABLED && espnSessionConnections
    ? {
        enqueueEspnIdentityBootstrap: async ({ connectionId, leagueSeasonId }) =>
          enqueueLeagueSync(jobs, {
            mode: "connection",
            connectionId,
            leagueSeasonId,
            reason: "identity-bootstrap",
          }),
      }
    : {}),
  enqueueRecommendationRecompute: async ({ leagueSeasonId, kinds }) =>
    enqueueRecommendationRecompute(jobs, { leagueSeasonId, kinds }),
});
app.addHook("onClose", async () => {
  await jobs.stop({ graceful: true, timeout: 10_000 });
  await database.close();
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down API");
  await app.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: "0.0.0.0", port: environment.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "API failed to start");
  process.exitCode = 1;
}
