import {
  draftMarketBaselineSchema,
  draftEventAppendRequestSchema,
  draftEventCorrectionRequestSchema,
  draftEventUndoRequestSchema,
  draftMutationResponseSchema,
  draftSessionCreateRequestSchema,
  draftSessionSnapshotSchema,
  type DraftEventAppendRequest,
  type DraftEventCorrectionRequest,
  type DraftEventUndoRequest,
  type DraftSessionCreateRequest,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { DraftSessionError } from "./draft-session.js";

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

export interface DraftRouteOptions {
  readonly draftSessions?: DraftSessionPort;
  readonly draftMarket?: DraftMarketPort;
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

function validatedSession(value: unknown) {
  const result = draftSessionSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Draft session service returned an invalid response", {
      cause: result.error,
    });
  }
  return result.data;
}

function validatedMutation(value: unknown) {
  const result = draftMutationResponseSchema.safeParse(value);
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

  app.get("/v1/drafts/:draftId/market", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.draftMarket) return reply.code(503).send(unavailable(request.id));
    const { draftId } = draftPathSchema.parse(request.params);
    return draftMarketBaselineSchema.parse(await options.draftMarket.getBaseline(user.id, draftId));
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
