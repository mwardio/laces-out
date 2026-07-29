import {
  changeEventFeedResponseSchema,
  changeEventReceiptResponseSchema,
  type ChangeEventFeedResponse,
  type ChangeEventReceiptResponse,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface ChangeEventQuery {
  readonly limit: number | null;
  readonly cursor: string | null;
  readonly leagueId: string | null;
}

export interface ChangeEventPort {
  list(userId: string, query: ChangeEventQuery): Promise<ChangeEventFeedResponse>;
  markRead(userId: string, eventId: string): Promise<ChangeEventReceiptResponse | undefined>;
  dismiss(userId: string, eventId: string): Promise<ChangeEventReceiptResponse | undefined>;
}

export interface ChangeEventRouteOptions {
  readonly changeEvents?: ChangeEventPort;
  readonly isTest?: boolean;
}

const eventPathSchema = z.object({ eventId: z.string().uuid() }).strict();
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(200).optional(),
    leagueId: z.string().uuid().optional(),
  })
  // `.strict()`, so an unrecognized filter is a 400 rather than a silently ignored parameter that
  // makes the caller think they narrowed the feed.
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

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(503).type("application/problem+json").send({
    type: "https://fantasy.local/problems/change-events-unavailable",
    title: "Change events are not configured",
    status: 503,
    correlationId: request.id,
  });
}

/**
 * One answer for an unknown event, an event the caller cannot see, and an event outside the
 * retention window. Distinguishing them would confirm the existence of another member's event.
 */
function notFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).type("application/problem+json").send({
    type: "https://fantasy.local/problems/change-event-not-found",
    title: "Change event not found",
    status: 404,
    correlationId: request.id,
  });
}

export function registerChangeEventRoutes(
  app: FastifyInstance,
  options: ChangeEventRouteOptions,
): void {
  app.get("/v1/change-events", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.changeEvents) return unavailable(request, reply);
    const query = querySchema.parse(request.query);
    const feed = await options.changeEvents.list(user.id, {
      limit: query.limit ?? null,
      cursor: query.cursor ?? null,
      leagueId: query.leagueId ?? null,
    });
    return changeEventFeedResponseSchema.parse(feed);
  });

  const mutationOptions = {
    // The bodies are empty; the event is named by the path.
    bodyLimit: 1024,
    config: { rateLimit: { max: options.isTest ? 10_000 : 120, timeWindow: "10 minutes" } },
  } as const;

  app.post("/v1/change-events/:eventId/read", mutationOptions, async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.changeEvents) return unavailable(request, reply);
    const { eventId } = eventPathSchema.parse(request.params);
    const receipt = await options.changeEvents.markRead(user.id, eventId);
    if (!receipt) return notFound(request, reply);
    return changeEventReceiptResponseSchema.parse(receipt);
  });

  app.post("/v1/change-events/:eventId/dismiss", mutationOptions, async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.changeEvents) return unavailable(request, reply);
    const { eventId } = eventPathSchema.parse(request.params);
    const receipt = await options.changeEvents.dismiss(user.id, eventId);
    if (!receipt) return notFound(request, reply);
    return changeEventReceiptResponseSchema.parse(receipt);
  });
}
