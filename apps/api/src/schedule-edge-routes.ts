import {
  scheduleEdgeMatrixResponseSchema,
  scheduleEdgeResponseSchema,
  type ScheduleEdgeMatrixResponse,
  type ScheduleEdgeResponse,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface ScheduleEdgeMemberQuery {
  readonly startWeek: number | null;
  readonly endWeek: number | null;
  readonly playoffStartWeek: number | null;
  readonly playoffEndWeek: number | null;
}

export interface ScheduleEdgeMatrixQuery {
  readonly startWeek: number | null;
  readonly endWeek: number | null;
  readonly playoffStartWeek: number | null;
  readonly playoffEndWeek: number | null;
}

export interface ScheduleEdgePort {
  getRosterEdge(
    userId: string,
    leagueId: string,
    query: ScheduleEdgeMemberQuery,
  ): Promise<ScheduleEdgeResponse | undefined>;
  getMatrix(
    userId: string,
    leagueId: string,
    query: ScheduleEdgeMatrixQuery,
  ): Promise<ScheduleEdgeMatrixResponse | undefined>;
}

export interface ScheduleEdgeRouteOptions {
  readonly scheduleEdge?: ScheduleEdgePort;
}

const leaguePathSchema = z.object({ leagueId: z.string().uuid() }).strict();
const weekSchema = z.coerce.number().int().min(1).max(18);
const querySchema = z
  .object({
    startWeek: weekSchema.optional(),
    endWeek: weekSchema.optional(),
    playoffStartWeek: weekSchema.optional(),
    playoffEndWeek: weekSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startWeek !== undefined &&
      value.endWeek !== undefined &&
      value.startWeek > value.endWeek
    ) {
      context.addIssue({
        code: "custom",
        path: ["endWeek"],
        message: "endWeek must be greater than or equal to startWeek",
      });
    }
    if (
      value.playoffStartWeek !== undefined &&
      value.playoffEndWeek !== undefined &&
      value.playoffStartWeek > value.playoffEndWeek
    ) {
      context.addIssue({
        code: "custom",
        path: ["playoffEndWeek"],
        message: "playoffEndWeek must be greater than or equal to playoffStartWeek",
      });
    }
  });

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

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(503).type("application/problem+json").send({
    type: "https://fantasy.local/problems/schedule-edge-unavailable",
    title: "Schedule Edge is not configured",
    status: 503,
    correlationId: request.id,
  });
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).type("application/problem+json").send({
    type: "https://fantasy.local/problems/league-not-found",
    title: "League not found",
    status: 404,
    correlationId: request.id,
  });
}

function parsedQuery(query: unknown): ScheduleEdgeMemberQuery {
  const value = querySchema.parse(query);
  return {
    startWeek: value.startWeek ?? null,
    endWeek: value.endWeek ?? null,
    playoffStartWeek: value.playoffStartWeek ?? null,
    playoffEndWeek: value.playoffEndWeek ?? null,
  };
}

export function registerScheduleEdgeRoutes(
  app: FastifyInstance,
  options: ScheduleEdgeRouteOptions,
): void {
  app.get("/v1/leagues/:leagueId/schedule-edge", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.scheduleEdge) return unavailable(request, reply);
    const { leagueId } = leaguePathSchema.parse(request.params);
    const result = await options.scheduleEdge.getRosterEdge(
      user.id,
      leagueId,
      parsedQuery(request.query),
    );
    if (!result) return notFound(request, reply);
    return scheduleEdgeResponseSchema.parse(result);
  });

  app.get("/v1/leagues/:leagueId/schedule-edge/matrix", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.scheduleEdge) return unavailable(request, reply);
    const { leagueId } = leaguePathSchema.parse(request.params);
    const result = await options.scheduleEdge.getMatrix(
      user.id,
      leagueId,
      parsedQuery(request.query),
    );
    if (!result) return notFound(request, reply);
    return scheduleEdgeMatrixResponseSchema.parse(result);
  });
}
