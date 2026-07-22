import { statsCenterResponseSchema, statsCenterMetricSchema } from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { StatsCenterQuery } from "./stats-center.js";

export interface StatsCenterPort {
  getPlayers(userId: string, query: StatsCenterQuery): Promise<unknown>;
}

export interface StatsCenterRouteOptions {
  readonly statsCenter?: StatsCenterPort;
  readonly now?: () => Date;
}

const positionSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9/+.-]{1,20}$/u);

const querySchema = z
  .object({
    season: z.coerce.number().int().min(2012).max(2200).optional(),
    week: z.coerce.number().int().min(1).max(25).optional(),
    position: positionSchema.optional(),
    search: z.string().trim().max(80).optional(),
    sort: statsCenterMetricSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

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

export function registerStatsCenterRoutes(
  app: FastifyInstance,
  options: StatsCenterRouteOptions,
): void {
  app.get("/v1/stats/players", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.statsCenter) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/stats-center-unavailable",
        title: "Stats Center is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const input = querySchema.parse(request.query);
    const currentSeason = (options.now ?? (() => new Date()))().getUTCFullYear();
    const query: StatsCenterQuery = {
      season: input.season ?? currentSeason,
      week: input.week ?? null,
      position: input.position ?? null,
      search: input.search ?? "",
      sort: input.sort ?? "opportunities",
      limit: input.limit ?? 50,
    };
    return statsCenterResponseSchema.parse(await options.statsCenter.getPlayers(user.id, query));
  });
}
