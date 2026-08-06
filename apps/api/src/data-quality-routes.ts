import {
  dataQualityResponseSchema,
  unresolvedIdentityResponseSchema,
  type DataQualityResponse,
  type UnresolvedIdentityResponse,
} from "@laces-out/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface DataQualityPort {
  getSourceQuality(): Promise<DataQualityResponse>;
  getUnresolvedIdentities(key: string): Promise<UnresolvedIdentityResponse | undefined>;
}

export interface DataQualityRouteOptions {
  readonly dataQuality?: DataQualityPort;
}

/** The same pattern `data_sources_key_check` enforces (`packages/db/src/schema.ts:1014`). */
const sourceKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u);
const sourcePathSchema = z.object({ key: sourceKeySchema }).strict();

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
    type: "https://fantasy.local/problems/data-quality-unavailable",
    title: "Source quality reporting is not configured",
    status: 503,
    correlationId: request.id,
  });
}

/**
 * Source identity quality for NFL data. Neither handler accepts, reads, or joins a `leagueId`: these
 * observation tables carry no league or user column, so a membership lookup here could only add a
 * way to leak another league's context.
 */
export function registerDataQualityRoutes(
  app: FastifyInstance,
  options: DataQualityRouteOptions,
): void {
  // Authenticated at any role, mirroring `/v1/projections/ros-status`. It performs no mutation and
  // surfaces no secret or source row, only admission state, match rates, reasons, and provenance —
  // which a member needs in order to understand why an analysis surface is withheld.
  app.get("/v1/data-quality/sources", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.dataQuality) return unavailable(request, reply);
    const result = await options.dataQuality.getSourceQuality();
    return dataQualityResponseSchema.parse(result);
  });

  // Administrator only, mirroring `apps/api/src/invitation-routes.ts:83`. This returns unaggregated
  // upstream source rows; nothing else in this repository exposes those to a non-admin, and an
  // external-identifier sample is only actionable to someone who can act on ingestion.
  app.get("/v1/data-quality/sources/:key/unresolved", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (user.role !== "admin") {
      return reply.code(403).type("application/problem+json").send({
        type: "https://fantasy.local/problems/forbidden",
        title: "Administrator access is required",
        status: 403,
        correlationId: request.id,
      });
    }
    if (!options.dataQuality) return unavailable(request, reply);
    const { key } = sourcePathSchema.parse(request.params);
    const result = await options.dataQuality.getUnresolvedIdentities(key);
    if (!result) {
      return reply.code(404).type("application/problem+json").send({
        type: "https://fantasy.local/problems/data-source-not-found",
        title: "Data source not found",
        status: 404,
        correlationId: request.id,
      });
    }
    return unresolvedIdentityResponseSchema.parse(result);
  });
}
