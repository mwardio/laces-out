import { MAX_ESPN_IMPORT_BYTES } from "@fantasy/connector-espn";
import {
  espnManualImportCommitRequestSchema,
  espnManualImportCommitResponseSchema,
  espnManualImportPreviewResponseSchema,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { previewEspnManualImport, type EspnManualImportService } from "./espn-import.js";

export type EspnManualImportPort = Pick<EspnManualImportService, "commit">;

export interface EspnManualImportRouteOptions {
  readonly espnImports?: EspnManualImportPort;
}

const commitBodyLimit = MAX_ESPN_IMPORT_BYTES + 4 * 1024;

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
    type: "https://fantasy.local/problems/espn-import-unavailable",
    title: "ESPN snapshot persistence is not configured",
    status: 503,
    correlationId: requestId,
  };
}

export function registerEspnManualImportRoutes(
  app: FastifyInstance,
  options: EspnManualImportRouteOptions,
): void {
  // Preview remains storage-free so operators can validate recovery artifacts even when the
  // database-backed import service is temporarily unavailable.
  app.post(
    "/v1/connections/espn/import/validate",
    {
      bodyLimit: MAX_ESPN_IMPORT_BYTES,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!authenticatedUser(request, reply)) return reply;
      return espnManualImportPreviewResponseSchema.parse(previewEspnManualImport(request.body));
    },
  );

  app.post(
    "/v1/connections/espn/import/commit",
    {
      bodyLimit: commitBodyLimit,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.espnImports) return reply.code(503).send(unavailable(request.id));
      const input = espnManualImportCommitRequestSchema.parse(request.body);
      const result = espnManualImportCommitResponseSchema.parse(
        await options.espnImports.commit(user.id, input),
      );
      return reply.code(result.state === "unchanged" ? 200 : 201).send(result);
    },
  );
}
