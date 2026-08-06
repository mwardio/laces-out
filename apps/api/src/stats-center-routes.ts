import {
  statsCenterPlayerDetailResponseSchema,
  statsCenterResponseSchema,
  statsCenterScoringSchema,
  statsCenterSortSchema,
} from "@laces-out/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { StatsCenterQuery } from "./stats-center.js";

export interface StatsCenterPort {
  getPlayers(userId: string, query: StatsCenterQuery): Promise<unknown>;
  getPlayer?(userId: string, playerId: string, query: StatsCenterQuery): Promise<unknown>;
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

const teamSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2,4}$/u);

const weekSchema = z.coerce.number().int().min(1).max(25);

const querySchema = z
  .object({
    season: z.coerce.number().int().min(2012).max(2200).optional(),
    /** Retained so existing single-week links keep working; it pins both ends of the range. */
    week: weekSchema.optional(),
    weekFrom: weekSchema.optional(),
    weekTo: weekSchema.optional(),
    position: positionSchema.optional(),
    team: teamSchema.optional(),
    search: z.string().trim().max(80).optional(),
    sort: statsCenterSortSchema.optional(),
    scoring: statsCenterScoringSchema.optional(),
    recentWindow: z.coerce.number().int().min(1).max(25).optional(),
    recentWeightDecay: z.coerce.number().positive().max(1).optional(),
    limit: z.coerce.number().int().min(1).max(250).optional(),
  })
  .strict();

/** Resolves the `week` alias and orders the range so a reversed pair cannot return nothing. */
export function resolveWeekRange(input: {
  readonly week?: number | undefined;
  readonly weekFrom?: number | undefined;
  readonly weekTo?: number | undefined;
}): { readonly weekFrom: number | null; readonly weekTo: number | null } {
  const from = input.weekFrom ?? input.week ?? null;
  const to = input.weekTo ?? input.week ?? null;
  if (from !== null && to !== null && from > to) return { weekFrom: to, weekTo: from };
  return { weekFrom: from, weekTo: to };
}

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
  const currentSeason = () => (options.now ?? (() => new Date()))().getUTCFullYear();

  function notConfigured(request: FastifyRequest, reply: FastifyReply) {
    return reply.code(503).type("application/problem+json").send({
      type: "https://fantasy.local/problems/stats-center-unavailable",
      title: "Stats Center is not configured",
      status: 503,
      correlationId: request.id,
    });
  }

  function toQuery(input: z.infer<typeof querySchema>): StatsCenterQuery {
    const { weekFrom, weekTo } = resolveWeekRange(input);
    return {
      season: input.season ?? currentSeason(),
      weekFrom,
      weekTo,
      position: input.position ?? null,
      team: input.team ?? null,
      search: input.search ?? "",
      sort: input.sort ?? "opportunities",
      scoring: input.scoring ?? "ppr",
      recentWindow: input.recentWindow ?? 4,
      recentWeightDecay: input.recentWeightDecay ?? 0.75,
      limit: input.limit ?? 50,
    };
  }

  app.get("/v1/stats/players", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.statsCenter) return notConfigured(request, reply);
    const query = toQuery(querySchema.parse(request.query));
    return statsCenterResponseSchema.parse(await options.statsCenter.getPlayers(user.id, query));
  });

  app.get("/v1/stats/players/:playerId", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.statsCenter?.getPlayer) return notConfigured(request, reply);
    const { playerId } = z.object({ playerId: z.string().uuid() }).strict().parse(request.params);
    const query = toQuery(querySchema.parse(request.query));
    const detail = await options.statsCenter.getPlayer(user.id, playerId, query);
    if (!detail) {
      return reply.code(404).type("application/problem+json").send({
        type: "https://fantasy.local/problems/player-not-found",
        title: "No player matches this identifier",
        status: 404,
        correlationId: request.id,
      });
    }
    return statsCenterPlayerDetailResponseSchema.parse(detail);
  });
}
