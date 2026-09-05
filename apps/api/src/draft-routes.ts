import {
  draftAnalysisResponseSchema,
  draftMarketBaselineSchema,
  draftEventAppendRequestSchema,
  draftEventCorrectionRequestSchema,
  draftEventUndoRequestSchema,
  draftManualBackupRequestSchema,
  draftMutationResponseSchema,
  draftSessionCreateRequestSchema,
  draftSessionSnapshotSchema,
  type DraftEventAppendRequest,
  type DraftEventCorrectionRequest,
  type DraftEventUndoRequest,
  type DraftManualBackupRequest,
  type DraftSessionCreateRequest,
} from "@laces-out/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { DraftSessionError } from "./draft-session.js";
import { serverSentEvent, type DraftStreamHub } from "./draft-stream.js";
import { publicLeagueAccessRole, type StoredLeagueAccessRole } from "./public-league-access.js";

/** Keeps proxies and browsers from dropping an idle stream between draft picks. */
const streamKeepAliveMs = 20_000;

export interface DraftSessionPort {
  createSession(actorUserId: string, input: DraftSessionCreateRequest): Promise<unknown>;
  getSession(userId: string, draftId: string): Promise<unknown>;
  appendEvent(
    actorUserId: string,
    draftId: string,
    input: DraftEventAppendRequest,
  ): Promise<unknown>;
  undoEvent(actorUserId: string, draftId: string, input: DraftEventUndoRequest): Promise<unknown>;
  correctEvent(
    actorUserId: string,
    draftId: string,
    input: DraftEventCorrectionRequest,
  ): Promise<unknown>;
}

export interface DraftMarketPort {
  getBaseline(userId: string, draftId: string): Promise<unknown>;
}

export interface DraftAnalysisPort {
  getAnalysis(userId: string, draftId: string): Promise<unknown>;
}

export interface DraftProviderRefreshPort {
  refresh(userId: string, draftId: string): Promise<unknown>;
}

/**
 * Manual backup control, supplied by the ESPN live draft service.
 *
 * Separate from `DraftSessionPort` because a deployment can run manual draft rooms with no provider
 * feed at all; where it is absent the route reports the feature unavailable instead of pretending.
 */
export interface DraftManualBackupPort {
  setManualBackup(
    actorUserId: string,
    draftId: string,
    input: DraftManualBackupRequest,
  ): Promise<{ readonly active: boolean; readonly changed: boolean }>;
}

export interface DraftRouteOptions {
  readonly draftSessions?: DraftSessionPort;
  readonly draftMarket?: DraftMarketPort;
  readonly draftAnalysis?: DraftAnalysisPort;
  readonly draftProviderRefresh?: DraftProviderRefreshPort;
  readonly draftManualBackup?: DraftManualBackupPort;
  readonly draftStream?: DraftStreamHub;
}

const draftPathSchema = z.object({ draftId: z.string().uuid() }).strict();

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
    type: "https://fantasy.local/problems/drafts-unavailable",
    title: "Draft sessions are not configured",
    status: 503,
    correlationId: requestId,
  };
}

function sendDraftError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | undefined {
  if (!(error instanceof DraftSessionError)) return undefined;
  if (error.statusCode >= 500) {
    request.log.error({ err: error, draftErrorCode: error.code }, "draft session request failed");
  }
  return reply
    .code(error.statusCode)
    .type("application/problem+json")
    .send({
      type: `https://fantasy.local/problems/${error.code.toLowerCase().replaceAll("_", "-")}`,
      title:
        error.code === "DRAFT_VERSION_CONFLICT" ? "Draft session changed" : "Draft request failed",
      status: error.statusCode,
      detail: error.message,
      code: error.code,
      ...(error.currentSequence === undefined ? {} : { currentSequence: error.currentSequence }),
      ...(error.invariantCode === undefined ? {} : { invariantCode: error.invariantCode }),
      correlationId: request.id,
    });
}

function rethrowUnknown(error: unknown): never {
  throw error instanceof Error
    ? error
    : new Error("Unknown draft request failure", { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicDraftSession(value: unknown): unknown {
  if (!isRecord(value) || typeof value.accessRole !== "string") return value;
  return {
    ...value,
    accessRole: publicLeagueAccessRole({ role: value.accessRole as StoredLeagueAccessRole }),
  };
}

function validatedSession(value: unknown) {
  const result = draftSessionSnapshotSchema.safeParse(publicDraftSession(value));
  if (!result.success) {
    throw new Error("Draft session service returned an invalid response", {
      cause: result.error,
    });
  }
  return result.data;
}

function validatedAnalysis(value: unknown) {
  const result = draftAnalysisResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Draft analysis service returned an invalid response", {
      cause: result.error,
    });
  }
  return result.data;
}

function validatedMutation(value: unknown) {
  const serialized = isRecord(value)
    ? { ...value, session: publicDraftSession(value.session) }
    : value;
  const result = draftMutationResponseSchema.safeParse(serialized);
  if (!result.success) {
    throw new Error("Draft session service returned an invalid mutation response", {
      cause: result.error,
    });
  }
  return result.data;
}

export function registerDraftRoutes(app: FastifyInstance, options: DraftRouteOptions): void {
  app.post("/v1/drafts", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions) return reply.code(503).send(unavailable(request.id));
    try {
      const session = await options.draftSessions.createSession(
        user.id,
        draftSessionCreateRequestSchema.parse(request.body),
      );
      return reply.code(201).send(validatedSession(session));
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });

  app.get("/v1/drafts/:draftId/stream", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions || !options.draftStream) {
      return reply.code(503).send(unavailable(request.id));
    }
    const { draftId } = draftPathSchema.parse(request.params);
    // Authorize through the normal read path first: a stream must never reveal that a draft
    // exists to someone who could not GET it.
    try {
      validatedSession(await options.draftSessions.getSession(user.id, draftId));
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }

    const listen = options.draftStream.subscribe(draftId, (event) => {
      reply.raw.write(serverSentEvent(event));
    });
    if (!listen) {
      return reply.code(503).send({
        type: "https://fantasy.local/problems/draft-stream-saturated",
        title: "Too many live viewers for this draft",
        status: 503,
        detail: "Reconnect shortly; the draft board continues to refresh by polling.",
        correlationId: request.id,
      });
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`retry: 5000\n\n`);

    const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), streamKeepAliveMs);
    const close = (): void => {
      clearInterval(keepAlive);
      listen();
    };
    request.raw.on("close", close);
    reply.raw.on("error", close);
    return reply;
  });

  app.get("/v1/drafts/:draftId", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions) return reply.code(503).send(unavailable(request.id));
    const { draftId } = draftPathSchema.parse(request.params);
    try {
      return validatedSession(await options.draftSessions.getSession(user.id, draftId));
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });

  app.post("/v1/drafts/:draftId/provider-refresh", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions || !options.draftProviderRefresh) {
      return reply.code(503).send(unavailable(request.id));
    }
    const { draftId } = draftPathSchema.parse(request.params);
    try {
      return validatedSession(await options.draftProviderRefresh.refresh(user.id, draftId));
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });

  app.get("/v1/drafts/:draftId/market", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftMarket) return reply.code(503).send(unavailable(request.id));
    const { draftId } = draftPathSchema.parse(request.params);
    return draftMarketBaselineSchema.parse(await options.draftMarket.getBaseline(user.id, draftId));
  });

  /**
   * Post-draft and in-progress analysis for one room.
   *
   * The service authorizes through the same session read as `GET /v1/drafts/:draftId`, and the
   * `try`/`catch` around `sendDraftError` is what keeps the unknown-draft body byte-identical to
   * it. Do not copy the `/market` handler above, which has no catch.
   */
  app.get("/v1/drafts/:draftId/analysis", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftAnalysis) return reply.code(503).send(unavailable(request.id));
    const { draftId } = draftPathSchema.parse(request.params);
    try {
      return validatedAnalysis(await options.draftAnalysis.getAnalysis(user.id, draftId));
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });

  app.post("/v1/drafts/:draftId/events", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions) return reply.code(503).send(unavailable(request.id));
    const { draftId } = draftPathSchema.parse(request.params);
    try {
      const result = validatedMutation(
        await options.draftSessions.appendEvent(
          user.id,
          draftId,
          draftEventAppendRequestSchema.parse(request.body),
        ),
      );
      return reply.code(result.idempotent ? 200 : 201).send(result);
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });

  app.post("/v1/drafts/:draftId/undo", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions) return reply.code(503).send(unavailable(request.id));
    const { draftId } = draftPathSchema.parse(request.params);
    try {
      const result = validatedMutation(
        await options.draftSessions.undoEvent(
          user.id,
          draftId,
          draftEventUndoRequestSchema.parse(request.body),
        ),
      );
      return reply.code(result.idempotent ? 200 : 201).send(result);
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });

  /**
   * Freezes or resumes provider application for a shared room (plan §7.3, §16.5).
   *
   * A normal cookie-authenticated draft mutation, not a bridge upload: only someone with explicit
   * or provider-derived commissioner authority may change what every viewer sees. It appends
   * nothing, so the answer is the session snapshot rather than a mutation envelope with an empty
   * sequence list.
   */
  app.post("/v1/drafts/:draftId/manual-backup", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions || !options.draftManualBackup) {
      return reply.code(503).send(unavailable(request.id));
    }
    const { draftId } = draftPathSchema.parse(request.params);
    const input = draftManualBackupRequestSchema.parse(request.body);
    try {
      const outcome = await options.draftManualBackup.setManualBackup(user.id, draftId, input);
      const session = validatedSession(await options.draftSessions.getSession(user.id, draftId));
      // Identifier-only audit line: what changed about shared draft control, and on whose say-so.
      request.log.info(
        {
          draftId,
          manualBackupActive: outcome.active,
          manualBackupChanged: outcome.changed,
          reconciliation: input.reconciliation ?? null,
        },
        "draft manual backup mode set",
      );
      return reply.code(200).send(session);
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });

  app.post("/v1/drafts/:draftId/corrections", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftSessions) return reply.code(503).send(unavailable(request.id));
    const { draftId } = draftPathSchema.parse(request.params);
    try {
      const result = validatedMutation(
        await options.draftSessions.correctEvent(
          user.id,
          draftId,
          draftEventCorrectionRequestSchema.parse(request.body),
        ),
      );
      return reply.code(result.idempotent ? 200 : 201).send(result);
    } catch (error) {
      return sendDraftError(error, request, reply) ?? rethrowUnknown(error);
    }
  });
}
