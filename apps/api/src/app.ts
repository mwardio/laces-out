import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { loadEnvironment, type Environment } from "@fantasy/config";
import type { RecommendationKind } from "@fantasy/jobs";
import {
  espnBridgeDeviceRequestSchema,
  espnBridgeDeviceListResponseSchema,
  espnBridgeDeviceRevokeResponseSchema,
  espnBridgeDeviceResponseSchema,
  espnBridgePairingRedeemRequestSchema,
  espnBridgePairingRedeemResponseSchema,
  espnBridgePairingSessionRequestSchema,
  espnBridgePairingSessionResponseSchema,
  espnBridgeReceiptSchema,
  espnBridgeSnapshotSchema,
  espnLeagueRefreshRequestSchema,
  espnLeagueRefreshStatusSchema,
  espnRefreshAgentAttemptRequestSchema,
  espnRefreshAgentAttemptResponseSchema,
  espnRefreshAgentPollRequestSchema,
  espnRefreshAgentPollResponseSchema,
  espnLiveDraftIngestRequestSchema,
  espnLiveDraftIngestResponseSchema,
  espnSupplementalBridgeSnapshotSchema,
  ESPN_LIVE_DRAFT_LIMITS,
  healthResponseSchema,
  jobAcceptedSchema,
  leagueDashboardSchema,
  leagueListResponseSchema,
  problemDetailsSchema,
  refreshRequestSchema,
  teamClaimRequestSchema,
  teamClaimResponseSchema,
  YAHOO_IOS_COMPLETION_URLS,
  yahooAuthorizeRequestSchema,
  yahooAuthorizeResponseSchema,
  type EspnBridgeSnapshot,
  type EspnLeagueRefreshStatus,
  type EspnRefreshAgentPollResponse,
  type EspnLiveDraftIngestRequest,
  type EspnLiveDraftIngestResponse,
  type EspnSupplementalBridgeSnapshot,
  type LeagueDashboard,
  type LeagueListResponse,
  type MobileCapability,
  type RefreshRequest,
  type TeamClaimResponse,
  type YahooAuthorizeRequest,
  type YahooIosCompletionStatus,
  type YahooReturnMode,
} from "@fantasy/contracts";
import {
  EspnSupplementalNormalizationError,
  EspnWebClientNormalizationError,
} from "@fantasy/connector-espn";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z, ZodError } from "zod";

import { sessionCookieName, sessionLifetimeSeconds, type AuthService } from "./auth.js";
import { type AiServicePort, registerAiRoutes } from "./ai-routes.js";
import { getDemoDashboard } from "./demo.js";
import {
  type DraftAnalysisPort,
  type DraftManualBackupPort,
  type DraftMarketPort,
  type DraftSessionPort,
  registerDraftRoutes,
} from "./draft-routes.js";
import { DraftStreamHub } from "./draft-stream.js";
import { type InvitationPort, registerInvitationRoutes } from "./invitation-routes.js";
import {
  type InSeasonDecisionPort,
  registerInSeasonDecisionRoutes,
} from "./in-season-decision-routes.js";
import {
  type LeagueAnalyticsPort,
  registerLeagueAnalyticsRoutes,
} from "./league-analytics-routes.js";
import {
  type ProjectionImportPort,
  registerProjectionImportRoutes,
} from "./projection-import-routes.js";
import { type RankingPort, registerRankingRoutes } from "./ranking-routes.js";
import { type RecapRoutePort, registerRecapRoutes } from "./recap-routes.js";
import {
  type RosProjectionStatusPort,
  registerRosProjectionStatusRoutes,
} from "./ros-projection-status-routes.js";
import { type ScheduleEdgePort, registerScheduleEdgeRoutes } from "./schedule-edge-routes.js";
import { type ChangeEventPort, registerChangeEventRoutes } from "./change-event-routes.js";
import {
  emitProviderSyncChangeEvents,
  type ChangeEventProducerDependencies,
} from "./change-event-producers.js";
import { type DataQualityPort, registerDataQualityRoutes } from "./data-quality-routes.js";
import type { RefreshAuthorizationPort } from "./refresh-authorization.js";
import { type RegistrationPort, registerRegistrationRoutes } from "./registration-routes.js";
import { type PreferencesPort, registerAccountRoutes } from "./account-routes.js";
import type { AccountDataPort } from "./account-data.js";
import {
  browserHandoffConfirmPath,
  browserHandoffConsumePath,
  browserHandoffLandingPath,
  browserHandoffStagePath,
  registerBrowserHandoffRoutes,
} from "./browser-handoff-routes.js";
import { browserHandoffOriginsCompatible, type BrowserHandoffPort } from "./browser-handoff.js";
import { type PushPort, registerPushRoutes } from "./push-routes.js";
import { type SchedulePort, registerScheduleRoutes } from "./schedule-routes.js";
import { type StatsCenterPort, registerStatsCenterRoutes } from "./stats-center-routes.js";
import { YahooConnectionCallbackError } from "./yahoo-connection.js";
import { registerYahooRoutes } from "./yahoo-routes.js";
import type { YahooSyncPort } from "./yahoo-sync.js";

export interface YahooConnectionPort {
  start(
    userId: string,
    input: YahooAuthorizeRequest,
  ): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }>;
  deny(
    userId: string,
    state: string,
  ): Promise<{ readonly returnMode: YahooReturnMode; readonly returnTo: string }>;
  complete(
    userId: string,
    input: { readonly code: string; readonly state: string },
  ): Promise<{
    readonly connectionId: string;
    readonly returnMode: YahooReturnMode;
    readonly returnTo: string;
  }>;
}

export interface EspnBridgePort {
  listDevices(userId: string): Promise<{
    readonly generatedAt: string;
    readonly devices: readonly {
      readonly deviceId: string;
      readonly clientKind: "chrome-extension" | "ios-app";
      readonly agentCapable: boolean;
      readonly name: string;
      readonly state: "active" | "expired" | "revoked";
      readonly allowedLeagues: readonly {
        readonly externalLeagueId: string;
        readonly season: number | null;
        readonly leagueId: string | null;
        readonly leagueName: string | null;
      }[];
      readonly createdAt: string;
      readonly expiresAt: string | null;
      readonly lastSeenAt: string | null;
      readonly revokedAt: string | null;
    }[];
  }>;
  registerDevice(
    userId: string,
    input: {
      readonly name: string;
      readonly clientKind: "chrome-extension" | "ios-app";
      readonly agentCapabilities: readonly "refresh-intents-v1"[];
      readonly season?: number;
      readonly allowedLeagueIds: readonly string[];
    },
  ): Promise<{
    readonly deviceId: string;
    readonly clientKind: "chrome-extension" | "ios-app";
    readonly agentCapable: boolean;
    readonly deviceToken: string;
    readonly expiresAt: string | null;
  }>;
  createPairingSession?(
    userId: string,
    input: {
      readonly name: string;
      readonly agentCapabilities: readonly "refresh-intents-v1"[];
      readonly allowedLeagueIds: readonly string[];
      readonly season: number;
    },
  ): Promise<{ readonly pairingCode: string; readonly expiresAt: string }>;
  redeemPairingSession?(pairingCode: string): Promise<
    | {
        readonly deviceId: string;
        readonly clientKind: "chrome-extension";
        readonly agentCapable: true;
        readonly deviceToken: string;
        readonly expiresAt: string;
        readonly leagueIds: readonly string[];
        readonly season: number;
        readonly automaticSync: true;
      }
    | undefined
  >;
  acceptSnapshot(
    deviceToken: string,
    snapshot: EspnBridgeSnapshot,
  ): Promise<{
    readonly receiptId: string;
    readonly state: "accepted" | "unchanged";
    readonly receivedAt: string;
    /**
     * Internal only — `espnBridgeReceiptSchema` strips it from the wire response. The route needs
     * it to enqueue the downstream recomputation for the league season the payload actually landed
     * in, rather than re-deriving one from the untrusted external league id.
     */
    readonly leagueSeasonId?: string;
  }>;
  acceptSupplementalSnapshot?(
    deviceToken: string,
    snapshot: EspnSupplementalBridgeSnapshot,
  ): Promise<{
    readonly receiptId: string;
    readonly state: "accepted" | "unchanged";
    readonly receivedAt: string;
    readonly leagueSeasonId?: string;
  }>;
  revokeDevice(
    userId: string,
    deviceId: string,
  ): Promise<{ readonly deviceId: string; readonly revokedAt: string } | undefined>;
}

export interface EspnRefreshPort {
  requestRefresh(userId: string, leagueSeasonId: string): Promise<EspnLeagueRefreshStatus>;
  getStatus(userId: string, leagueSeasonId: string): Promise<EspnLeagueRefreshStatus>;
  pollAgent(deviceToken: string): Promise<EspnRefreshAgentPollResponse>;
  reportAgentAttempt(
    deviceToken: string,
    requestId: string,
    input: {
      readonly state: "started" | "login-required" | "retryable-error" | "rejected";
      readonly errorCode?: string;
      readonly detail?: string;
    },
  ): Promise<{ readonly attemptId: string; readonly state: string; readonly recordedAt: string }>;
}

/**
 * Optional so a deployment with the flag off — or an existing test fake — simply serves 503 for
 * live draft ingest while every other ESPN path keeps working.
 */
export interface EspnLiveDraftPort {
  ingest(
    deviceToken: string,
    request: EspnLiveDraftIngestRequest,
  ): Promise<EspnLiveDraftIngestResponse>;
}

export interface LeagueDashboardPort {
  listLeagues(userId: string): Promise<LeagueListResponse>;
  getDashboard(userId: string, leagueId: string): Promise<LeagueDashboard | undefined>;
  claimTeam(userId: string, leagueId: string, teamId: string): Promise<TeamClaimResponse>;
}

export interface BuildAppOptions {
  readonly environment?: Environment;
  readonly logger?: boolean;
  readonly authService?: AuthService;
  readonly requireAuthentication?: boolean;
  readonly readinessCheck?: () => Promise<boolean>;
  readonly draftSessions?: DraftSessionPort;
  readonly draftMarket?: DraftMarketPort;
  readonly draftAnalysis?: DraftAnalysisPort;
  readonly draftManualBackup?: DraftManualBackupPort;
  readonly espnBridge?: EspnBridgePort;
  readonly espnRefresh?: EspnRefreshPort;
  readonly espnLiveDraft?: EspnLiveDraftPort;
  readonly draftStream?: DraftStreamHub;
  readonly invitations?: InvitationPort;
  readonly decisions?: InSeasonDecisionPort;
  readonly analytics?: LeagueAnalyticsPort;
  readonly ai?: AiServicePort;
  readonly recaps?: RecapRoutePort;
  readonly leagueDashboard?: LeagueDashboardPort;
  readonly projectionImports?: ProjectionImportPort;
  readonly rankings?: RankingPort;
  readonly rosProjectionStatus?: RosProjectionStatusPort;
  readonly scheduleEdge?: ScheduleEdgePort;
  readonly changeEvents?: ChangeEventPort;
  readonly changeEventProducers?: ChangeEventProducerDependencies;
  readonly dataQuality?: DataQualityPort;
  readonly refreshAuthorization?: RefreshAuthorizationPort;
  readonly registration?: RegistrationPort;
  readonly preferences?: PreferencesPort;
  readonly accountData?: AccountDataPort;
  readonly browserHandoffs?: BrowserHandoffPort;
  readonly push?: PushPort;
  readonly schedule?: SchedulePort;
  readonly statsCenter?: StatsCenterPort;
  readonly yahooConnection?: YahooConnectionPort;
  readonly yahooSync?: YahooSyncPort;
  /** Set by the composed web/API deployment that includes `/connections/yahoo/connect`. */
  readonly yahooNativeConnectLandingAvailable?: boolean;
  /**
   * Set only after the provider-neutral recurring schedule and Yahoo-capable worker path have been
   * composed. The environment flag is checked independently so a test fake cannot advertise it.
   */
  readonly yahooAutomatedSyncAvailable?: boolean;
  readonly enqueueRefresh?: (request: {
    readonly requestedBy: string;
    readonly refresh: Extract<RefreshRequest, { scope: "player-data" | "adp-data" }>;
    readonly requestedAt: Date;
  }) => Promise<string | null>;
  readonly enqueueProjectionRefresh?: (request: {
    readonly season: number;
    readonly reason: "league-sync";
    readonly requestedAt: Date;
  }) => Promise<string | null>;
  /**
   * Queued after a provider ingestion that actually changed something. A duplicate payload returns
   * `state: "unchanged"` and enqueues nothing, which is what keeps one ingestion to one run.
   */
  readonly enqueueRecommendationRecompute?: (request: {
    readonly leagueSeasonId: string;
    readonly kinds: readonly RecommendationKind[];
    readonly requestedAt: Date;
  }) => Promise<string | null>;
}

/**
 * Every in-season kind a provider ingestion can invalidate. `draft` is excluded deliberately: it has
 * no in-season producer, and the recompute rejects it by name rather than silently ignoring it.
 */
const INGESTION_RECOMPUTE_KINDS: readonly RecommendationKind[] = ["lineup", "trade", "waiver"];

/** Public compatibility declaration used by native clients before accepting a self-hosted URL. */
const MOBILE_API_VERSION = 1;
const MOBILE_CAPABILITIES = [
  "account-data-export",
  "account-deletion",
  "activity-feed",
  "cookie-authentication",
  "in-season-decisions",
  "league-analytics",
  "league-dashboard",
  "league-portfolio",
  "espn-automated-refresh",
  "espn-sync-agent-v1",
  "weekly-reckoning",
] as const;

/**
 * A queue outage must not fail an ingestion that already committed. Matches the existing
 * projection-refresh guard: warn and continue.
 */
async function enqueueRecomputeAfterIngestion(
  options: BuildAppOptions,
  leagueSeasonId: string | undefined,
  request: FastifyRequest,
): Promise<void> {
  if (!options.enqueueRecommendationRecompute || !leagueSeasonId) return;
  try {
    await options.enqueueRecommendationRecompute({
      leagueSeasonId,
      kinds: INGESTION_RECOMPUTE_KINDS,
      requestedAt: new Date(),
    });
  } catch (error) {
    request.log.warn(
      { err: error, leagueSeasonId },
      "provider ingestion succeeded but recommendation recompute enqueue failed",
    );
  }
}

/**
 * The OAuth callback's own emit seam. Gated on `state === "accepted"` inside the producer, and
 * failures are swallowed there, so a change-event problem cannot break the redirect back to the app.
 */
async function emitYahooCallbackChangeEvents(
  options: BuildAppOptions,
  syncs: readonly {
    readonly state: "accepted" | "unchanged";
    readonly leagueId: string;
    readonly leagueSeasonId: string;
    readonly syncRunId: string;
  }[],
  request: FastifyRequest,
): Promise<void> {
  const producers = options.changeEventProducers;
  if (!producers) return;
  const now = new Date();
  for (const sync of syncs) {
    await emitProviderSyncChangeEvents(
      producers,
      {
        provider: "yahoo",
        state: sync.state,
        leagueId: sync.leagueId,
        leagueSeasonId: sync.leagueSeasonId,
        actorUserId: null,
        artifactId: sync.syncRunId,
        occurredAt: now,
      },
      (error) =>
        request.log.warn(
          { err: error, leagueSeasonId: sync.leagueSeasonId },
          "Yahoo authorization sync succeeded but change-event emission failed",
        ),
    );
  }
}

const version = "0.1.0";

export function requestPathForLog(rawUrl: string | undefined): string {
  if (!rawUrl) return "";
  const queryStart = rawUrl.indexOf("?");
  return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}

function applicationRedirect(webUrl: string, returnTo: string): URL {
  const base = new URL(webUrl);
  const destination = new URL(returnTo, base);
  if (destination.origin !== base.origin) {
    throw new Error("Connection callback attempted a cross-origin redirect");
  }
  return destination;
}

type YahooCompletionTarget = {
  readonly returnMode: YahooReturnMode;
  readonly returnTo: string;
};

function browserYahooCompletionUrl(
  webUrl: string,
  status: "connected" | "denied" | "unavailable" | "error",
): string {
  const destination = new URL("/connections", webUrl);
  destination.searchParams.set("provider", "yahoo");
  destination.searchParams.set("status", status);
  return destination.toString();
}

function yahooNativeProviderErrorStatus(error: string | undefined): YahooIosCompletionStatus {
  if (error === "access_denied") return "denied";
  if (error === "server_error" || error === "temporarily_unavailable") return "unavailable";
  return "failed";
}

function redirectYahooWithoutReferrer(reply: FastifyReply, destination: string) {
  void reply.header("referrer-policy", "no-referrer");
  return reply.redirect(destination);
}

function yahooCompletionRedirect(
  reply: FastifyReply,
  environment: Environment,
  completion: YahooCompletionTarget,
  status: YahooIosCompletionStatus,
  browserParameters: Readonly<Record<string, string>> = {},
) {
  if (completion.returnMode === "ios-app") {
    return redirectYahooWithoutReferrer(reply, YAHOO_IOS_COMPLETION_URLS[status]);
  }
  const browserStatus = status === "failed" ? "error" : status;
  const destination = applicationRedirect(environment.WEB_URL, completion.returnTo);
  destination.searchParams.set("provider", "yahoo");
  destination.searchParams.set("status", browserStatus);
  for (const [name, value] of Object.entries(browserParameters)) {
    destination.searchParams.set(name, value);
  }
  return redirectYahooWithoutReferrer(reply, destination.toString());
}

function loginAccountRateLimitKey(body: unknown, fallbackIp: string): string {
  const candidate =
    typeof body === "object" && body !== null && "email" in body && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : `invalid:${fallbackIp}`;
  const digest = createHash("sha256").update(candidate, "utf8").digest("base64url");
  return `login-account:${digest}`;
}

function bridgeDeviceRateLimitKey(request: FastifyRequest, operation: string): string {
  const match = /^Bridge ([A-Za-z0-9._~-]{32,512})$/u.exec(request.headers.authorization ?? "");
  const identity = match?.[1] ?? `invalid:${request.ip}`;
  const digest = createHash("sha256").update(identity, "utf8").digest("base64url");
  return `espn-device:${operation}:${digest}`;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const environment = options.environment ?? loadEnvironment();
  const browserHandoffs =
    options.browserHandoffs &&
    browserHandoffOriginsCompatible(environment.API_URL, environment.WEB_URL)
      ? options.browserHandoffs
      : undefined;
  const requireAuthentication =
    options.requireAuthentication ?? environment.NODE_ENV === "production";
  if (requireAuthentication && !options.authService) {
    throw new Error("Authentication is required but no AuthService was configured");
  }
  const mobileCapabilities: MobileCapability[] = [...MOBILE_CAPABILITIES];
  if (browserHandoffs) mobileCapabilities.push("authenticated-browser-handoff");
  if (
    browserHandoffs &&
    options.authService &&
    options.yahooConnection &&
    options.yahooSync &&
    options.yahooNativeConnectLandingAvailable === true
  ) {
    mobileCapabilities.push("yahoo-native-connect-v1");
  }
  if (
    environment.YAHOO_AUTOMATED_SYNC_ENABLED &&
    options.yahooConnection &&
    options.yahooSync &&
    options.yahooAutomatedSyncAvailable === true
  ) {
    mobileCapabilities.push("yahoo-automated-sync");
  }
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: environment.LOG_LEVEL,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "res.headers.set-cookie",
                "*.access_token",
                "*.refresh_token",
                "*.espn_s2",
                "*.swid",
                "req.body.token",
                // A push endpoint and its two keys are bearer material for that browser's push
                // service. They are stored, used once per send, and never written to a log.
                "req.body.endpoint",
                "req.body.keys.p256dh",
                "req.body.keys.auth",
                "req.body.inviteCode",
                "req.body.password",
                "req.body.apiKey",
                "req.body.pairingCode",
                "*.inviteCode",
                "req.body.*.inviteCode",
                "*.password",
                "req.body.*.password",
              ],
              censor: "[REDACTED]",
            },
            serializers: {
              req(request) {
                return {
                  method: request.method,
                  url: requestPathForLog(request.url),
                  host: request.headers.host ?? "",
                  remoteAddress: request.socket.remoteAddress ?? "",
                  remotePort: request.socket.remotePort ?? 0,
                };
              },
            },
          },
    genReqId: (request) => {
      const candidate = request.headers["x-request-id"];
      return typeof candidate === "string" && candidate.length <= 128
        ? candidate
        : crypto.randomUUID();
    },
    requestIdHeader: "x-request-id",
    trustProxy: environment.NODE_ENV === "production" ? 1 : false,
    bodyLimit: 1_048_576,
  });
  app.decorateRequest("currentUser", undefined);

  const draftStream = options.draftStream ?? new DraftStreamHub();

  // Device-token authenticated ingest paths. Kept in one place because each of them has to be
  // reflected in three otherwise-independent gates below: CORS, the production origin check, and
  // the session-cookie allowlist. Adding a path to only two of the three fails quietly.
  const espnBridgeIngestPaths: readonly string[] = [
    "/v1/bridge/espn/snapshots",
    "/v1/bridge/espn/supplemental",
    "/v1/bridge/espn/live-draft",
    "/v1/bridge/espn/refresh-requests/poll",
  ];
  const espnBridgeAttemptPath = /^\/v1\/bridge\/espn\/refresh-requests\/[0-9a-f-]{36}\/attempts$/iu;
  const isEspnBridgeDevicePath = (requestPath: string): boolean =>
    espnBridgeIngestPaths.includes(requestPath) || espnBridgeAttemptPath.test(requestPath);
  const espnBridgePairingRedeemPath = "/v1/bridge/espn/pairing-sessions/redeem";

  // The browser origins this deployment answers to: the canonical WEB_URL plus any second domain
  // pointed at the same stack. Membership in this set is the only thing the extra origins buy —
  // links the API builds stay on WEB_URL.
  const allowedWebOrigins: ReadonlySet<string> = new Set([
    environment.WEB_URL,
    ...environment.ADDITIONAL_WEB_ORIGINS,
  ]);
  const apiOrigin = new URL(environment.API_URL).origin;
  const allowedWebOrigin = (origin: string | undefined): string | undefined =>
    typeof origin === "string" && allowedWebOrigins.has(origin) ? origin : undefined;

  await app.register(cors, {
    delegator: (request, callback) => {
      const requestPath = request.url.split("?", 1)[0] ?? request.url;
      const fromEspnBridge = isEspnBridgeDevicePath(requestPath);
      callback(null, {
        // An allowed origin is reflected back so each domain is told it — and only it — is
        // permitted. `@fastify/cors` always emits `Vary: Origin` for a delegator, so a shared cache
        // cannot serve one domain's allowance to another.
        origin: fromEspnBridge
          ? "https://fantasy.espn.com"
          : (allowedWebOrigin(request.headers.origin) ?? environment.WEB_URL),
        credentials: !fromEspnBridge,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      });
    },
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(rateLimit, {
    max: environment.NODE_ENV === "test" ? 10_000 : 120,
    timeWindow: "1 minute",
  });
  const loginAccountRateLimit = app.createRateLimit({
    max: 5,
    timeWindow: "1 minute",
    keyGenerator: (request) => loginAccountRateLimitKey(request.body, request.ip),
  });
  const memberEspnRefreshRateLimit = app.createRateLimit({
    max: 12,
    timeWindow: "1 minute",
    keyGenerator: (request) =>
      `espn-member-refresh:${request.currentUser?.id ?? `anonymous:${request.ip}`}:${requestPathForLog(request.url)}`,
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    void reply.header("cache-control", "no-store");
    return payload;
  });

  const publicPaths = new Set([
    "/health/live",
    "/health/ready",
    "/v1/auth/login",
    "/v1/auth/logout",
    "/v1/auth/register",
    "/v1/auth/session",
    browserHandoffLandingPath,
    browserHandoffStagePath,
    browserHandoffConfirmPath,
    browserHandoffConsumePath,
    ...espnBridgeIngestPaths,
    espnBridgePairingRedeemPath,
    "/v1/invitations/inspect",
    "/v1/invitations/accept",
    "/v1/ranking-shares/open",
    "/v1/ranking-shares/export",
    "/v1/schedule",
    "/v1/schedule/byes",
  ]);
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?", 1)[0] ?? request.url;
    const isBridgeSnapshot = isEspnBridgeDevicePath(requestPath);
    const isBridgeCredentialExchange = requestPath === espnBridgePairingRedeemPath;
    const isBrowserHandoffStage = requestPath === browserHandoffStagePath;
    const isBrowserHandoffConfirmFromLanding =
      requestPath === browserHandoffConfirmPath && request.headers.origin === apiOrigin;
    if (
      environment.NODE_ENV === "production" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !isBridgeSnapshot &&
      !isBridgeCredentialExchange &&
      !isBrowserHandoffStage &&
      !isBrowserHandoffConfirmFromLanding
    ) {
      if (allowedWebOrigin(request.headers.origin) === undefined) {
        return reply.code(403).type("application/problem+json").send({
          type: "https://fantasy.local/problems/origin",
          title: "Request origin rejected",
          status: 403,
          correlationId: request.id,
        });
      }
    }

    if (publicPaths.has(requestPath) || isEspnBridgeDevicePath(requestPath)) {
      return;
    }
    const user = await options.authService?.validate(request.cookies[sessionCookieName]);
    if (user) {
      request.currentUser = user;
      return;
    }
    if (!requireAuthentication) return;
    return reply.code(401).type("application/problem+json").send({
      type: "https://fantasy.local/problems/unauthorized",
      title: "Authentication required",
      status: 401,
      correlationId: request.id,
    });
  });

  app.get("/health/live", () =>
    healthResponseSchema.parse({
      status: "ok",
      service: "fantasy-api",
      version,
      time: new Date().toISOString(),
      mobileApiVersion: MOBILE_API_VERSION,
      mobileCapabilities,
    }),
  );

  app.get("/health/ready", async (_request, reply) => {
    const ready = (await options.readinessCheck?.()) ?? true;
    const response = healthResponseSchema.parse({
      status: ready ? "ok" : "degraded",
      service: "fantasy-api",
      version,
      time: new Date().toISOString(),
      mobileApiVersion: MOBILE_API_VERSION,
      mobileCapabilities,
    });
    return reply.code(ready ? 200 : 503).send(response);
  });

  const loginSchema = z.object({
    email: z.email().max(320),
    password: z.string().min(1).max(128),
  });

  app.post(
    "/v1/auth/login",
    {
      config: {
        rateLimit: {
          max: environment.NODE_ENV === "test" ? 10_000 : 30,
          timeWindow: "1 minute",
          keyGenerator: (request) => `login-ip:${request.ip}`,
        },
      },
      preHandler: async (request, reply) => {
        const limit = await loginAccountRateLimit(request);
        if (limit.isAllowed) return;
        void reply.header("x-ratelimit-limit", limit.max);
        void reply.header("x-ratelimit-remaining", limit.remaining);
        void reply.header("x-ratelimit-reset", limit.ttlInSeconds);
        if (!limit.isExceeded) return;
        void reply.header("retry-after", limit.ttlInSeconds);
        return reply.code(429).type("application/problem+json").send({
          type: "https://fantasy.local/problems/rate-limit",
          title: "Too many requests",
          status: 429,
          detail: "Try again later.",
          correlationId: request.id,
        });
      },
    },
    async (request, reply) => {
      if (!options.authService) {
        return reply.code(503).send({
          type: "https://fantasy.local/problems/auth-unavailable",
          title: "Authentication is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const input = loginSchema.parse(request.body);
      const result = await options.authService.login(input.email, input.password);
      if (!result) {
        return reply.code(401).send({
          type: "https://fantasy.local/problems/invalid-credentials",
          title: "Email or password is incorrect",
          status: 401,
          correlationId: request.id,
        });
      }
      void reply.setCookie(sessionCookieName, result.token, {
        path: "/",
        httpOnly: true,
        secure: environment.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: sessionLifetimeSeconds,
        expires: result.expiresAt,
      });
      return { user: result.user, expiresAt: result.expiresAt.toISOString() };
    },
  );

  app.post("/v1/auth/logout", async (request, reply) => {
    await options.authService?.logout(request.cookies[sessionCookieName]);
    void reply.clearCookie(sessionCookieName, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/v1/auth/session", async (request, reply) => {
    const user = await options.authService?.validate(request.cookies[sessionCookieName]);
    if (!user) return reply.code(401).send({ authenticated: false });
    return { authenticated: true, user };
  });

  registerBrowserHandoffRoutes(app, {
    environment,
    ...(browserHandoffs ? { browserHandoffs } : {}),
    isTest: environment.NODE_ENV === "test",
  });

  registerRegistrationRoutes(app, {
    environment,
    ...(options.registration ? { registration: options.registration } : {}),
  });

  registerInvitationRoutes(app, {
    environment,
    ...(options.authService ? { authService: options.authService } : {}),
    ...(options.invitations ? { invitations: options.invitations } : {}),
  });
  registerRankingRoutes(app, {
    webUrl: environment.WEB_URL,
    ...(options.rankings ? { rankings: options.rankings } : {}),
  });
  registerDraftRoutes(app, {
    ...(options.draftSessions ? { draftSessions: options.draftSessions } : {}),
    ...(options.draftMarket ? { draftMarket: options.draftMarket } : {}),
    ...(options.draftAnalysis ? { draftAnalysis: options.draftAnalysis } : {}),
    ...(options.draftManualBackup ? { draftManualBackup: options.draftManualBackup } : {}),
    draftStream,
  });
  registerInSeasonDecisionRoutes(app, {
    ...(options.decisions ? { decisions: options.decisions } : {}),
  });
  registerLeagueAnalyticsRoutes(app, {
    ...(options.analytics ? { analytics: options.analytics } : {}),
  });
  registerRecapRoutes(app, {
    ...(options.recaps ? { recaps: options.recaps } : {}),
  });
  registerScheduleEdgeRoutes(app, {
    ...(options.scheduleEdge ? { scheduleEdge: options.scheduleEdge } : {}),
  });
  registerChangeEventRoutes(app, {
    ...(options.changeEvents ? { changeEvents: options.changeEvents } : {}),
    isTest: environment.NODE_ENV === "test",
  });
  registerDataQualityRoutes(app, {
    ...(options.dataQuality ? { dataQuality: options.dataQuality } : {}),
  });
  registerStatsCenterRoutes(app, {
    ...(options.statsCenter ? { statsCenter: options.statsCenter } : {}),
  });
  registerScheduleRoutes(app, {
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  registerAccountRoutes(app, {
    ...(options.authService ? { authService: options.authService } : {}),
    ...(options.accountData ? { accountData: options.accountData } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
    isTest: environment.NODE_ENV === "test",
  });
  registerPushRoutes(app, {
    ...(options.push ? { push: options.push } : {}),
    isTest: environment.NODE_ENV === "test",
  });
  registerAiRoutes(app, options.ai);
  registerProjectionImportRoutes(app, {
    ...(options.projectionImports ? { projectionImports: options.projectionImports } : {}),
  });
  registerRosProjectionStatusRoutes(app, {
    ...(options.rosProjectionStatus ? { rosProjectionStatus: options.rosProjectionStatus } : {}),
  });
  registerYahooRoutes(app, {
    ...(options.yahooSync ? { yahooSync: options.yahooSync } : {}),
    ...(options.changeEventProducers ? { changeEventProducers: options.changeEventProducers } : {}),
    ...(options.enqueueRecommendationRecompute
      ? { enqueueRecommendationRecompute: options.enqueueRecommendationRecompute }
      : {}),
    ...(options.enqueueProjectionRefresh
      ? { enqueueProjectionRefresh: options.enqueueProjectionRefresh }
      : {}),
  });

  app.get("/v1/meta", () => ({
    name: "Laces Out API",
    version,
    environment: environment.NODE_ENV,
    writesEnabled: false,
  }));

  app.get("/v1/dashboard", () => getDemoDashboard());

  app.get("/v1/leagues", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.leagueDashboard) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/league-dashboard-unavailable",
        title: "League dashboard is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    return leagueListResponseSchema.parse(
      await options.leagueDashboard.listLeagues(request.currentUser.id),
    );
  });

  const leaguePathSchema = z.object({ leagueId: z.string().uuid() });
  app.get("/v1/leagues/:leagueId/dashboard", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.leagueDashboard) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/league-dashboard-unavailable",
        title: "League dashboard is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const { leagueId } = leaguePathSchema.parse(request.params);
    const dashboard = await options.leagueDashboard.getDashboard(request.currentUser.id, leagueId);
    if (!dashboard) {
      return reply.code(404).type("application/problem+json").send({
        type: "https://fantasy.local/problems/league-not-found",
        title: "League not found",
        status: 404,
        correlationId: request.id,
      });
    }
    return leagueDashboardSchema.parse(dashboard);
  });

  const leagueSeasonRefreshPathSchema = z.object({ leagueSeasonId: z.string().uuid() });
  app.post(
    "/v1/leagues/:leagueSeasonId/refresh",
    {
      preHandler: async (request, reply) => {
        const limit = await memberEspnRefreshRateLimit(request);
        if (limit.isAllowed) return;
        void reply.header("x-ratelimit-limit", limit.max);
        void reply.header("x-ratelimit-remaining", limit.remaining);
        void reply.header("x-ratelimit-reset", limit.ttlInSeconds);
        if (!limit.isExceeded) return;
        void reply.header("retry-after", limit.ttlInSeconds);
        return reply.code(429).type("application/problem+json").send({
          type: "https://fantasy.local/problems/rate-limit",
          title: "Too many requests",
          status: 429,
          detail: "Try again later.",
          correlationId: request.id,
        });
      },
    },
    async (request, reply) => {
      if (!request.currentUser) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/unauthorized",
          title: "Authentication required",
          status: 401,
          correlationId: request.id,
        });
      }
      if (!options.espnRefresh) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-refresh-unavailable",
          title: "ESPN automated refresh is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const { leagueSeasonId } = leagueSeasonRefreshPathSchema.parse(request.params);
      espnLeagueRefreshRequestSchema.parse(request.body ?? {});
      const status = espnLeagueRefreshStatusSchema.parse(
        await options.espnRefresh.requestRefresh(request.currentUser.id, leagueSeasonId),
      );
      const live = status.request?.state === "queued" || status.request?.state === "processing";
      request.log.info(
        {
          provider: "espn",
          operation: "member-refresh",
          current: status.current,
          intentDisposition: status.current
            ? "none"
            : status.request?.requestedAt === status.generatedAt
              ? "created"
              : "coalesced",
          requestState: status.request?.state ?? "none",
          fulfillmentMode: status.request?.fulfillmentMode ?? "none",
          displayCode: status.display.code,
          activeAgentCount: status.agents.activeCount,
        },
        "ESPN member refresh evaluated",
      );
      return reply.code(live ? 202 : 200).send(status);
    },
  );

  app.get("/v1/leagues/:leagueSeasonId/refresh/status", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.espnRefresh) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/espn-refresh-unavailable",
        title: "ESPN automated refresh is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const { leagueSeasonId } = leagueSeasonRefreshPathSchema.parse(request.params);
    return espnLeagueRefreshStatusSchema.parse(
      await options.espnRefresh.getStatus(request.currentUser.id, leagueSeasonId),
    );
  });

  app.post("/v1/leagues/:leagueId/team-claim", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.leagueDashboard) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/league-dashboard-unavailable",
        title: "League dashboard is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const { leagueId } = leaguePathSchema.parse(request.params);
    const input = teamClaimRequestSchema.parse(request.body);
    return teamClaimResponseSchema.parse(
      await options.leagueDashboard.claimTeam(request.currentUser.id, leagueId, input.teamId),
    );
  });

  app.get("/v1/connections", () => getDemoDashboard().connections);

  app.get("/v1/bridge/espn/devices", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.espnBridge) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/espn-bridge-unavailable",
        title: "ESPN browser sync is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    return espnBridgeDeviceListResponseSchema.parse(
      await options.espnBridge.listDevices(request.currentUser.id),
    );
  });

  app.post("/v1/bridge/espn/devices", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.espnBridge) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/espn-bridge-unavailable",
        title: "ESPN browser sync is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const input = espnBridgeDeviceRequestSchema.parse(request.body ?? {});
    const registration = {
      name: input.name,
      clientKind: input.clientKind,
      agentCapabilities: input.agentCapabilities,
      allowedLeagueIds: input.allowedLeagueIds,
      ...(input.season === undefined ? {} : { season: input.season }),
    };
    return reply
      .code(201)
      .send(
        espnBridgeDeviceResponseSchema.parse(
          await options.espnBridge.registerDevice(request.currentUser.id, registration),
        ),
      );
  });

  app.post("/v1/bridge/espn/pairing-sessions", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.espnBridge?.createPairingSession) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/espn-bridge-pairing-unavailable",
        title: "ESPN companion pairing is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const input = espnBridgePairingSessionRequestSchema.parse(request.body ?? {});
    return reply
      .code(201)
      .send(
        espnBridgePairingSessionResponseSchema.parse(
          await options.espnBridge.createPairingSession(request.currentUser.id, input),
        ),
      );
  });

  app.post(
    espnBridgePairingRedeemPath,
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!options.espnBridge?.redeemPairingSession) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-bridge-pairing-unavailable",
          title: "ESPN companion pairing is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const input = espnBridgePairingRedeemRequestSchema.parse(request.body ?? {});
      const credential = await options.espnBridge.redeemPairingSession(input.pairingCode);
      if (!credential) {
        return reply.code(400).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-bridge-pairing-invalid",
          title: "Pairing code is invalid or expired",
          status: 400,
          correlationId: request.id,
        });
      }
      return espnBridgePairingRedeemResponseSchema.parse(credential);
    },
  );

  const bridgeDevicePathSchema = z.object({ deviceId: z.string().uuid() });
  app.delete("/v1/bridge/espn/devices/:deviceId", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.espnBridge) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/espn-bridge-unavailable",
        title: "ESPN browser sync is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const { deviceId } = bridgeDevicePathSchema.parse(request.params);
    const revoked = await options.espnBridge.revokeDevice(request.currentUser.id, deviceId);
    if (!revoked) {
      return reply.code(404).type("application/problem+json").send({
        type: "https://fantasy.local/problems/espn-bridge-device-not-found",
        title: "ESPN bridge device not found",
        status: 404,
        correlationId: request.id,
      });
    }
    return espnBridgeDeviceRevokeResponseSchema.parse(revoked);
  });

  app.post(
    "/v1/bridge/espn/snapshots",
    {
      bodyLimit: 6 * 1024 * 1024,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (request) => bridgeDeviceRateLimitKey(request, "core-upload"),
        },
      },
    },
    async (request, reply) => {
      if (!options.espnBridge) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-bridge-unavailable",
          title: "ESPN browser sync is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const authorization = request.headers.authorization;
      const match = /^Bridge ([A-Za-z0-9._~-]{32,512})$/u.exec(authorization ?? "");
      if (!match?.[1]) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/bridge-unauthorized",
          title: "Valid bridge device authorization is required",
          status: 401,
          correlationId: request.id,
        });
      }
      const snapshot = espnBridgeSnapshotSchema.parse(request.body);
      const accepted = await options.espnBridge.acceptSnapshot(match[1], snapshot);
      const receipt = espnBridgeReceiptSchema.parse(accepted);
      if (receipt.state === "accepted") {
        await enqueueRecomputeAfterIngestion(options, accepted.leagueSeasonId, request);
      }
      if (receipt.state === "accepted" && options.enqueueProjectionRefresh) {
        try {
          await options.enqueueProjectionRefresh({
            season: snapshot.season,
            reason: "league-sync",
            requestedAt: new Date(),
          });
        } catch (error) {
          request.log.warn(
            { err: error, season: snapshot.season },
            "ESPN sync succeeded but projection refresh enqueue failed",
          );
        }
      }
      return reply.code(receipt.state === "accepted" ? 202 : 200).send(receipt);
    },
  );

  app.post(
    "/v1/bridge/espn/supplemental",
    {
      bodyLimit: 21 * 1024 * 1024,
      config: {
        rateLimit: {
          max: 180,
          timeWindow: "10 minutes",
          keyGenerator: (request) => bridgeDeviceRateLimitKey(request, "supplemental-upload"),
        },
      },
    },
    async (request, reply) => {
      if (!options.espnBridge?.acceptSupplementalSnapshot) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-bridge-unavailable",
          title: "ESPN browser sync is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const authorization = request.headers.authorization;
      const match = /^Bridge ([A-Za-z0-9._~-]{32,512})$/u.exec(authorization ?? "");
      if (!match?.[1]) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/bridge-unauthorized",
          title: "Valid bridge device authorization is required",
          status: 401,
          correlationId: request.id,
        });
      }
      const snapshot = espnSupplementalBridgeSnapshotSchema.parse(request.body);
      const accepted = await options.espnBridge.acceptSupplementalSnapshot(match[1], snapshot);
      const receipt = espnBridgeReceiptSchema.parse(accepted);
      if (receipt.state === "accepted") {
        await enqueueRecomputeAfterIngestion(options, accepted.leagueSeasonId, request);
      }
      return reply.code(receipt.state === "accepted" ? 202 : 200).send(receipt);
    },
  );

  app.post(
    "/v1/bridge/espn/refresh-requests/poll",
    {
      config: {
        rateLimit: {
          max: 24,
          timeWindow: "1 minute",
          keyGenerator: (request) => bridgeDeviceRateLimitKey(request, "refresh-poll"),
        },
      },
    },
    async (request, reply) => {
      if (!options.espnRefresh) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-refresh-unavailable",
          title: "ESPN refresh relay is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const authorization = request.headers.authorization;
      const match = /^Bridge ([A-Za-z0-9._~-]{32,512})$/u.exec(authorization ?? "");
      if (!match?.[1]) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/bridge-unauthorized",
          title: "Valid sync device authorization is required",
          status: 401,
          correlationId: request.id,
        });
      }
      espnRefreshAgentPollRequestSchema.parse(request.body ?? {});
      const result = espnRefreshAgentPollResponseSchema.parse(
        await options.espnRefresh.pollAgent(match[1]),
      );
      request.log.info(
        { provider: "espn", operation: "agent-poll", offeredRequestCount: result.requests.length },
        "ESPN sync agent polled",
      );
      return result;
    },
  );

  const refreshAttemptPathSchema = z.object({ requestId: z.string().uuid() });
  app.post(
    "/v1/bridge/espn/refresh-requests/:requestId/attempts",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: (request) => bridgeDeviceRateLimitKey(request, "refresh-attempt"),
        },
      },
    },
    async (request, reply) => {
      if (!options.espnRefresh) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-refresh-unavailable",
          title: "ESPN refresh relay is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const authorization = request.headers.authorization;
      const match = /^Bridge ([A-Za-z0-9._~-]{32,512})$/u.exec(authorization ?? "");
      if (!match?.[1]) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/bridge-unauthorized",
          title: "Valid sync device authorization is required",
          status: 401,
          correlationId: request.id,
        });
      }
      const { requestId } = refreshAttemptPathSchema.parse(request.params);
      const input = espnRefreshAgentAttemptRequestSchema.parse(request.body);
      const attempt = {
        state: input.state,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      };
      const result = espnRefreshAgentAttemptResponseSchema.parse(
        await options.espnRefresh.reportAgentAttempt(match[1], requestId, attempt),
      );
      request.log.info(
        {
          provider: "espn",
          operation: "agent-attempt",
          attemptState: result.state,
        },
        "ESPN sync agent attempt recorded",
      );
      return reply.code(input.state === "started" ? 202 : 200).send(result);
    },
  );

  app.post(
    "/v1/bridge/espn/live-draft",
    {
      bodyLimit: ESPN_LIVE_DRAFT_LIMITS.maximumBodyBytes,
      // Sized for a heartbeat every 5s plus bounded transient auction updates from one active
      // source, with headroom for a standby that has not yet been told to stand down.
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: (request) => bridgeDeviceRateLimitKey(request, "live-draft"),
        },
      },
    },
    async (request, reply) => {
      if (!options.espnLiveDraft) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/espn-live-draft-unavailable",
          title: "ESPN live draft sync is not enabled",
          status: 503,
          correlationId: request.id,
        });
      }
      const authorization = request.headers.authorization;
      const match = /^Bridge ([A-Za-z0-9._~-]{32,512})$/u.exec(authorization ?? "");
      if (!match?.[1]) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/bridge-unauthorized",
          title: "Valid bridge device authorization is required",
          status: 401,
          correlationId: request.id,
        });
      }
      const observation = espnLiveDraftIngestRequestSchema.parse(request.body);
      const result = espnLiveDraftIngestResponseSchema.parse(
        await options.espnLiveDraft.ingest(match[1], observation),
      );
      // Published only after the write has committed, so a viewer that reacts immediately reads
      // the state this observation produced rather than the one before it.
      if (result.status === "accepted" && result.draftId !== null) {
        draftStream.publish({
          draftId: result.draftId,
          sequence: result.serverSequence ?? 0,
          feedRevision: observation.revision,
          occurredAt: new Date().toISOString(),
        });
      }
      // Structured, bounded, and identifier-only: no payload, no names, no device credential.
      request.log.info(
        {
          liveDraftStatus: result.status,
          liveDraftFeedState: result.feedState,
          liveDraftIssue: result.issueCode,
          draftId: result.draftId,
          providerLeagueId: observation.leagueId,
          pageRevision: observation.revision,
        },
        "espn live draft observation processed",
      );
      return reply.code(result.status === "accepted" ? 202 : 200).send(result);
    },
  );

  app.post("/v1/connections/yahoo/authorize", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (!options.yahooConnection) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/yahoo-unavailable",
        title: "Yahoo connection is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const input = yahooAuthorizeRequestSchema.parse(request.body ?? {});
    return yahooAuthorizeResponseSchema.parse(
      await options.yahooConnection.start(request.currentUser.id, input),
    );
  });

  const yahooCallbackSchema = z.object({
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(256).optional(),
  });
  app.get("/v1/connections/yahoo/callback", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    const query = yahooCallbackSchema.parse(request.query);
    if (!options.yahooConnection) {
      return redirectYahooWithoutReferrer(
        reply,
        browserYahooCompletionUrl(environment.WEB_URL, "unavailable"),
      );
    }
    if (query.error || !query.code) {
      if (!query.state) {
        return redirectYahooWithoutReferrer(
          reply,
          browserYahooCompletionUrl(environment.WEB_URL, "denied"),
        );
      }
      try {
        const completion = await options.yahooConnection.deny(request.currentUser.id, query.state);
        // Preserve the established browser behavior while giving a verified native flow a bounded,
        // useful outcome. The provider's arbitrary error text is never copied to either callback.
        const status =
          completion.returnMode === "ios-app"
            ? yahooNativeProviderErrorStatus(query.error)
            : "denied";
        return yahooCompletionRedirect(reply, environment, completion, status);
      } catch (error) {
        request.log.warn(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Yahoo denial callback state was rejected",
        );
        // Without authenticated, one-time state there is no trustworthy native completion mode.
        return redirectYahooWithoutReferrer(
          reply,
          browserYahooCompletionUrl(environment.WEB_URL, "denied"),
        );
      }
    }
    if (!query.state) {
      return redirectYahooWithoutReferrer(
        reply,
        browserYahooCompletionUrl(environment.WEB_URL, "denied"),
      );
    }
    try {
      const result = await options.yahooConnection.complete(request.currentUser.id, {
        code: query.code,
        state: query.state,
      });
      let sync: "complete" | "failed" | undefined;
      if (options.yahooSync) {
        try {
          const discovery = await options.yahooSync.discoverAndSync(
            request.currentUser.id,
            result.connectionId,
          );
          if (options.enqueueProjectionRefresh) {
            for (const season of new Set(discovery.syncs.map((sync) => sync.season))) {
              try {
                await options.enqueueProjectionRefresh({
                  season,
                  reason: "league-sync",
                  requestedAt: new Date(),
                });
              } catch (error) {
                request.log.warn(
                  { err: error, season },
                  "Yahoo sync succeeded but projection refresh enqueue failed",
                );
              }
            }
          }
          await emitYahooCallbackChangeEvents(options, discovery.syncs, request);
          sync = "complete";
        } catch (error) {
          request.log.warn(
            { err: error, connectionId: result.connectionId },
            "Yahoo authorization succeeded but initial read sync failed",
          );
          sync = "failed";
        }
      }
      return yahooCompletionRedirect(
        reply,
        environment,
        result,
        "connected",
        sync ? { sync } : undefined,
      );
    } catch (error) {
      if (error instanceof YahooConnectionCallbackError) {
        request.log.warn(
          { callbackOutcome: error.outcome },
          "Yahoo authorization callback did not complete",
        );
        return yahooCompletionRedirect(reply, environment, error.completion, error.outcome);
      }
      request.log.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Yahoo authorization callback state was rejected",
      );
      return redirectYahooWithoutReferrer(
        reply,
        browserYahooCompletionUrl(environment.WEB_URL, "error"),
      );
    }
  });

  app.post(
    "/v1/refreshes",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.currentUser) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/unauthorized",
          title: "Authentication required",
          status: 401,
          correlationId: request.id,
        });
      }
      const refresh = refreshRequestSchema.parse(request.body);
      if (refresh.scope === "league") {
        if (!options.refreshAuthorization) {
          return reply.code(503).type("application/problem+json").send({
            type: "https://fantasy.local/problems/refresh-authorization-unavailable",
            title: "League refresh authorization is not configured",
            status: 503,
            correlationId: request.id,
          });
        }
        const canAccess = await options.refreshAuthorization.canAccessLeague(
          request.currentUser.id,
          refresh.leagueId,
        );
        if (!canAccess) {
          return reply.code(404).type("application/problem+json").send({
            type: "https://fantasy.local/problems/league-not-found",
            title: "League not found",
            status: 404,
            correlationId: request.id,
          });
        }
        return reply.code(409).type("application/problem+json").send({
          type: "https://fantasy.local/problems/provider-refresh-required",
          title: "Use the provider-specific league sync",
          status: 409,
          detail:
            "Yahoo refresh is available under Connections; ESPN sync comes from the one-click bookmark or optional Chrome companion. Projection imports are handled under Projections.",
          correlationId: request.id,
        });
      }
      if (!options.enqueueRefresh) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/jobs-unavailable",
          title: "Refresh jobs are not available",
          status: 503,
          correlationId: request.id,
        });
      }
      const requestedAt = new Date();
      const jobId = await options.enqueueRefresh({
        requestedBy: request.currentUser.id,
        refresh,
        requestedAt,
      });
      return reply.code(jobId ? 202 : 200).send(
        jobAcceptedSchema.parse({
          jobId,
          state: jobId ? "queued" : "deduplicated",
          target: refresh.scope === "adp-data" ? "draft-market-adp" : "shared-nfl-data",
          requestedAt: requestedAt.toISOString(),
        }),
      );
    },
  );

  app.setNotFoundHandler(async (request, reply) => {
    const requestPath = requestPathForLog(request.url);
    const problem = problemDetailsSchema.parse({
      type: "https://fantasy.local/problems/not-found",
      title: "Route not found",
      status: 404,
      detail: `No route matches ${request.method} ${requestPath}`,
      instance: requestPath,
      correlationId: request.id,
    });
    return reply.code(404).type("application/problem+json").send(problem);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const normalizedError =
      error instanceof Error ? error : new Error("Unknown request failure", { cause: error });
    const fastifyError = normalizedError as Error & {
      readonly code?: string;
      readonly validation?: readonly unknown[];
      readonly statusCode?: number;
    };
    const isValidation =
      error instanceof ZodError ||
      error instanceof EspnWebClientNormalizationError ||
      error instanceof EspnSupplementalNormalizationError ||
      fastifyError.validation !== undefined;
    const status = isValidation ? 400 : (fastifyError.statusCode ?? 500);
    if (status >= 500) request.log.error({ err: error }, "request failed");
    if (isValidation) request.log.info({ err: error }, "request validation rejected");

    const isRateLimit = status === 429;
    const isClientError = status >= 400 && status < 500;
    const isContentTypeError = fastifyError.code?.startsWith("FST_ERR_CTP_") ?? false;
    const publicValidationDetail =
      error instanceof EspnWebClientNormalizationError
        ? normalizedError.message
        : error instanceof EspnSupplementalNormalizationError
          ? normalizedError.message
          : "One or more request fields are invalid.";

    const problem = problemDetailsSchema.parse({
      type: isValidation
        ? "https://fantasy.local/problems/validation"
        : isRateLimit
          ? "https://fantasy.local/problems/rate-limit"
          : isClientError
            ? "https://fantasy.local/problems/request-rejected"
            : "https://fantasy.local/problems/internal",
      title: isValidation
        ? "Request validation failed"
        : isRateLimit
          ? "Too many requests"
          : isClientError
            ? "Request rejected"
            : "Request failed",
      status,
      detail: isValidation
        ? publicValidationDetail
        : isRateLimit
          ? "Try again later."
          : isContentTypeError || status >= 500
            ? "The request could not be completed."
            : normalizedError.message,
      instance: requestPathForLog(request.url),
      correlationId: request.id,
    });
    return reply.code(status).type("application/problem+json").send(problem);
  });

  return app;
}
