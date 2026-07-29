import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { RosProjectionStatusResponse } from "./ros-projection-status.js";

export interface RosProjectionStatusPort {
  getStatus(input: {
    readonly season: number;
    readonly userId: string;
  }): Promise<RosProjectionStatusResponse>;
}

export interface RosProjectionStatusRouteOptions {
  readonly rosProjectionStatus?: RosProjectionStatusPort;
  readonly now?: () => Date;
}

const querySchema = z
  .object({ season: z.coerce.number().int().min(2000).max(2200).optional() })
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

export function registerRosProjectionStatusRoutes(
  app: FastifyInstance,
  options: RosProjectionStatusRouteOptions,
): void {
  // Read-only inspection of the ROS rail. Authenticated like neighbouring routes; it performs no
  // mutation and surfaces no secret, only rail state, audit reasons, and provenance. League-scoped
  // facts are restricted to the caller's own memberships.
  app.get("/v1/projections/ros-status", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rosProjectionStatus) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/ros-projection-status-unavailable",
        title: "Rest-of-season projection status is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const query = querySchema.parse(request.query);
    const season = query.season ?? (options.now ?? (() => new Date()))().getUTCFullYear();
    return options.rosProjectionStatus.getStatus({ season, userId: user.id });
  });
}
