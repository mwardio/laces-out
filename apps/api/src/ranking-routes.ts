import {
  MAX_RANKING_CSV_BYTES,
  csvColumnMappingSchema,
  positionSchema,
  rankingVisibilitySchema,
} from "@fantasy/rankings";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { RankingService } from "./ranking-service.js";

export type RankingPort = Pick<
  RankingService,
  | "listLists"
  | "createList"
  | "editList"
  | "getList"
  | "getVersion"
  | "getPlayerIdentities"
  | "cloneList"
  | "compareLists"
  | "replaceWithManualDraft"
  | "applyUserOverlay"
  | "publish"
  | "previewCsv"
  | "importCsv"
  | "importJson"
  | "export"
  | "createShare"
  | "openShare"
  | "exportShare"
  | "revokeShare"
>;

export interface RankingRouteOptions {
  readonly rankings?: RankingPort;
  readonly webUrl: string;
}

const uuidSchema = z.string().uuid();
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const listParamsSchema = z.object({ listId: uuidSchema }).strict();
const shareParamsSchema = z.object({ listId: uuidSchema, shareId: uuidSchema }).strict();
const listQuerySchema = z
  .object({ includeArchived: z.enum(["true", "false"]).optional() })
  .strict();
const scoringContextSchema = z
  .object({
    format: z.enum(["STANDARD", "HALF_PPR", "PPR", "CUSTOM"]),
    leagueId: uuidSchema.nullable(),
    settingsChecksumSha256: checksumSchema.nullable(),
    label: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();
const createListSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4_000).nullable().optional(),
    season: z.number().int().min(2000).max(2100),
    kind: z.enum(["rankings", "adp", "auction-values", "cheat-sheet"]),
    scoringContext: scoringContextSchema,
    visibility: rankingVisibilitySchema.optional(),
  })
  .strict();
const editListSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(4_000).nullable().optional(),
    visibility: rankingVisibilitySchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();
const cloneListSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    sourceVersionId: uuidSchema.optional(),
    changeNote: z.string().max(2_000).nullable().optional(),
  })
  .strict();
const compareListsSchema = z
  .object({
    left: z.object({ listId: uuidSchema, versionId: uuidSchema.optional() }).strict(),
    right: z.object({ listId: uuidSchema, versionId: uuidSchema.optional() }).strict(),
  })
  .strict();

const manualValuesShape = {
  overallRank: z.number().int().min(1).max(10_000).nullable().optional(),
  positionRank: z.number().int().min(1).max(10_000).nullable().optional(),
  tier: z.number().int().min(1).max(10_000).nullable().optional(),
  adp: z.number().finite().gt(0).max(10_000).nullable().optional(),
  aav: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  floorPrice: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  targetPrice: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  ceilingPrice: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  confidence: z.number().finite().min(0).max(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(64).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  target: z.boolean().nullable().optional(),
  avoid: z.boolean().nullable().optional(),
} as const;
const manualEntrySchema = z
  .object({ playerId: uuidSchema, position: positionSchema.nullable(), ...manualValuesShape })
  .strict();
const manualDraftSchema = z
  .object({
    expectedCurrentVersionId: uuidSchema.nullable(),
    entries: z.array(manualEntrySchema).max(10_000),
    changeNote: z.string().max(2_000).nullable().optional(),
  })
  .strict();
const overlayPatchSchema = z
  .object({
    playerId: uuidSchema,
    position: positionSchema.nullable().optional(),
    ...manualValuesShape,
  })
  .strict();
const overlaySchema = z
  .object({
    baseVersionId: uuidSchema,
    patches: z.array(overlayPatchSchema).min(1).max(10_000),
    changeNote: z.string().max(2_000).nullable().optional(),
  })
  .strict();
const publishSchema = z
  .object({
    expectedCurrentVersionId: uuidSchema,
    changeNote: z.string().max(2_000).nullable().optional(),
  })
  .strict();
const currentVersionQuerySchema = z.object({ versionId: uuidSchema.optional() }).strict();

const boundedSourceSchema = z.string().min(1).max(MAX_RANKING_CSV_BYTES);
const csvBaseShape = {
  source: boundedSourceSchema,
  mapping: csvColumnMappingSchema,
  hasHeader: z.boolean().optional(),
} as const;
const csvPreviewSchema = z.object(csvBaseShape).strict();
const csvDecisionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all-valid"), previewChecksumSha256: checksumSchema }).strict(),
  z
    .object({
      mode: z.literal("selected-rows"),
      previewChecksumSha256: checksumSchema,
      rowNumbers: z.array(z.number().int().min(1)).min(1).max(20_000),
    })
    .strict(),
]);
const csvCommitSchema = z
  .object({
    ...csvBaseShape,
    expectedCurrentVersionId: uuidSchema.nullable(),
    idempotencyKey: z.string().trim().min(8).max(200),
    sourceFileName: z.string().trim().min(1).max(240).nullable().optional(),
    decision: csvDecisionSchema,
    changeNote: z.string().max(2_000).nullable().optional(),
  })
  .strict();
const jsonCommitSchema = z
  .object({
    source: boundedSourceSchema,
    expectedCurrentVersionId: uuidSchema.nullable(),
    idempotencyKey: z.string().trim().min(8).max(200),
    sourceFileName: z.string().trim().min(1).max(240).nullable().optional(),
    changeNote: z.string().max(2_000).nullable().optional(),
  })
  .strict();
const exportQuerySchema = z
  .object({ format: z.enum(["json", "csv"]), versionId: uuidSchema.optional() })
  .strict();
const shareCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(160).nullable().optional(),
    allowCopy: z.boolean().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  })
  .strict();
const shareCapabilitySchema = z
  .object({ token: z.string().regex(/^frs_[A-Za-z0-9_-]{43}$/u) })
  .strict();
const shareExportSchema = shareCapabilitySchema.extend({ format: z.enum(["json", "csv"]) });

function unavailable(requestId: string) {
  return {
    type: "https://fantasy.local/problems/rankings-unavailable",
    title: "Rankings are not configured",
    status: 503,
    correlationId: requestId,
  };
}

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

function sendExport(reply: FastifyReply, format: "json" | "csv", content: string) {
  const extension = format === "csv" ? "csv" : "json";
  return reply
    .type(format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8")
    .header("content-disposition", `attachment; filename="laces-out-rankings.${extension}"`)
    .send(content);
}

function rankingCapabilities(userId: string, list: Awaited<ReturnType<RankingPort["getList"]>>) {
  const owner = list.ownerUserId === userId;
  return {
    canEdit: owner,
    canClone: owner || (list.visibility.scope === "league" && list.visibility.allowClone === true),
    canCompare: true,
  } as const;
}

export function registerRankingRoutes(app: FastifyInstance, options: RankingRouteOptions): void {
  app.get("/v1/rankings", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const query = listQuerySchema.parse(request.query);
    const lists = await options.rankings.listLists(user.id, {
      includeArchived: query.includeArchived === "true",
    });
    return {
      lists: lists.map((list) => ({
        ...list,
        capabilities: rankingCapabilities(user.id, list),
      })),
    };
  });

  app.post("/v1/rankings", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const list = await options.rankings.createList(user.id, createListSchema.parse(request.body));
    return reply
      .code(201)
      .send({ list: { ...list, capabilities: rankingCapabilities(user.id, list) } });
  });

  app.post("/v1/rankings/compare", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const input = compareListsSchema.parse(request.body);
    const comparison = await options.rankings.compareLists({
      actorUserId: user.id,
      leftListId: input.left.listId,
      ...(input.left.versionId === undefined ? {} : { leftVersionId: input.left.versionId }),
      rightListId: input.right.listId,
      ...(input.right.versionId === undefined ? {} : { rightVersionId: input.right.versionId }),
    });
    return {
      ...comparison,
      left: {
        ...comparison.left,
        list: {
          ...comparison.left.list,
          capabilities: rankingCapabilities(user.id, comparison.left.list),
        },
      },
      right: {
        ...comparison.right,
        list: {
          ...comparison.right.list,
          capabilities: rankingCapabilities(user.id, comparison.right.list),
        },
      },
    };
  });

  app.get("/v1/rankings/:listId", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const list = await options.rankings.getList(user.id, listId);
    return { list: { ...list, capabilities: rankingCapabilities(user.id, list) } };
  });

  app.patch("/v1/rankings/:listId", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const list = await options.rankings.editList(
      user.id,
      listId,
      editListSchema.parse(request.body),
    );
    return { list: { ...list, capabilities: rankingCapabilities(user.id, list) } };
  });

  app.post("/v1/rankings/:listId/clone", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const input = cloneListSchema.parse(request.body);
    const cloned = await options.rankings.cloneList({
      actorUserId: user.id,
      sourceListId: listId,
      name: input.name,
      ...(input.sourceVersionId === undefined ? {} : { sourceVersionId: input.sourceVersionId }),
      ...(input.changeNote === undefined ? {} : { changeNote: input.changeNote }),
    });
    return reply.code(201).send({
      ...cloned,
      list: {
        ...cloned.list,
        capabilities: rankingCapabilities(user.id, cloned.list),
      },
    });
  });

  app.get("/v1/rankings/:listId/version", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const { versionId } = currentVersionQuerySchema.parse(request.query);
    const version = await options.rankings.getVersion(user.id, listId, versionId);
    return {
      version,
      players: await options.rankings.getPlayerIdentities(
        user.id,
        version.entries.map((entry) => entry.playerId),
      ),
    };
  });

  app.put("/v1/rankings/:listId/draft", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const input = manualDraftSchema.parse(request.body);
    return {
      version: await options.rankings.replaceWithManualDraft({
        actorUserId: user.id,
        listId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        entries: input.entries,
        ...(input.changeNote === undefined ? {} : { changeNote: input.changeNote }),
      }),
    };
  });

  app.patch("/v1/rankings/:listId/draft", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const input = overlaySchema.parse(request.body);
    return {
      version: await options.rankings.applyUserOverlay({
        actorUserId: user.id,
        listId,
        baseVersionId: input.baseVersionId,
        patches: input.patches,
        ...(input.changeNote === undefined ? {} : { changeNote: input.changeNote }),
      }),
    };
  });

  app.post("/v1/rankings/:listId/publish", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const input = publishSchema.parse(request.body);
    return {
      version: await options.rankings.publish({
        actorUserId: user.id,
        listId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        ...(input.changeNote === undefined ? {} : { changeNote: input.changeNote }),
      }),
    };
  });

  app.post(
    "/v1/rankings/:listId/imports/csv/preview",
    { bodyLimit: 6 * 1024 * 1024 },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.rankings) return reply.code(503).send(unavailable(request.id));
      const { listId } = listParamsSchema.parse(request.params);
      const input = csvPreviewSchema.parse(request.body);
      return {
        preview: await options.rankings.previewCsv({
          actorUserId: user.id,
          listId,
          source: input.source,
          mapping: input.mapping,
          ...(input.hasHeader === undefined ? {} : { hasHeader: input.hasHeader }),
        }),
      };
    },
  );

  app.post(
    "/v1/rankings/:listId/imports/csv",
    { bodyLimit: 6 * 1024 * 1024 },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.rankings) return reply.code(503).send(unavailable(request.id));
      const { listId } = listParamsSchema.parse(request.params);
      const input = csvCommitSchema.parse(request.body);
      const version = await options.rankings.importCsv({
        actorUserId: user.id,
        listId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        mapping: input.mapping,
        decision: input.decision,
        ...(input.sourceFileName === undefined ? {} : { sourceFileName: input.sourceFileName }),
        ...(input.hasHeader === undefined ? {} : { hasHeader: input.hasHeader }),
        ...(input.changeNote === undefined ? {} : { changeNote: input.changeNote }),
      });
      return reply.code(201).send({ version });
    },
  );

  app.post(
    "/v1/rankings/:listId/imports/json",
    { bodyLimit: 6 * 1024 * 1024 },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.rankings) return reply.code(503).send(unavailable(request.id));
      const { listId } = listParamsSchema.parse(request.params);
      const input = jsonCommitSchema.parse(request.body);
      const version = await options.rankings.importJson({
        actorUserId: user.id,
        listId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        ...(input.sourceFileName === undefined ? {} : { sourceFileName: input.sourceFileName }),
        ...(input.changeNote === undefined ? {} : { changeNote: input.changeNote }),
      });
      return reply.code(201).send({ version });
    },
  );

  app.get("/v1/rankings/:listId/export", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const query = exportQuerySchema.parse(request.query);
    const content = await options.rankings.export({
      actorUserId: user.id,
      listId,
      format: query.format,
      ...(query.versionId === undefined ? {} : { versionId: query.versionId }),
    });
    return sendExport(reply, query.format, content);
  });

  app.post("/v1/rankings/:listId/shares", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId } = listParamsSchema.parse(request.params);
    const input = shareCreateSchema.parse(request.body ?? {});
    const created = await options.rankings.createShare({
      actorUserId: user.id,
      listId,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.allowCopy === undefined ? {} : { allowCopy: input.allowCopy }),
      ...(input.expiresAt === undefined
        ? {}
        : { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }),
      ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
    });
    const shareUrl = new URL("/rankings/shared", options.webUrl);
    shareUrl.hash = created.token;
    return reply.code(201).send({
      id: created.id,
      shareUrl: shareUrl.toString(),
      list: created.list,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    });
  });

  app.delete("/v1/rankings/:listId/shares/:shareId", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { listId, shareId } = shareParamsSchema.parse(request.params);
    await options.rankings.getList(user.id, listId);
    await options.rankings.revokeShare(user.id, shareId);
    return reply.code(204).send();
  });

  // Capability tokens are accepted only in request bodies. They never appear in paths or queries.
  app.post("/v1/ranking-shares/open", async (request, reply) => {
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { token } = shareCapabilitySchema.parse(request.body);
    return options.rankings.openShare(token);
  });

  app.post("/v1/ranking-shares/export", async (request, reply) => {
    if (!options.rankings) return reply.code(503).send(unavailable(request.id));
    const { token, format } = shareExportSchema.parse(request.body);
    return sendExport(reply, format, await options.rankings.exportShare(token, format));
  });
}
