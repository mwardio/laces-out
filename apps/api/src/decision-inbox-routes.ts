import {
  decisionInboxResponseSchema,
  decisionInboxStateRequestSchema,
  decisionInboxStateResponseSchema,
  type DecisionInboxItemState,
} from "@laces-out/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface DecisionInboxPort {
  getInbox(userId: string, leagueId: string, options?: { refresh?: boolean }): Promise<unknown>;
  setState(
    userId: string,
    leagueId: string,
    itemId: string,
    state: DecisionInboxItemState,
  ): Promise<unknown>;
}

const leaguePath = z.object({ leagueId: z.uuid() }).strict();
const itemPath = leaguePath.extend({ itemId: z.string().regex(/^[0-9a-f]{64}$/u) });
const inboxQuery = z.object({ refresh: z.enum(["true", "false"]).optional() }).strict();

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
    type: "https://fantasy.local/problems/decision-inbox-unavailable",
    title: "Decision inbox is not configured",
    status: 503,
    correlationId: request.id,
  });
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).type("application/problem+json").send({
    type: "https://fantasy.local/problems/decision-inbox-not-found",
    title: "Decision inbox or item not found",
    status: 404,
    correlationId: request.id,
  });
}

export function registerDecisionInboxRoutes(
  app: FastifyInstance,
  options: { decisionInbox?: DecisionInboxPort },
): void {
  app.get("/v1/leagues/:leagueId/decision-inbox", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.decisionInbox) return unavailable(request, reply);
    const { leagueId } = leaguePath.parse(request.params);
    const query = inboxQuery.parse(request.query);
    const result = await options.decisionInbox.getInbox(user.id, leagueId, {
      refresh: query.refresh === "true",
    });
    if (!result) return notFound(request, reply);
    reply.header("Cache-Control", "private, no-store");
    return decisionInboxResponseSchema.parse(result);
  });

  app.post(
    "/v1/leagues/:leagueId/decision-inbox/:itemId/state",
    { bodyLimit: 1_024 },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.decisionInbox) return unavailable(request, reply);
      const { leagueId, itemId } = itemPath.parse(request.params);
      const { state } = decisionInboxStateRequestSchema.parse(request.body);
      const result = await options.decisionInbox.setState(user.id, leagueId, itemId, state);
      if (!result) return notFound(request, reply);
      reply.header("Cache-Control", "private, no-store");
      return decisionInboxStateResponseSchema.parse(result);
    },
  );
}
