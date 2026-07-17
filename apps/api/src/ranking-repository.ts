import { randomUUID } from "node:crypto";

import {
  importRuns,
  leagueMemberships,
  players,
  rankingEntries,
  rankingLists,
  rankingListVersions,
  shareLinks,
  type Database,
  type RankingFieldAttribution,
  type RankingFieldProvenance,
  type RankingVisibilityConfig,
} from "@fantasy/db";
import {
  RANKING_FIELD_NAMES,
  RANKING_SCHEMA_VERSION,
  createRankingVersion,
  parseRankingVersion,
  positionSchema,
  rankingEntrySchema,
  rankingListSchema,
  rankingVisibilitySchema,
  type FieldAttribution,
  type RankingEntry,
  type RankingEntryField,
  type RankingFieldName,
  type RankingList,
  type RankingVersion,
} from "@fantasy/rankings";
import { and, countDistinct, desc, eq, gt, inArray, isNull, max, or, sql } from "drizzle-orm";

import type {
  AppendRankingVersionInput,
  CommitRankingImportInput,
  CreatedRankingShareRecord,
  RankingImportRecord,
  RankingMutationResult,
  RankingPlayerIdentity,
  RankingRepository,
  RankingShareAuthorization,
  StartRankingImportResult,
} from "./ranking-service.js";
import { unscopedPlayerCatalogFilter } from "./espn-sync-persistence.js";

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function databaseErrorCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor && typeof cursor === "object"; depth += 1) {
    if ("code" in cursor && typeof cursor.code === "string") return cursor.code;
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return undefined;
}

function listFromRow(row: typeof rankingLists.$inferSelect): RankingList {
  return rankingListSchema.parse({
    schemaVersion: RANKING_SCHEMA_VERSION,
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    description: row.description,
    season: row.season,
    kind: row.kind,
    scoringContext: row.scoringContext,
    visibility: row.visibilityConfig,
    currentVersionId: row.currentVersionId,
    latestPublishedVersionId: row.latestPublishedVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  });
}

function attributionWithoutValue(field: NonNullable<RankingEntryField>): FieldAttribution {
  if (field.kind === "user") {
    return {
      kind: "user",
      authorUserId: field.authorUserId,
      authoredAt: field.authoredAt,
    };
  }
  return {
    kind: "derived",
    sourceId: field.sourceId,
    computedAt: field.computedAt,
    inputChecksumSha256: field.inputChecksumSha256,
  };
}

function provenanceForEntry(entry: RankingEntry): RankingFieldProvenance {
  const provenance: Partial<Record<RankingFieldName, RankingFieldAttribution>> = {};
  for (const field of RANKING_FIELD_NAMES) {
    const sourced = entry[field];
    if (sourced !== null) provenance[field] = attributionWithoutValue(sourced);
  }
  return provenance;
}

function numeric(value: RankingEntryField): string | null {
  if (value === null || typeof value.value !== "number") return null;
  return String(value.value);
}

function scalarValue(row: typeof rankingEntries.$inferSelect, field: RankingFieldName): unknown {
  switch (field) {
    case "overallRank":
      return row.overallRank;
    case "positionRank":
      return row.positionRank;
    case "tier":
      return row.tier;
    case "adp":
      return row.adp === null ? null : Number(row.adp);
    case "aav":
      return row.aav === null ? null : Number(row.aav);
    case "floorPrice":
      return row.floorPrice === null ? null : Number(row.floorPrice);
    case "targetPrice":
      return row.targetPrice === null ? null : Number(row.targetPrice);
    case "ceilingPrice":
      return row.ceilingPrice === null ? null : Number(row.ceilingPrice);
    case "confidence":
      return row.confidence === null ? null : Number(row.confidence);
    case "tags":
      return row.tags;
    case "notes":
      return row.notes;
    case "target":
      return row.target;
    case "avoid":
      return row.avoid;
  }
}

function entryFromRow(row: typeof rankingEntries.$inferSelect): RankingEntry {
  const input: Record<string, unknown> = {
    playerId: row.playerId,
    position: row.position,
  };
  for (const field of RANKING_FIELD_NAMES) {
    const value = scalarValue(row, field);
    if (value === null) {
      input[field] = null;
      continue;
    }
    const attribution = row.fieldProvenance[field];
    input[field] = attribution ? { value, ...attribution } : { value };
  }
  return rankingEntrySchema.parse(input);
}

function storedOrder(row: typeof rankingEntries.$inferSelect): number {
  const value = row.userFields.__entryOrder;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : Number.MAX_SAFE_INTEGER;
}

function valuesForEntries(version: RankingVersion) {
  return version.entries.map((entry, index) => ({
    versionId: version.id,
    playerId: entry.playerId,
    position: entry.position,
    overallRank: entry.overallRank?.value ?? null,
    positionRank: entry.positionRank?.value ?? null,
    tier: entry.tier?.value ?? null,
    adp: numeric(entry.adp),
    aav: numeric(entry.aav),
    floorPrice: numeric(entry.floorPrice),
    targetPrice: numeric(entry.targetPrice),
    ceilingPrice: numeric(entry.ceilingPrice),
    confidence: numeric(entry.confidence),
    tags: entry.tags?.value ? [...entry.tags.value] : null,
    notes: entry.notes?.value ?? null,
    target: entry.target?.value ?? null,
    avoid: entry.avoid?.value ?? null,
    userFields: { __entryOrder: index },
    fieldProvenance: provenanceForEntry(entry),
  }));
}

const STORED_DECIMAL_SCALE: Readonly<Partial<Record<RankingFieldName, number>>> = {
  adp: 3,
  aav: 2,
  floorPrice: 2,
  targetPrice: 2,
  ceilingPrice: 2,
  confidence: 4,
};

/** Make the checksummed domain value exactly match PostgreSQL numeric precision. */
function normalizeEntriesForStorage(entries: readonly RankingEntry[]): readonly RankingEntry[] {
  return Object.freeze(
    entries.map((entry) => {
      const input: Record<string, unknown> = { ...entry };
      for (const [field, scale] of Object.entries(STORED_DECIMAL_SCALE) as [
        RankingFieldName,
        number,
      ][]) {
        const value = entry[field];
        if (value !== null && typeof value.value === "number") {
          input[field] = { ...value, value: Number(value.value.toFixed(scale)) };
        }
      }
      return rankingEntrySchema.parse(input);
    }),
  );
}

async function missingPlayerIds(
  transaction: DatabaseTransaction,
  entries: readonly RankingEntry[],
): Promise<readonly string[]> {
  if (entries.length === 0) return [];
  const ids = entries.map((entry) => entry.playerId);
  const found = await transaction
    .select({ id: players.id })
    .from(players)
    .where(and(inArray(players.id, ids), unscopedPlayerCatalogFilter()));
  const foundIds = new Set(found.map((player) => player.id));
  return ids.filter((id) => !foundIds.has(id));
}

async function appendInsideTransaction(
  transaction: DatabaseTransaction,
  input: AppendRankingVersionInput,
): Promise<RankingMutationResult> {
  await transaction.execute(
    sql`select id from ranking_lists where id = ${input.listId} for update`,
  );
  const [list] = await transaction
    .select({
      ownerUserId: rankingLists.ownerUserId,
      currentVersionId: rankingLists.currentVersionId,
    })
    .from(rankingLists)
    .where(eq(rankingLists.id, input.listId))
    .limit(1);
  if (!list) return { status: "not_found" };
  if (list.ownerUserId !== input.actorUserId) return { status: "forbidden" };
  if (list.currentVersionId !== input.expectedCurrentVersionId) return { status: "conflict" };

  const storageEntries = normalizeEntriesForStorage(input.entries);
  const missing = await missingPlayerIds(transaction, storageEntries);
  if (missing.length > 0) return { status: "unknown_players", playerIds: missing };

  const [sequence] = await transaction
    .select({ value: max(rankingListVersions.versionNumber) })
    .from(rankingListVersions)
    .where(eq(rankingListVersions.listId, input.listId));
  const versionNumber = (sequence?.value ?? 0) + 1;
  const version = createRankingVersion({
    schemaVersion: RANKING_SCHEMA_VERSION,
    id: randomUUID(),
    listId: input.listId,
    versionNumber,
    parentVersionId: input.expectedCurrentVersionId,
    state: input.state,
    authorUserId: input.actorUserId,
    createdAt: input.createdAt.toISOString(),
    publishedAt: input.state === "published" ? input.createdAt.toISOString() : null,
    changeNote: input.changeNote,
    entries: storageEntries,
    provenance: input.provenance,
  });
  await transaction.insert(rankingListVersions).values({
    id: version.id,
    listId: version.listId,
    versionNumber: version.versionNumber,
    parentVersionId: version.parentVersionId,
    state: version.state,
    authorUserId: version.authorUserId,
    importRunId: input.importRunId ?? null,
    publishedAt: version.publishedAt ? new Date(version.publishedAt) : null,
    entryCount: version.entries.length,
    checksumSha256: version.checksumSha256,
    changeNote: version.changeNote,
    provenance: version.provenance,
    createdAt: new Date(version.createdAt),
  });
  if (version.entries.length > 0) {
    await transaction.insert(rankingEntries).values(valuesForEntries(version));
  }
  await transaction
    .update(rankingLists)
    .set({
      currentVersionId: version.id,
      ...(version.state === "published" ? { latestPublishedVersionId: version.id } : {}),
      updatedAt: input.createdAt,
    })
    .where(eq(rankingLists.id, input.listId));
  return { status: "saved", version };
}

function importRecordFromRow(row: typeof importRuns.$inferSelect): RankingImportRecord | undefined {
  if (row.state !== "processing" && row.state !== "succeeded" && row.state !== "failed") {
    return undefined;
  }
  if (row.sourceFormat !== "csv" && row.sourceFormat !== "json") return undefined;
  if (!row.rankingListId || !row.sourceChecksumSha256) return undefined;
  return {
    id: row.id,
    state: row.state,
    listId: row.rankingListId,
    sourceFormat: row.sourceFormat,
    sourceChecksumSha256: row.sourceChecksumSha256,
  };
}

/** PostgreSQL implementation of the ranking persistence and authorization boundary. */
export class DrizzleRankingRepository implements RankingRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async createList(listInput: RankingList, anchorLeagueId: string | null): Promise<void> {
    const list = rankingListSchema.parse(listInput);
    await this.#database.insert(rankingLists).values({
      id: list.id,
      ownerUserId: list.ownerUserId,
      leagueId: anchorLeagueId,
      name: list.name,
      description: list.description,
      kind: list.kind,
      visibility: list.visibility.scope,
      visibilityConfig: list.visibility as RankingVisibilityConfig,
      season: list.season,
      scoringContext: list.scoringContext,
      scoringFormat: list.scoringContext.format,
      currentVersionId: list.currentVersionId,
      latestPublishedVersionId: list.latestPublishedVersionId,
      archivedAt: list.archivedAt ? new Date(list.archivedAt) : null,
      createdAt: new Date(list.createdAt),
      updatedAt: new Date(list.updatedAt),
    });
  }

  async listAccessibleLists(
    userId: string,
    includeArchived: boolean,
  ): Promise<readonly RankingList[]> {
    const access = sql<boolean>`
      ${rankingLists.ownerUserId} = ${userId}
      or (
        ${rankingLists.visibility} = 'league'
        and exists (
          select 1
          from league_memberships membership,
            jsonb_array_elements_text(
              case
                when jsonb_typeof(${rankingLists.visibilityConfig}->'leagueIds') = 'array'
                  then ${rankingLists.visibilityConfig}->'leagueIds'
                else '[]'::jsonb
              end
            ) scoped_league
          where membership.user_id = ${userId}
            and membership.league_id::text = scoped_league.value
        )
      )
    `;
    const rows = await this.#database
      .select()
      .from(rankingLists)
      .where(includeArchived ? access : and(access, isNull(rankingLists.archivedAt)))
      .orderBy(desc(rankingLists.updatedAt));
    return Object.freeze(rows.map(listFromRow));
  }

  async getList(listId: string): Promise<RankingList | undefined> {
    const [row] = await this.#database
      .select()
      .from(rankingLists)
      .where(eq(rankingLists.id, listId))
      .limit(1);
    return row ? listFromRow(row) : undefined;
  }

  async updateList(
    actorUserId: string,
    listInput: RankingList,
    anchorLeagueId: string | null,
  ): Promise<"saved" | "not_found" | "forbidden"> {
    const list = rankingListSchema.parse(listInput);
    const updated = await this.#database
      .update(rankingLists)
      .set({
        leagueId: anchorLeagueId,
        name: list.name,
        description: list.description,
        visibility: list.visibility.scope,
        visibilityConfig: list.visibility as RankingVisibilityConfig,
        archivedAt: list.archivedAt ? new Date(list.archivedAt) : null,
        updatedAt: new Date(list.updatedAt),
      })
      .where(and(eq(rankingLists.id, list.id), eq(rankingLists.ownerUserId, actorUserId)))
      .returning({ id: rankingLists.id });
    if (updated.length === 1) return "saved";
    const [existing] = await this.#database
      .select({ ownerUserId: rankingLists.ownerUserId })
      .from(rankingLists)
      .where(eq(rankingLists.id, list.id))
      .limit(1);
    return existing ? "forbidden" : "not_found";
  }

  async hasEveryLeagueMembership(userId: string, leagueIds: readonly string[]): Promise<boolean> {
    const uniqueIds = [...new Set(leagueIds)];
    if (uniqueIds.length === 0) return true;
    const [result] = await this.#database
      .select({ count: countDistinct(leagueMemberships.leagueId) })
      .from(leagueMemberships)
      .where(
        and(eq(leagueMemberships.userId, userId), inArray(leagueMemberships.leagueId, uniqueIds)),
      );
    return Number(result?.count ?? 0) === uniqueIds.length;
  }

  async hasAnyLeagueMembership(userId: string, leagueIds: readonly string[]): Promise<boolean> {
    const uniqueIds = [...new Set(leagueIds)];
    if (uniqueIds.length === 0) return false;
    const [result] = await this.#database
      .select({ count: countDistinct(leagueMemberships.leagueId) })
      .from(leagueMemberships)
      .where(
        and(eq(leagueMemberships.userId, userId), inArray(leagueMemberships.leagueId, uniqueIds)),
      );
    return Number(result?.count ?? 0) > 0;
  }

  async getVersion(versionId: string): Promise<RankingVersion | undefined> {
    const [row] = await this.#database
      .select()
      .from(rankingListVersions)
      .where(eq(rankingListVersions.id, versionId))
      .limit(1);
    if (!row || !row.authorUserId || !row.checksumSha256) return undefined;
    const entryRows = await this.#database
      .select()
      .from(rankingEntries)
      .where(eq(rankingEntries.versionId, row.id));
    entryRows.sort((left, right) => {
      const order = storedOrder(left) - storedOrder(right);
      if (order !== 0) return order;
      return (
        (left.overallRank ?? Number.MAX_SAFE_INTEGER) -
        (right.overallRank ?? Number.MAX_SAFE_INTEGER)
      );
    });
    if (entryRows.length !== row.entryCount) return undefined;
    return parseRankingVersion({
      schemaVersion: RANKING_SCHEMA_VERSION,
      id: row.id,
      listId: row.listId,
      versionNumber: row.versionNumber,
      parentVersionId: row.parentVersionId,
      state: row.state,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      changeNote: row.changeNote,
      entries: entryRows.map(entryFromRow),
      provenance: row.provenance,
      checksumSha256: row.checksumSha256,
    });
  }

  async appendVersion(input: AppendRankingVersionInput): Promise<RankingMutationResult> {
    try {
      return await this.#database.transaction((transaction) =>
        appendInsideTransaction(transaction, input),
      );
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === "23505") return { status: "conflict" };
      if (code === "23503") {
        return {
          status: "unknown_players",
          playerIds: input.entries.map((entry) => entry.playerId),
        };
      }
      throw error;
    }
  }

  async listPlayerIdentities(): Promise<readonly RankingPlayerIdentity[]> {
    const rows = await this.#database
      .select({ id: players.id, fullName: players.fullName, position: players.primaryPosition })
      .from(players)
      .where(unscopedPlayerCatalogFilter());
    return rows.flatMap((row) => {
      const position = positionSchema.safeParse(row.position);
      return position.success ? [{ ...row, position: position.data }] : [];
    });
  }

  async getPlayerIdentities(
    playerIds: readonly string[],
  ): Promise<readonly RankingPlayerIdentity[]> {
    if (playerIds.length === 0) return [];
    const rows = await this.#database
      .select({ id: players.id, fullName: players.fullName, position: players.primaryPosition })
      .from(players)
      .where(and(inArray(players.id, [...new Set(playerIds)]), unscopedPlayerCatalogFilter()));
    return rows.flatMap((row) => {
      const position = positionSchema.safeParse(row.position);
      return position.success ? [{ ...row, position: position.data }] : [];
    });
  }

  async startImport(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly idempotencyKey: string;
    readonly sourceFormat: "csv" | "json";
    readonly sourceFileName: string | null;
    readonly sourceChecksumSha256: string;
    readonly now: Date;
  }): Promise<StartRankingImportResult> {
    const [inserted] = await this.#database
      .insert(importRuns)
      .values({
        userId: input.actorUserId,
        rankingListId: input.listId,
        idempotencyKey: input.idempotencyKey,
        state: "processing",
        sourceFormat: input.sourceFormat,
        sourceFileName: input.sourceFileName,
        sourceChecksumSha256: input.sourceChecksumSha256,
        startedAt: input.now,
      })
      .onConflictDoNothing({ target: [importRuns.userId, importRuns.idempotencyKey] })
      .returning();
    if (inserted) {
      const record = importRecordFromRow(inserted);
      if (!record) return { status: "conflict" };
      return { status: "ready", record };
    }
    const [existing] = await this.#database
      .select()
      .from(importRuns)
      .where(
        and(
          eq(importRuns.userId, input.actorUserId),
          eq(importRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (
      !existing ||
      existing.rankingListId !== input.listId ||
      existing.sourceFormat !== input.sourceFormat ||
      existing.sourceChecksumSha256 !== input.sourceChecksumSha256
    ) {
      return { status: "conflict" };
    }
    if (existing.state === "failed") {
      const [retried] = await this.#database
        .update(importRuns)
        .set({
          state: "processing",
          startedAt: input.now,
          finishedAt: null,
          errorCode: null,
          errorDetail: null,
          commitDecision: "pending",
          committedAt: null,
        })
        .where(and(eq(importRuns.id, existing.id), eq(importRuns.state, "failed")))
        .returning();
      if (retried) {
        const record = importRecordFromRow(retried);
        if (record) return { status: "ready", record };
      }
    }
    const record = importRecordFromRow(existing);
    return record ? { status: "ready", record } : { status: "conflict" };
  }

  async getVersionByImportRunId(importRunId: string): Promise<RankingVersion | undefined> {
    const [row] = await this.#database
      .select({ id: rankingListVersions.id })
      .from(rankingListVersions)
      .where(eq(rankingListVersions.importRunId, importRunId))
      .limit(1);
    return row ? this.getVersion(row.id) : undefined;
  }

  async commitImport(input: CommitRankingImportInput): Promise<RankingMutationResult> {
    const alreadyCommitted = await this.getVersionByImportRunId(input.importRunId);
    if (alreadyCommitted) return { status: "saved", version: alreadyCommitted };
    try {
      const result = await this.#database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select id from import_runs where id = ${input.importRunId} for update`,
        );
        const [run] = await transaction
          .select()
          .from(importRuns)
          .where(eq(importRuns.id, input.importRunId))
          .limit(1);
        if (
          !run ||
          run.userId !== input.actorUserId ||
          run.rankingListId !== input.listId ||
          run.sourceFormat !== input.sourceFormat ||
          run.sourceChecksumSha256 !== input.sourceChecksumSha256
        ) {
          return { status: "conflict" } as const;
        }
        // The fast-path read above can race an identical request. Re-check the run after taking
        // its row lock so a waiter observes the winning transaction instead of reporting a false
        // idempotency conflict.
        if (run.state === "succeeded") return { status: "committed" } as const;
        if (run.state !== "processing") return { status: "conflict" } as const;
        const result = await appendInsideTransaction(transaction, input);
        if (result.status !== "saved") return result;
        await transaction
          .update(importRuns)
          .set({
            state: "succeeded",
            previewChecksumSha256: input.previewChecksumSha256,
            columnMapping: input.columnMapping,
            rowsRead: input.rowsRead,
            rowsAccepted: input.rowsAccepted,
            rowsRejected: input.rowsRejected,
            validationSummary: input.validationSummary,
            diagnostics: input.diagnostics,
            commitDecision: "accepted",
            acceptedRowNumbers: [...input.acceptedRowNumbers],
            committedAt: input.createdAt,
            finishedAt: input.createdAt,
          })
          .where(eq(importRuns.id, input.importRunId));
        return result;
      });
      if (result.status !== "committed") return result;
      const committed = await this.getVersionByImportRunId(input.importRunId);
      return committed ? { status: "saved", version: committed } : { status: "conflict" };
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === "23505") return { status: "conflict" };
      if (code === "23503") {
        return {
          status: "unknown_players",
          playerIds: input.entries.map((entry) => entry.playerId),
        };
      }
      throw error;
    }
  }

  async failImport(importRunId: string, errorCode: string, now: Date): Promise<void> {
    await this.#database
      .update(importRuns)
      .set({ state: "failed", errorCode, finishedAt: now })
      .where(and(eq(importRuns.id, importRunId), eq(importRuns.state, "processing")));
  }

  async createShare(input: {
    readonly id: string;
    readonly actorUserId: string;
    readonly listId: string;
    readonly tokenHash: string;
    readonly label: string | null;
    readonly allowCopy: boolean;
    readonly expiresAt: Date | null;
    readonly maxUses: number | null;
    readonly now: Date;
  }): Promise<CreatedRankingShareRecord | undefined> {
    return this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ranking_lists where id = ${input.listId} for update`,
      );
      const [listRow] = await transaction
        .select()
        .from(rankingLists)
        .where(eq(rankingLists.id, input.listId))
        .limit(1);
      if (
        !listRow ||
        listRow.ownerUserId !== input.actorUserId ||
        listRow.currentVersionId === null
      ) {
        return undefined;
      }
      await transaction
        .update(shareLinks)
        .set({ revokedAt: input.now })
        .where(and(eq(shareLinks.rankingListId, input.listId), isNull(shareLinks.revokedAt)));
      await transaction.insert(shareLinks).values({
        id: input.id,
        tokenHash: input.tokenHash,
        createdByUserId: input.actorUserId,
        rankingListId: input.listId,
        label: input.label,
        permission: input.allowCopy ? "copy" : "view",
        allowCopy: input.allowCopy,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        createdAt: input.now,
      });
      const visibility: RankingVisibilityConfig = {
        scope: "shared-link",
        shareLinkId: input.id,
        allowClone: input.allowCopy,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        revokedAt: null,
      };
      const [updated] = await transaction
        .update(rankingLists)
        .set({
          leagueId: null,
          visibility: "shared-link",
          visibilityConfig: visibility,
          updatedAt: input.now,
        })
        .where(eq(rankingLists.id, input.listId))
        .returning();
      return updated ? { id: input.id, list: listFromRow(updated) } : undefined;
    });
  }

  async consumeShare(tokenHash: string, now: Date): Promise<RankingShareAuthorization | undefined> {
    return this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from share_links where token_hash = ${tokenHash} for update`,
      );
      const [share] = await transaction
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.tokenHash, tokenHash))
        .limit(1);
      if (
        !share?.rankingListId ||
        share.revokedAt ||
        (share.expiresAt && share.expiresAt <= now) ||
        (share.maxUses !== null && share.useCount >= share.maxUses)
      ) {
        return undefined;
      }
      const [list] = await transaction
        .select({ visibilityConfig: rankingLists.visibilityConfig })
        .from(rankingLists)
        .where(eq(rankingLists.id, share.rankingListId))
        .limit(1);
      const visibility = rankingVisibilitySchema.safeParse(list?.visibilityConfig);
      if (
        !visibility.success ||
        visibility.data.scope !== "shared-link" ||
        visibility.data.shareLinkId !== share.id ||
        visibility.data.revokedAt !== null
      ) {
        return undefined;
      }
      const [consumed] = await transaction
        .update(shareLinks)
        .set({ useCount: sql`${shareLinks.useCount} + 1`, lastUsedAt: now })
        .where(
          and(
            eq(shareLinks.id, share.id),
            isNull(shareLinks.revokedAt),
            or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
            share.maxUses === null ? sql`true` : sql`${shareLinks.useCount} < ${share.maxUses}`,
          ),
        )
        .returning({ id: shareLinks.id });
      return consumed
        ? {
            listId: share.rankingListId,
            allowCopy: share.allowCopy && share.permission === "copy",
          }
        : undefined;
    });
  }

  async revokeShare(
    actorUserId: string,
    shareId: string,
    now: Date,
  ): Promise<"revoked" | "not_found" | "forbidden"> {
    return this.#database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from share_links where id = ${shareId} for update`);
      const [share] = await transaction
        .select({
          id: shareLinks.id,
          rankingListId: shareLinks.rankingListId,
          revokedAt: shareLinks.revokedAt,
          ownerUserId: rankingLists.ownerUserId,
          visibilityConfig: rankingLists.visibilityConfig,
        })
        .from(shareLinks)
        .leftJoin(rankingLists, eq(rankingLists.id, shareLinks.rankingListId))
        .where(eq(shareLinks.id, shareId))
        .limit(1);
      if (!share || share.revokedAt) return "not_found";
      if (share.ownerUserId !== actorUserId) return "forbidden";
      await transaction
        .update(shareLinks)
        .set({ revokedAt: now })
        .where(and(eq(shareLinks.id, shareId), isNull(shareLinks.revokedAt)));
      const visibility = rankingVisibilitySchema.safeParse(share.visibilityConfig);
      if (
        share.rankingListId &&
        visibility.success &&
        visibility.data.scope === "shared-link" &&
        visibility.data.shareLinkId === shareId
      ) {
        await transaction
          .update(rankingLists)
          .set({
            visibilityConfig: { ...visibility.data, revokedAt: now.toISOString() },
            updatedAt: now,
          })
          .where(eq(rankingLists.id, share.rankingListId));
      }
      return "revoked";
    });
  }
}
