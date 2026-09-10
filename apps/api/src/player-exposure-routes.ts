import { playerExposureResponseSchema } from "@laces-out/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface PlayerExposurePort {
  getExposure(userId: string): Promise<unknown>;
}

const exposureQuery = z.object({}).strict();

export function registerPlayerExposureRoutes(
  app: FastifyInstance,
  options: { playerExposure?: PlayerExposurePort },
): void {
  app.get("/v1/portfolio/player-exposure", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const user = request.currentUser;
    if (!user) {
      return reply.code(401).type("application/problem+json").send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    exposureQuery.parse(request.query);
    if (!options.playerExposure) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/player-exposure-unavailable",
        title: "Player exposure is not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    return playerExposureResponseSchema.parse(await options.playerExposure.getExposure(user.id));
  });
}
