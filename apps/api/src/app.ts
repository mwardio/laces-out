import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { loadEnvironment, type Environment } from "@fantasy/config";
import {
  espnBridgeDeviceRequestSchema,
  espnBridgeDeviceListResponseSchema,
  espnBridgeDeviceRevokeResponseSchema,
  espnBridgeDeviceResponseSchema,
  espnBridgeReceiptSchema,
  espnBridgeSnapshotSchema,
  healthResponseSchema,
  jobAcceptedSchema,
  leagueDashboardSchema,
  leagueListResponseSchema,
  problemDetailsSchema,
  refreshRequestSchema,
  teamClaimRequestSchema,
  teamClaimResponseSchema,
  yahooAuthorizeRequestSchema,
  yahooAuthorizeResponseSchema,
  type EspnBridgeSnapshot,
  type LeagueDashboard,
  type LeagueListResponse,
  type RefreshRequest,
  type TeamClaimResponse,
} from "@fantasy/contracts";
import { EspnImportError } from "@fantasy/connector-espn";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import { sessionCookieName, sessionLifetimeSeconds, type AuthService } from "./auth.js";
import { type AiServicePort, registerAiRoutes } from "./ai-routes.js";
import { getDemoDashboard } from "./demo.js";
import { type DraftSessionPort, registerDraftRoutes } from "./draft-routes.js";
import { type EspnManualImportPort, registerEspnManualImportRoutes } from "./espn-import-routes.js";
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
import type { RefreshAuthorizationPort } from "./refresh-authorization.js";
import { type RegistrationPort, registerRegistrationRoutes } from "./registration-routes.js";
import { registerYahooRoutes } from "./yahoo-routes.js";
import type { YahooSyncPort } from "./yahoo-sync.js";

export interface YahooConnectionPort {
  start(
    userId: string,
    returnTo: string,
  ): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }>;
  complete(
    userId: string,
    input: { readonly code: string; readonly state: string },
  ): Promise<{ readonly connectionId: string; readonly returnTo: string }>;
}

export interface EspnBridgePort {
  listDevices(userId: string): Promise<{
    readonly generatedAt: string;
    readonly devices: readonly {
      readonly deviceId: string;
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
    input: { readonly name: string; readonly allowedLeagueIds: readonly string[] },
  ): Promise<{
    readonly deviceId: string;
    readonly deviceToken: string;
    readonly expiresAt: string | null;
  }>;
  acceptSnapshot(
    deviceToken: string,
    snapshot: EspnBridgeSnapshot,
  ): Promise<{
    readonly receiptId: string;
    readonly state: "accepted" | "unchanged";
    readonly receivedAt: string;
  }>;
  revokeDevice(
    userId: string,
    deviceId: string,
  ): Promise<{ readonly deviceId: string; readonly revokedAt: string } | undefined>;
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
  readonly espnBridge?: EspnBridgePort;
  readonly espnImports?: EspnManualImportPort;
  readonly invitations?: InvitationPort;
  readonly decisions?: InSeasonDecisionPort;
  readonly analytics?: LeagueAnalyticsPort;
  readonly ai?: AiServicePort;
  readonly leagueDashboard?: LeagueDashboardPort;
  readonly projectionImports?: ProjectionImportPort;
  readonly rankings?: RankingPort;
  readonly refreshAuthorization?: RefreshAuthorizationPort;
  readonly registration?: RegistrationPort;
  readonly yahooConnection?: YahooConnectionPort;
  readonly yahooSync?: YahooSyncPort;
  readonly enqueueRefresh?: (request: {
    readonly requestedBy: string;
    readonly refresh: Extract<RefreshRequest, { scope: "player-data" }>;
    readonly requestedAt: Date;
  }) => Promise<string | null>;
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

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const environment = options.environment ?? loadEnvironment();
  const requireAuthentication =
    options.requireAuthentication ?? environment.NODE_ENV === "production";
  if (requireAuthentication && !options.authService) {
    throw new Error("Authentication is required but no AuthService was configured");
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
                "req.body.inviteCode",
                "req.body.password",
                "req.body.apiKey",
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

  await app.register(cors, {
    delegator: (request, callback) => {
      const requestPath = request.url.split("?", 1)[0] ?? request.url;
      const fromEspnBookmark =
        requestPath === "/v1/bridge/espn/snapshots" &&
        request.headers.origin === "https://fantasy.espn.com";
      callback(null, {
        origin: fromEspnBookmark ? "https://fantasy.espn.com" : environment.WEB_URL,
        credentials: !fromEspnBookmark,
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
    "/v1/bridge/espn/snapshots",
    "/v1/invitations/inspect",
    "/v1/invitations/accept",
    "/v1/ranking-shares/open",
    "/v1/ranking-shares/export",
  ]);
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?", 1)[0] ?? request.url;
    const isBridgeSnapshot = requestPath === "/v1/bridge/espn/snapshots";
    if (
      environment.NODE_ENV === "production" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !isBridgeSnapshot
    ) {
      const origin = request.headers.origin;
      if (origin !== environment.WEB_URL) {
        return reply.code(403).type("application/problem+json").send({
          type: "https://fantasy.local/problems/origin",
          title: "Request origin rejected",
          status: 403,
          correlationId: request.id,
        });
      }
    }

    if (publicPaths.has(requestPath)) {
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
    }),
  );

  app.get("/health/ready", async (_request, reply) => {
    const ready = (await options.readinessCheck?.()) ?? true;
    const response = healthResponseSchema.parse({
      status: ready ? "ok" : "degraded",
      service: "fantasy-api",
      version,
      time: new Date().toISOString(),
    });
    return reply.code(ready ? 200 : 503).send(response);
  });

  const loginSchema = z.object({
    email: z.email().max(320),
    password: z.string().min(1).max(128),
  });

  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
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
  });
  registerInSeasonDecisionRoutes(app, {
    ...(options.decisions ? { decisions: options.decisions } : {}),
  });
  registerLeagueAnalyticsRoutes(app, {
    ...(options.analytics ? { analytics: options.analytics } : {}),
  });
  registerAiRoutes(app, options.ai);
  registerProjectionImportRoutes(app, {
    ...(options.projectionImports ? { projectionImports: options.projectionImports } : {}),
  });
  registerEspnManualImportRoutes(app, {
    ...(options.espnImports ? { espnImports: options.espnImports } : {}),
  });
  registerYahooRoutes(app, {
    ...(options.yahooSync ? { yahooSync: options.yahooSync } : {}),
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
    return reply
      .code(201)
      .send(
        espnBridgeDeviceResponseSchema.parse(
          await options.espnBridge.registerDevice(request.currentUser.id, input),
        ),
      );
  });

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
        rateLimit: { max: 30, timeWindow: "1 minute" },
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
      const receipt = espnBridgeReceiptSchema.parse(
        await options.espnBridge.acceptSnapshot(match[1], snapshot),
      );
      return reply.code(receipt.state === "accepted" ? 202 : 200).send(receipt);
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
      await options.yahooConnection.start(request.currentUser.id, input.returnTo),
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
      return reply.redirect(
        new URL("/connections?provider=yahoo&status=unavailable", environment.WEB_URL).toString(),
      );
    }
    if (query.error || !query.code || !query.state) {
      return reply.redirect(
        new URL("/connections?provider=yahoo&status=denied", environment.WEB_URL).toString(),
      );
    }
    try {
      const result = await options.yahooConnection.complete(request.currentUser.id, {
        code: query.code,
        state: query.state,
      });
      const destination = applicationRedirect(environment.WEB_URL, result.returnTo);
      destination.searchParams.set("provider", "yahoo");
      destination.searchParams.set("status", "connected");
      if (options.yahooSync) {
        try {
          await options.yahooSync.discoverAndSync(request.currentUser.id, result.connectionId);
          destination.searchParams.set("sync", "complete");
        } catch (error) {
          request.log.warn(
            { err: error, connectionId: result.connectionId },
            "Yahoo authorization succeeded but initial read sync failed",
          );
          destination.searchParams.set("sync", "failed");
        }
      }
      return reply.redirect(destination.toString());
    } catch (error) {
      request.log.warn({ err: error }, "Yahoo authorization callback failed");
      return reply.redirect(
        new URL("/connections?provider=yahoo&status=error", environment.WEB_URL).toString(),
      );
    }
  });

  app.post("/v1/refreshes", async (request, reply) => {
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
        target: "nflverse-player-catalog",
        requestedAt: requestedAt.toISOString(),
      }),
    );
  });

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
      readonly validation?: readonly unknown[];
      readonly statusCode?: number;
    };
    const isValidation =
      error instanceof ZodError ||
      error instanceof EspnImportError ||
      fastifyError.validation !== undefined;
    const status = isValidation ? 400 : (fastifyError.statusCode ?? 500);
    if (status >= 500) request.log.error({ err: error }, "request failed");

    const problem = problemDetailsSchema.parse({
      type: isValidation
        ? "https://fantasy.local/problems/validation"
        : "https://fantasy.local/problems/internal",
      title: isValidation ? "Request validation failed" : "Request failed",
      status,
      detail: status >= 500 ? "The request could not be completed." : normalizedError.message,
      instance: requestPathForLog(request.url),
      correlationId: request.id,
    });
    return reply.code(status).type("application/problem+json").send(problem);
  });

  return app;
}
