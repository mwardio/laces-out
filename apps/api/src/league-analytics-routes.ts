import { leagueAnalyticsSnapshotSchema } from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface LeagueAnalyticsPort {
  getSnapshot(userId: string, leagueId: string): Promise<unknown>;
}

export interface LeagueAnalyticsRouteOptions {
  readonly analytics?: LeagueAnalyticsPort;
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

export function registerLeagueAnalyticsRoutes(
  app: FastifyInstance,
  options: LeagueAnalyticsRouteOptions,
): void {
  app.get("/v1/leagues/:leagueId/analytics", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.analytics) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/league-analytics-unavailable",
        title: "League analytics are not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const { leagueId } = leaguePathSchema.parse(request.params);
    const snapshot = await options.analytics.getSnapshot(user.id, leagueId);
    if (!snapshot) {
      // Membership checks intentionally collapse inaccessible and unknown leagues.
      return reply.code(404).type("application/problem+json").send({
        type: "https://fantasy.local/problems/league-not-found",
        title: "League not found",
        status: 404,
        correlationId: request.id,
      });
    }
    return leagueAnalyticsSnapshotSchema.parse(snapshot);
  });
}
