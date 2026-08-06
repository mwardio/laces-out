import {
  pushConfigurationSchema,
  pushDeviceListResponseSchema,
  pushDeviceRevokeResponseSchema,
  pushSubscriptionRequestSchema,
  pushTestResponseSchema,
} from "@laces-out/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  PushConfigurationResult,
  PushDeviceListResult,
  PushDeviceStatus,
  PushSubscriptionInput,
  PushTestResult,
} from "./push-subscriptions.js";

export interface PushPort {
  configuration(): PushConfigurationResult;
  list(userId: string): Promise<PushDeviceListResult>;
  register(userId: string, input: PushSubscriptionInput): Promise<PushDeviceStatus>;
  revoke(
    userId: string,
    subscriptionId: string,
  ): Promise<{ readonly subscriptionId: string; readonly revokedAt: string } | undefined>;
  sendTest(
    userId: string,
    payload: {
      readonly title: string;
      readonly body: string;
      readonly url: string;
      readonly tag: string;
    },
  ): Promise<PushTestResult>;
}

export interface PushRouteOptions {
  readonly push?: PushPort;
  readonly isTest?: boolean;
}

const subscriptionPathSchema = z.object({ subscriptionId: z.string().uuid() });

/**
 * A subscription body is one endpoint plus two short keys. The default 1 MiB body limit would let
 * a signed-in member post a megabyte of text into a column-checked table for no reason.
 */
const SUBSCRIPTION_BODY_LIMIT = 8 * 1024;

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

function unconfigured(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(503).type("application/problem+json").send({
    type: "https://fantasy.local/problems/push-unavailable",
    title: "Game day alerts are unavailable",
    status: 503,
    detail: "This Laces Out instance is not sending browser notifications yet.",
    correlationId: request.id,
  });
}

/**
 * Session-authenticated push device management. Every route is scoped to the calling member: a
 * device list, a registration, and a revoke can only ever name the caller's own rows. Endpoints
 * and keys are accepted and stored but never echoed back or logged.
 */
export function registerPushRoutes(app: FastifyInstance, options: PushRouteOptions): void {
  app.get("/v1/push/config", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    // Absent service and absent keys are the same answer to the client: unavailable, not broken.
    const configuration = options.push?.configuration() ?? { available: false, publicKey: null };
    return pushConfigurationSchema.parse(configuration);
  });

  app.get("/v1/push/subscriptions", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.push) return unconfigured(request, reply);
    return pushDeviceListResponseSchema.parse(await options.push.list(user.id));
  });

  app.post(
    "/v1/push/subscriptions",
    {
      bodyLimit: SUBSCRIPTION_BODY_LIMIT,
      config: {
        rateLimit: { max: options.isTest ? 10_000 : 20, timeWindow: "10 minutes" },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.push) return unconfigured(request, reply);
      if (!options.push.configuration().available) return unconfigured(request, reply);
      const input = pushSubscriptionRequestSchema.parse(request.body);
      const device = await options.push.register(user.id, {
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgentLabel: input.label ?? null,
      });
      return reply.code(201).send(device);
    },
  );

  app.delete("/v1/push/subscriptions/:subscriptionId", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.push) return unconfigured(request, reply);
    const { subscriptionId } = subscriptionPathSchema.parse(request.params);
    const revoked = await options.push.revoke(user.id, subscriptionId);
    if (!revoked) {
      return reply.code(404).type("application/problem+json").send({
        type: "https://fantasy.local/problems/push-subscription-not-found",
        title: "Push device not found",
        status: 404,
        correlationId: request.id,
      });
    }
    return pushDeviceRevokeResponseSchema.parse(revoked);
  });

  app.post(
    "/v1/push/test",
    {
      config: {
        rateLimit: { max: options.isTest ? 10_000 : 5, timeWindow: "10 minutes" },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.push) return unconfigured(request, reply);
      if (!options.push.configuration().available) return unconfigured(request, reply);
      const result = await options.push.sendTest(user.id, {
        title: "Laces Out test alert",
        body: "Game day alerts are working on this device.",
        url: "/settings",
        tag: "push-test",
      });
      return pushTestResponseSchema.parse(result);
    },
  );
}
