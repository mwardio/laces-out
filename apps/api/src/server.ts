import { loadEnvironment } from "@fantasy/config";
import { createDatabase } from "@fantasy/db";
import { parseCredentialKey } from "@fantasy/security";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";

import { buildApp } from "./app.js";
import { createAiProviderAdapters } from "./ai-provider-adapters.js";
import { AiService, DrizzleAiRepository } from "./ai-service.js";
import { DrizzleAuthRepository } from "./auth-repository.js";
import { AuthService } from "./auth.js";
import { DraftSessionService, DrizzleDraftSessionRepository } from "./draft-session.js";
import { DraftMarketService } from "./draft-market.js";
import { EspnBridgeService } from "./espn-bridge.js";
import { DrizzleEspnLiveDraftRepository } from "./espn-live-draft-persistence.js";
import { EspnLiveDraftService } from "./espn-live-draft-service.js";
import { DrizzleEspnSyncPersistence } from "./espn-sync-persistence.js";
import {
  DrizzleInSeasonDecisionRepository,
  InSeasonDecisionService,
} from "./in-season-decisions.js";
import { DrizzleLeagueAnalyticsRepository, LeagueAnalyticsService } from "./league-analytics.js";
import { DrizzleInvitationRepository } from "./invitation-repository.js";
import { deriveInvitationKeyring, InvitationService } from "./invitation.js";
import { DrizzleLeagueDashboardRepository, LeagueDashboardService } from "./league-dashboard.js";
import { DrizzleProjectionImportRepository, ProjectionImportService } from "./projection-import.js";
import { DrizzleRefreshAuthorization } from "./refresh-authorization.js";
import { RosProjectionStatusService } from "./ros-projection-status.js";
import { DrizzleRankingRepository } from "./ranking-repository.js";
import { deriveRankingShareKeyring, RankingService } from "./ranking-service.js";
import { DrizzleRegistrationRepository } from "./registration-repository.js";
import { RegistrationService } from "./registration.js";
import { DrizzlePreferencesRepository, PreferencesService } from "./preferences.js";
import { DrizzleScheduleRepository, ScheduleService } from "./schedule.js";
import { DrizzleStatsCenterRepository, StatsCenterService } from "./stats-center.js";
import { YahooConnectionService } from "./yahoo-connection.js";
import { DrizzleYahooSyncRepository, YahooSyncService } from "./yahoo-sync.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL);
const credentialKey = environment.CREDENTIAL_ENCRYPTION_KEY
  ? parseCredentialKey(environment.CREDENTIAL_ENCRYPTION_KEY)
  : undefined;
const authService = new AuthService(new DrizzleAuthRepository(database.db));
const espnLiveDraftRepository = new DrizzleEspnLiveDraftRepository(database.db);
const draftSessions = new DraftSessionService(
  new DrizzleDraftSessionRepository(database.db, espnLiveDraftRepository),
);
const draftMarket = new DraftMarketService(database.db);
const espnPersistence = new DrizzleEspnSyncPersistence(database.db);
const espnBridge = new EspnBridgeService(database.db, () => new Date(), espnPersistence);
// Constructed unconditionally so the flag is enforced in one place inside the service; the route
// still serves 503 for a deployment that has never configured live draft sync at all.
const espnLiveDraft = new EspnLiveDraftService(espnLiveDraftRepository, {
  enabled: environment.ESPN_LIVE_DRAFT_SYNC,
});
const decisions = new InSeasonDecisionService(new DrizzleInSeasonDecisionRepository(database.db));
const analytics = new LeagueAnalyticsService(new DrizzleLeagueAnalyticsRepository(database.db));
const schedule = new ScheduleService(new DrizzleScheduleRepository(database.db));
const preferences = new PreferencesService(new DrizzlePreferencesRepository(database.db));
// The schedule doubles as the bye source so a player's game log can mark an idle week.
const statsCenter = new StatsCenterService(
  new DrizzleStatsCenterRepository(database.db),
  () => new Date(),
  schedule,
);
const invitations = environment.SESSION_SECRET
  ? new InvitationService(
      new DrizzleInvitationRepository(database.db),
      deriveInvitationKeyring(environment.SESSION_SECRET),
    )
  : undefined;
const leagueDashboard = new LeagueDashboardService(
  new DrizzleLeagueDashboardRepository(database.db),
);
const ai = credentialKey
  ? new AiService({
      repository: new DrizzleAiRepository(database.db),
      credentialKey,
      adapters: createAiProviderAdapters(environment.WEB_URL),
      leagueDashboard,
      decisions,
      analytics,
      ...(environment.GEMINI_API_KEY
        ? {
            managedGemini: {
              apiKey: environment.GEMINI_API_KEY,
              dailyRequestLimit: environment.MANAGED_AI_DAILY_REQUEST_LIMIT,
              maxOutputTokens: environment.MANAGED_AI_MAX_OUTPUT_TOKENS,
            },
          }
        : {}),
    })
  : undefined;
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
const registration =
  environment.SESSION_SECRET && environment.REGISTRATION_INVITE_CODE
    ? new RegistrationService(
        new DrizzleRegistrationRepository(database.db),
        environment.SESSION_SECRET,
        environment.REGISTRATION_INVITE_CODE,
      )
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
const jobs = new PgBoss({
  connectionString: environment.DATABASE_URL,
  application_name: "fantasy-api-jobs",
  schema: "pgboss",
  supervise: false,
  schedule: false,
});
await jobs.start();
await jobs.createQueue("data-refresh", {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  warningQueueSize: 10,
});
await jobs.createQueue("projection-refresh", {
  retryLimit: 4,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 30 * 60,
  expireInSeconds: 30 * 60,
  warningQueueSize: 10,
});
const app = await buildApp({
  environment,
  authService,
  draftSessions,
  draftMarket,
  // Same service, two doors: bridge-authenticated ingest and the cookie-authenticated freeze.
  draftManualBackup: espnLiveDraft,
  espnBridge,
  espnLiveDraft,
  decisions,
  analytics,
  statsCenter,
  schedule,
  preferences,
  ...(ai ? { ai } : {}),
  ...(invitations ? { invitations } : {}),
  leagueDashboard,
  projectionImports,
  refreshAuthorization,
  ...(rankings ? { rankings } : {}),
  rosProjectionStatus,
  ...(registration ? { registration } : {}),
  ...(yahooConnection ? { yahooConnection } : {}),
  ...(yahooSync ? { yahooSync } : {}),
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
    jobs.send(
      "data-refresh",
      {
        requestedBy,
        scope: refresh.scope,
        reason: "user",
        requestedAt: requestedAt.toISOString(),
      },
      {
        singletonKey: "shared-nfl-data",
        singletonSeconds: 60,
      },
    ),
  enqueueProjectionRefresh: async ({ season }) =>
    jobs.send(
      "projection-refresh",
      { season },
      {
        group: { id: "projections" },
        singletonKey: `projection-refresh:${season}:season`,
        singletonSeconds: 60,
      },
    ),
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
