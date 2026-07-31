import {
  leagueRecapResponseSchema,
  recapGenerateRequestSchema,
  recapPersonaCardListSchema,
  recapPersonaCardSaveRequestSchema,
  recapPersonaCardSchema,
  recapSettingsSaveRequestSchema,
  recapSettingsSchema,
  type AiProviderName,
  type LeagueRecapResponse,
  type RecapSpiceLevel,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  RecapCardDeleteResult,
  RecapCardSaveResult,
  RecapGenerateResult,
  RecapPersonaCardListResult,
  RecapSettingsSaveResult,
} from "./recap-service.js";

export interface RecapRoutePort {
  getRecap(
    userId: string,
    leagueId: string,
    week: number,
  ): Promise<LeagueRecapResponse | undefined>;
  generate(
    userId: string,
    leagueId: string,
    input: { readonly week: number; readonly provider?: AiProviderName },
  ): Promise<RecapGenerateResult | undefined>;
  listPersonaCards(
    userId: string,
    leagueId: string,
  ): Promise<RecapPersonaCardListResult | undefined>;
  savePersonaCard(
    userId: string,
    leagueId: string,
    teamId: string,
    body: string,
  ): Promise<RecapCardSaveResult | undefined>;
  deletePersonaCard(
    userId: string,
    leagueId: string,
    teamId: string,
  ): Promise<RecapCardDeleteResult | undefined>;
  saveSettings(
    userId: string,
    leagueId: string,
    spiceLevel: RecapSpiceLevel,
  ): Promise<RecapSettingsSaveResult | undefined>;
}

export interface RecapRouteOptions {
  readonly recaps?: RecapRoutePort;
}

const leaguePathSchema = z.object({ leagueId: z.string().uuid() }).strict();
const teamPathSchema = z
  .object({ leagueId: z.string().uuid(), teamId: z.string().uuid() })
  .strict();
const recapQuerySchema = z.object({ week: z.coerce.number().int().min(1).max(30) }).strict();

function authenticatedUser(request: FastifyRequest, reply: FastifyReply) {
  if (request.currentUser) return request.currentUser;
  void reply.code(401).type("application/problem+json").send({
    type: "https://fantasy.local/problems/unauthorized",
    title: "Authentication required",
    status: 401,
    correlationId: request.id,
  });
  return undefined;
}

function availableService(
  request: FastifyRequest,
  reply: FastifyReply,
  service: RecapRoutePort | undefined,
): service is RecapRoutePort {
  if (service) return true;
  void reply.code(503).type("application/problem+json").send({
    type: "https://fantasy.local/problems/recap-unavailable",
    title: "The Reckoning recap is not configured",
    status: 503,
    correlationId: request.id,
  });
  return false;
}

function leagueNotFound(request: FastifyRequest, reply: FastifyReply) {
  // Membership checks intentionally collapse inaccessible and unknown leagues.
  return reply.code(404).type("application/problem+json").send({
    type: "https://fantasy.local/problems/league-not-found",
    title: "League not found",
    status: 404,
    correlationId: request.id,
  });
}

function teamNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).type("application/problem+json").send({
    type: "https://fantasy.local/problems/team-not-found",
    title: "Team not found",
    status: 404,
    correlationId: request.id,
  });
}

function recapForbidden(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(403).type("application/problem+json").send({
    type: "https://fantasy.local/problems/recap-forbidden",
    title: "This member cannot make that recap change",
    status: 403,
    code: "RECAP_FORBIDDEN",
    correlationId: request.id,
  });
}

export function registerRecapRoutes(app: FastifyInstance, options: RecapRouteOptions): void {
  app.get("/v1/leagues/:leagueId/recap", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user || !availableService(request, reply, options.recaps)) return reply;
    const { leagueId } = leaguePathSchema.parse(request.params);
    const { week } = recapQuerySchema.parse(request.query);
    const response = await options.recaps.getRecap(user.id, leagueId, week);
    if (!response) return leagueNotFound(request, reply);
    return leagueRecapResponseSchema.parse(response);
  });

  app.post(
    "/v1/leagues/:leagueId/recap",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, options.recaps)) return reply;
      const { leagueId } = leaguePathSchema.parse(request.params);
      const input = recapGenerateRequestSchema.parse(request.body);
      const result = await options.recaps.generate(user.id, leagueId, {
        week: input.week,
        ...(input.provider ? { provider: input.provider } : {}),
      });
      if (!result) return leagueNotFound(request, reply);
      if (result.state === "forbidden") return recapForbidden(request, reply);
      if (result.state === "unconfigured") {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/recap-generation-unavailable",
          title: "Recap generation is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      if (result.state === "unavailable") {
        return reply.code(409).type("application/problem+json").send({
          type: "https://fantasy.local/problems/recap-week-unavailable",
          title: "The recap cannot be generated for that week",
          status: 409,
          detail: result.message,
          code: "RECAP_WEEK_UNAVAILABLE",
          correlationId: request.id,
        });
      }
      if (result.state === "in-progress") {
        void reply.header("retry-after", String(result.retryAfterSeconds));
        return reply.code(409).type("application/problem+json").send({
          type: "https://fantasy.local/problems/recap-generation-in-progress",
          title: "Another member is already writing this recap",
          status: 409,
          code: "RECAP_GENERATION_IN_PROGRESS",
          retryAfterSeconds: result.retryAfterSeconds,
          correlationId: request.id,
        });
      }
      if (result.state === "cooldown") {
        void reply.header("retry-after", String(result.retryAfterSeconds));
        return reply.code(429).type("application/problem+json").send({
          type: "https://fantasy.local/problems/recap-cooldown",
          title: "Give this recap a moment before rerolling",
          status: 429,
          code: "RECAP_COOLDOWN",
          retryAfterSeconds: result.retryAfterSeconds,
          correlationId: request.id,
        });
      }
      return leagueRecapResponseSchema.parse(result.response);
    },
  );

  app.get("/v1/leagues/:leagueId/persona-cards", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user || !availableService(request, reply, options.recaps)) return reply;
    const { leagueId } = leaguePathSchema.parse(request.params);
    const result = await options.recaps.listPersonaCards(user.id, leagueId);
    if (!result) return leagueNotFound(request, reply);
    if (result.state === "forbidden") return recapForbidden(request, reply);
    return recapPersonaCardListSchema.parse(result.list);
  });

  app.put(
    "/v1/leagues/:leagueId/persona-cards/:teamId",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, options.recaps)) return reply;
      const { leagueId, teamId } = teamPathSchema.parse(request.params);
      const input = recapPersonaCardSaveRequestSchema.parse(request.body);
      const result = await options.recaps.savePersonaCard(user.id, leagueId, teamId, input.body);
      if (!result) return leagueNotFound(request, reply);
      if (result.state === "forbidden") return recapForbidden(request, reply);
      if (result.state === "unknown-team") return teamNotFound(request, reply);
      return recapPersonaCardSchema.parse(result.card);
    },
  );

  app.delete(
    "/v1/leagues/:leagueId/persona-cards/:teamId",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, options.recaps)) return reply;
      const { leagueId, teamId } = teamPathSchema.parse(request.params);
      const result = await options.recaps.deletePersonaCard(user.id, leagueId, teamId);
      if (!result) return leagueNotFound(request, reply);
      if (result.state === "forbidden") return recapForbidden(request, reply);
      if (result.state === "unknown-team") return teamNotFound(request, reply);
      return reply.code(204).send();
    },
  );

  app.put(
    "/v1/leagues/:leagueId/recap-settings",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, options.recaps)) return reply;
      const { leagueId } = leaguePathSchema.parse(request.params);
      const input = recapSettingsSaveRequestSchema.parse(request.body);
      const result = await options.recaps.saveSettings(user.id, leagueId, input.spiceLevel);
      if (!result) return leagueNotFound(request, reply);
      if (result.state === "forbidden") return recapForbidden(request, reply);
      return recapSettingsSchema.parse(result.settings);
    },
  );
}
