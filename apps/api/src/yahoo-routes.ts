import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { RecommendationKind } from "@fantasy/jobs";

import {
  emitProviderSyncChangeEvents,
  type ChangeEventProducerDependencies,
} from "./change-event-producers.js";
import { YahooSyncError, type YahooSyncPort, type YahooSyncReceipt } from "./yahoo-sync.js";

export interface YahooRouteOptions {
  readonly yahooSync?: YahooSyncPort;
  readonly enqueueProjectionRefresh?: (request: {
    readonly season: number;
    readonly reason: "league-sync";
    readonly requestedAt: Date;
  }) => Promise<string | null>;
  readonly enqueueRecommendationRecompute?: (request: {
    readonly leagueSeasonId: string;
    readonly kinds: readonly RecommendationKind[];
    readonly requestedAt: Date;
  }) => Promise<string | null>;
  /** Absent in tests and in a deployment that has not wired the feed; emitting is then a no-op. */
  readonly changeEventProducers?: ChangeEventProducerDependencies;
}

/**
 * Emitted after the persister committed, only for a receipt that actually changed something, and
 * inside the producer's own `try/catch`: a change-event failure must never fail a good sync.
 *
 * The Yahoo receipt carries no artifact checksum, but `syncRunId` is one-to-one with an admitted
 * artifact — `sync_runs.idempotency_key` embeds the checksum and an unchanged payload never reaches
 * `state: "accepted"` — so it is the artifact identity for this producer.
 */
async function emitYahooChangeEvents(
  options: YahooRouteOptions,
  receipts: readonly YahooSyncReceipt[],
  request: FastifyRequest,
): Promise<void> {
  const producers = options.changeEventProducers;
  if (!producers) return;
  const now = new Date();
  for (const receipt of receipts) {
    await emitProviderSyncChangeEvents(
      producers,
      {
        provider: "yahoo",
        state: receipt.state,
        leagueId: receipt.leagueId,
        leagueSeasonId: receipt.leagueSeasonId,
        actorUserId: null,
        artifactId: receipt.syncRunId,
        occurredAt: now,
      },
      (error) =>
        request.log.warn(
          { err: error, leagueSeasonId: receipt.leagueSeasonId },
          "Yahoo sync succeeded but change-event emission failed",
        ),
    );
  }
}

/** Mirrors the ESPN ingest path: `draft` has no in-season producer and is deliberately absent. */
const INGESTION_RECOMPUTE_KINDS: readonly RecommendationKind[] = ["lineup", "trade", "waiver"];

/**
 * Queued only for a receipt that actually changed something. An unchanged Yahoo payload therefore
 * cannot produce a duplicate recommendation run.
 */
async function enqueueRecomputes(
  options: YahooRouteOptions,
  receipts: readonly YahooSyncReceipt[],
  request: FastifyRequest,
): Promise<void> {
  if (!options.enqueueRecommendationRecompute) return;
  const leagueSeasonIds = new Set(
    receipts.filter((receipt) => receipt.state === "accepted").map((r) => r.leagueSeasonId),
  );
  for (const leagueSeasonId of leagueSeasonIds) {
    try {
      await options.enqueueRecommendationRecompute({
        leagueSeasonId,
        kinds: INGESTION_RECOMPUTE_KINDS,
        requestedAt: new Date(),
      });
    } catch (error) {
      request.log.warn(
        { err: error, leagueSeasonId },
        "Yahoo sync succeeded but recommendation recompute enqueue failed",
      );
    }
  }
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

  app.post(
    "/v1/connections/yahoo/:connectionId/discover",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
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
        await enqueueRecomputes(options, result.syncs, request);
        await emitYahooChangeEvents(options, result.syncs, request);
        return reply.code(202).send(result);
      } catch (error) {
        const response = sendYahooError(error, request, reply);
        if (response) return response;
        throw error;
      }
    },
  );

  app.post(
    "/v1/connections/yahoo/:connectionId/leagues/:leagueKey/sync",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.yahooSync) return reply.code(503).send(unavailable(request.id));
      const { connectionId, leagueKey } = leaguePathSchema.parse(request.params);
      try {
        const receipt = await options.yahooSync.syncLeague(user.id, connectionId, leagueKey);
        await enqueueProjectionRefreshes(options, [receipt.season], request);
        await enqueueRecomputes(options, [receipt], request);
        await emitYahooChangeEvents(options, [receipt], request);
        return reply.code(receipt.state === "accepted" ? 202 : 200).send(receipt);
      } catch (error) {
        const response = sendYahooError(error, request, reply);
        if (response) return response;
        throw error;
      }
    },
  );
}
