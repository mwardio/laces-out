import {
  inSeasonDecisionSnapshotSchema,
  tradeEvaluationRequestSchema,
  tradeEvaluationResponseSchema,
  type TradeEvaluationOutcome,
  type TradeEvaluationRequest,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface InSeasonDecisionPort {
  getSnapshot(userId: string, leagueId: string): Promise<unknown>;
  evaluateBuiltTrade(
    userId: string,
    leagueId: string,
    request: TradeEvaluationRequest,
  ): Promise<TradeEvaluationOutcome>;
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

  app.post(
    "/v1/leagues/:leagueId/trade-evaluations",
    { bodyLimit: 4_096 },
    async (request, reply) => {
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
      const body = tradeEvaluationRequestSchema.parse(request.body);
      const result = await options.decisions.evaluateBuiltTrade(user.id, leagueId, body);
      if (result.outcome === "not-found") {
        return reply.code(404).type("application/problem+json").send({
          type: "https://fantasy.local/problems/league-not-found",
          title: "League not found",
          status: 404,
          correlationId: request.id,
        });
      }
      if (result.outcome === "rejected") {
        // Fixed per code, and deliberately naming no player, team, or roster fact: an answer that
        // distinguished "not on that roster" from "no such player" would be a probing oracle.
        return reply
          .code(400)
          .type("application/problem+json")
          .send({
            type: "https://fantasy.local/problems/trade-package-invalid",
            title: "Trade package rejected",
            status: 400,
            detail:
              result.code === "OPPONENT_NOT_IN_LEAGUE"
                ? "The selected trade partner is not another team in this league season."
                : "Every player you send must be on your claimed roster and every player you receive must be on the selected partner's roster.",
            correlationId: request.id,
          });
      }
      return tradeEvaluationResponseSchema.parse(result.response);
    },
  );
}
