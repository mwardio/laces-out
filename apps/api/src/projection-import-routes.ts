import {
  projectionPlayerListResponseSchema,
  projectionImportCommitResponseSchema,
  projectionImportPreviewResponseSchema,
  projectionSetListResponseSchema,
  projectionVisibilitySchema,
} from "@fantasy/contracts";
import {
  normalizeProjectionSourceObservedAt,
  PROJECTION_IMPORT_DEFAULT_LIMITS,
} from "@fantasy/projections";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ProjectionImportRequest, ProjectionImportService } from "./projection-import.js";

export type ProjectionImportPort = Pick<
  ProjectionImportService,
  "list" | "getPlayers" | "preview" | "commit"
>;

export interface ProjectionImportRouteOptions {
  readonly projectionImports?: ProjectionImportPort;
}

const leagueSeasonPathSchema = z.object({ leagueSeasonId: z.string().uuid() }).strict();
const projectionSetPathSchema = z
  .object({
    leagueSeasonId: z.string().uuid(),
    projectionSetId: z.string().uuid(),
  })
  .strict();
const checksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const safeFileName = (value: string): boolean =>
  !value.includes("/") &&
  !value.includes("\\") &&
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  });
const strictSourceObservedAtSchema = z.string().refine((value) => {
  try {
    normalizeProjectionSourceObservedAt(value);
    return true;
  } catch {
    return false;
  }
}, "Source as-of time must be a valid UTC ISO timestamp");
const metadataShape = {
  season: z.number().int().min(2000).max(2100),
  week: z.number().int().min(1).max(18),
  horizon: z.literal("week"),
  sourceLabel: z.string().min(2).max(80),
  sourceObservedAt: strictSourceObservedAtSchema,
} as const;
const importShape = {
  csv: z.string().min(1).max(PROJECTION_IMPORT_DEFAULT_LIMITS.maxBytes),
  metadata: z.object(metadataShape).strict(),
  visibility: projectionVisibilitySchema,
  sourceFileName: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine(safeFileName, "File name contains unsafe characters")
    .nullable()
    .optional(),
} as const;
const previewRequestSchema = z.object(importShape).strict();
const commitRequestSchema = z
  .object({ ...importShape, expectedImportChecksum: checksumSchema })
  .strict();
const requestBodyLimit = PROJECTION_IMPORT_DEFAULT_LIMITS.maxBytes + 128 * 1024;

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
    type: "https://fantasy.local/problems/projection-imports-unavailable",
    title: "Projection imports are not configured",
    status: 503,
    correlationId: requestId,
  };
}

export function registerProjectionImportRoutes(
  app: FastifyInstance,
  options: ProjectionImportRouteOptions,
): void {
  app.get("/v1/league-seasons/:leagueSeasonId/projections", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.projectionImports) return reply.code(503).send(unavailable(request.id));
    const { leagueSeasonId } = leagueSeasonPathSchema.parse(request.params);
    return projectionSetListResponseSchema.parse(
      await options.projectionImports.list(user.id, leagueSeasonId),
    );
  });

  app.get(
    "/v1/league-seasons/:leagueSeasonId/projections/:projectionSetId/players",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.projectionImports) return reply.code(503).send(unavailable(request.id));
      const { leagueSeasonId, projectionSetId } = projectionSetPathSchema.parse(request.params);
      return projectionPlayerListResponseSchema.parse(
        await options.projectionImports.getPlayers(user.id, leagueSeasonId, projectionSetId),
      );
    },
  );

  app.post(
    "/v1/league-seasons/:leagueSeasonId/projections/preview",
    {
      bodyLimit: requestBodyLimit,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.projectionImports) return reply.code(503).send(unavailable(request.id));
      const { leagueSeasonId } = leagueSeasonPathSchema.parse(request.params);
      const input: ProjectionImportRequest = previewRequestSchema.parse(request.body);
      return projectionImportPreviewResponseSchema.parse(
        await options.projectionImports.preview(user.id, leagueSeasonId, input),
      );
    },
  );

  app.post(
    "/v1/league-seasons/:leagueSeasonId/projections",
    {
      bodyLimit: requestBodyLimit,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.projectionImports) return reply.code(503).send(unavailable(request.id));
      const { leagueSeasonId } = leagueSeasonPathSchema.parse(request.params);
      const input = commitRequestSchema.parse(request.body);
      const result = projectionImportCommitResponseSchema.parse(
        await options.projectionImports.commit(user.id, leagueSeasonId, input),
      );
      return reply.code(result.deduplicated ? 200 : 201).send(result);
    },
  );
}
