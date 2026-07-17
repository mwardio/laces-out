import { inSeasonDecisionSnapshotSchema } from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface InSeasonDecisionPort {
  getSnapshot(userId: string, leagueId: string): Promise<unknown>;
}

export interface InSeasonDecisionRouteOptions {
  readonly decisions?: InSeasonDecisionPort;
}

const leaguePathSchema = z.object({ leagueId: z.string().uuid() }).strict();

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

export function registerInSeasonDecisionRoutes(
  app: FastifyInstance,
  options: InSeasonDecisionRouteOptions,
): void {
  app.get("/v1/leagues/:leagueId/decisions", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.decisions) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/decisions-unavailable",
        title: "In-season decisions are not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const { leagueId } = leaguePathSchema.parse(request.params);
    const snapshot = await options.decisions.getSnapshot(user.id, leagueId);
    if (!snapshot) {
      return reply.code(404).type("application/problem+json").send({
        type: "https://fantasy.local/problems/league-not-found",
        title: "League not found",
        status: 404,
        correlationId: request.id,
      });
    }
    return inSeasonDecisionSnapshotSchema.parse(snapshot);
  });
}
