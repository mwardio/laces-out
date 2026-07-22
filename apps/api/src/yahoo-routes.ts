import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { YahooSyncError, type YahooSyncPort } from "./yahoo-sync.js";

export interface YahooRouteOptions {
  readonly yahooSync?: YahooSyncPort;
  readonly enqueueProjectionRefresh?: (request: {
    readonly season: number;
    readonly reason: "league-sync";
    readonly requestedAt: Date;
  }) => Promise<string | null>;
}

async function enqueueProjectionRefreshes(
  options: YahooRouteOptions,
  seasons: readonly number[],
  request: FastifyRequest,
): Promise<void> {
  if (!options.enqueueProjectionRefresh) return;
  for (const season of new Set(seasons)) {
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

const connectionPathSchema = z.object({ connectionId: z.string().uuid() }).strict();
const leaguePathSchema = z
  .object({
    connectionId: z.string().uuid(),
    leagueKey: z.string().regex(/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$/u),
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

function unavailable(requestId: string) {
  return {
    type: "https://fantasy.local/problems/yahoo-sync-unavailable",
    title: "Yahoo sync is not configured",
    status: 503,
    correlationId: requestId,
  };
}

function sendYahooError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | undefined {
  if (!(error instanceof YahooSyncError)) return undefined;
  return reply
    .code(error.statusCode)
    .type("application/problem+json")
    .send({
      type: `https://fantasy.local/problems/${error.code.toLowerCase().replaceAll("_", "-")}`,
      title:
        error.code === "CONNECTION_NOT_FOUND"
          ? "Yahoo connection not found"
          : error.code === "LOCAL_DISCONNECT_FAILED"
            ? "Yahoo authorization removal failed"
            : "Yahoo sync failed",
      status: error.statusCode,
      detail: error.message,
      code: error.code,
      correlationId: request.id,
    });
}

export function registerYahooRoutes(app: FastifyInstance, options: YahooRouteOptions): void {
  app.get("/v1/connections/yahoo", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.yahooSync) return reply.code(503).send(unavailable(request.id));
    return { connections: await options.yahooSync.listConnections(user.id) };
  });

  app.delete("/v1/connections/yahoo/:connectionId", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.yahooSync) return reply.code(503).send(unavailable(request.id));
    const { connectionId } = connectionPathSchema.parse(request.params);
    try {
      await options.yahooSync.disconnectConnection(user.id, connectionId, request.id);
      return reply.code(204).send();
    } catch (error) {
      const response = sendYahooError(error, request, reply);
      if (response) return response;
      throw error;
    }
  });

  app.post("/v1/connections/yahoo/:connectionId/discover", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.yahooSync) return reply.code(503).send(unavailable(request.id));
    const { connectionId } = connectionPathSchema.parse(request.params);
    try {
      const result = await options.yahooSync.discoverAndSync(user.id, connectionId);
      await enqueueProjectionRefreshes(
        options,
        result.syncs.map((sync) => sync.season),
        request,
      );
      return reply.code(202).send(result);
    } catch (error) {
      const response = sendYahooError(error, request, reply);
      if (response) return response;
      throw error;
    }
  });

  app.post(
    "/v1/connections/yahoo/:connectionId/leagues/:leagueKey/sync",
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.yahooSync) return reply.code(503).send(unavailable(request.id));
      const { connectionId, leagueKey } = leaguePathSchema.parse(request.params);
      try {
        const receipt = await options.yahooSync.syncLeague(user.id, connectionId, leagueKey);
        await enqueueProjectionRefreshes(options, [receipt.season], request);
        return reply.code(receipt.state === "accepted" ? 202 : 200).send(receipt);
      } catch (error) {
        const response = sendYahooError(error, request, reply);
        if (response) return response;
        throw error;
      }
    },
  );
}
