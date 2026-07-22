import { createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  RANKING_FIELD_NAMES,
  RANKING_SCHEMA_VERSION,
  applyLeagueOverlay,
  checksumUtf8Sha256,
  cloneRanking,
  commitRankingCsvPreview,
  createRankingList,
  createUserAttribution,
  exportRankingEntriesCsv,
  exportRankingJson,
  parseRankingJson,
  parseLeagueOverlay,
  positionSchema,
  previewRankingCsv,
  rankingEntrySchema,
  rankingListSchema,
  rankingVisibilitySchema,
  sourcedValue,
  type CsvColumnMapping,
  type LeagueOverlay,
  type RankingCsvCommitDecision,
  type RankingCsvPreview,
  type RankingEntry,
  type RankingFieldName,
  type RankingList,
  type RankingProvenance,
  type RankingVersion,
  type RankingVisibility,
  type ScoringContext,
} from "@fantasy/rankings";
import { z } from "zod";

const uuidSchema = z.string().uuid();
const dateSchema = z.date();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const changeNoteSchema = z.string().max(2_000).nullable();
const sourceFileNameSchema = z.string().trim().min(1).max(240).nullable();

const scoringContextInputSchema = z
  .object({
    format: z.enum(["STANDARD", "HALF_PPR", "PPR", "CUSTOM"]),
    leagueId: uuidSchema.nullable(),
    settingsChecksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    label: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

const createListInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4_000).nullable().optional(),
    season: z.number().int().min(2000).max(2100),
    kind: z.enum(["rankings", "adp", "auction-values", "cheat-sheet"]),
    scoringContext: scoringContextInputSchema,
    visibility: rankingVisibilitySchema.optional(),
  })
  .strict();

const editListInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(4_000).nullable().optional(),
    visibility: rankingVisibilitySchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, "At least one metadata field is required");

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
  .object({
    playerId: uuidSchema,
    position: positionSchema.nullable(),
    ...manualValuesShape,
  })
  .strict();

const userOverlayPatchSchema = z
  .object({
    playerId: uuidSchema,
    position: positionSchema.nullable().optional(),
    ...manualValuesShape,
  })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== "playerId"), {
    message: "An overlay patch must change at least one field",
  });

export type CreateRankingListInput = z.input<typeof createListInputSchema>;
export type EditRankingListInput = z.input<typeof editListInputSchema>;
export type ManualRankingEntryInput = z.input<typeof manualEntrySchema>;
export type UserRankingOverlayPatch = z.input<typeof userOverlayPatchSchema>;

export type RankingServiceErrorCode =
  | "RANKING_INVALID_INPUT"
  | "RANKING_NOT_FOUND"
  | "RANKING_FORBIDDEN"
  | "RANKING_VERSION_CONFLICT"
  | "RANKING_UNKNOWN_PLAYER"
  | "RANKING_IMPORT_INVALID"
  | "RANKING_IMPORT_CONFLICT"
  | "RANKING_SHARE_UNAVAILABLE";

const errorDetails: Record<
  RankingServiceErrorCode,
  { readonly statusCode: number; readonly message: string }
> = {
  RANKING_INVALID_INPUT: { statusCode: 400, message: "The ranking request is invalid." },
  RANKING_NOT_FOUND: { statusCode: 404, message: "The ranking list was not found." },
  RANKING_FORBIDDEN: {
    statusCode: 403,
    message: "You are not allowed to access this ranking list.",
  },
  RANKING_VERSION_CONFLICT: {
    statusCode: 409,
    message: "The ranking list changed. Reload it before saving again.",
  },
  RANKING_UNKNOWN_PLAYER: {
    statusCode: 422,
    message: "One or more ranking entries reference an unknown player.",
  },
  RANKING_IMPORT_INVALID: {
    statusCode: 422,
    message: "The ranking import could not be validated.",
  },
  RANKING_IMPORT_CONFLICT: {
    statusCode: 409,
    message: "That import key was already used for different content.",
  },
  RANKING_SHARE_UNAVAILABLE: {
    statusCode: 404,
    message: "This ranking share is unavailable.",
  },
};

export class RankingServiceError extends Error {
  readonly code: RankingServiceErrorCode;
  readonly statusCode: number;

  constructor(code: RankingServiceErrorCode) {
    const detail = errorDetails[code];
    super(detail.message);
    this.name = "RankingServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
  }
}

export type RankingMutationResult =
  | { readonly status: "saved"; readonly version: RankingVersion }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" }
  | { readonly status: "conflict" }
  | { readonly status: "unknown_players"; readonly playerIds: readonly string[] };

export interface AppendRankingVersionInput {
  readonly actorUserId: string;
  readonly listId: string;
  readonly expectedCurrentVersionId: string | null;
  readonly state: "draft" | "published";
  readonly entries: readonly RankingEntry[];
  readonly provenance: RankingProvenance;
  readonly changeNote: string | null;
  readonly createdAt: Date;
  readonly importRunId?: string;
}

export interface RankingImportRecord {
  readonly id: string;
  readonly state: "processing" | "succeeded" | "failed";
  readonly listId: string;
  readonly sourceFormat: "csv" | "json";
  readonly sourceChecksumSha256: string;
}

export type StartRankingImportResult =
  | { readonly status: "ready"; readonly record: RankingImportRecord }
  | { readonly status: "conflict" };

export interface CommitRankingImportInput extends AppendRankingVersionInput {
  readonly importRunId: string;
  readonly sourceFormat: "csv" | "json";
  readonly sourceChecksumSha256: string;
  readonly previewChecksumSha256: string | null;
  readonly columnMapping: Readonly<Record<string, string>>;
  readonly rowsRead: number;
  readonly rowsAccepted: number;
  readonly rowsRejected: number;
  readonly acceptedRowNumbers: readonly number[];
  readonly validationSummary: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Readonly<Record<string, unknown>>[];
}

export interface RankingPlayerIdentity {
  readonly id: string;
  readonly fullName: string;
  readonly position: z.infer<typeof positionSchema>;
}

export interface RankingShareAuthorization {
  readonly listId: string;
  readonly allowCopy: boolean;
}

export interface CreatedRankingShareRecord {
  readonly id: string;
  readonly list: RankingList;
}

export interface RankingBoardComparisonSide {
  readonly list: RankingList;
  readonly version: RankingVersion;
}

export interface RankingBoardComparison {
  readonly left: RankingBoardComparisonSide;
  readonly right: RankingBoardComparisonSide;
  readonly players: readonly RankingPlayerIdentity[];
}

export type CreateRankingCloneResult =
  | { readonly status: "saved" }
  | { readonly status: "conflict" }
  | { readonly status: "unknown_players" };

/** Persistence boundary; every version-writing method must commit atomically. */
export interface RankingRepository {
  createList(list: RankingList, anchorLeagueId: string | null): Promise<void>;
  /** Atomically persists a new list and its independent first version. */
  createClone(list: RankingList, version: RankingVersion): Promise<CreateRankingCloneResult>;
  listAccessibleLists(userId: string, includeArchived: boolean): Promise<readonly RankingList[]>;
  getList(listId: string): Promise<RankingList | undefined>;
  updateList(
    actorUserId: string,
    list: RankingList,
    anchorLeagueId: string | null,
  ): Promise<"saved" | "not_found" | "forbidden">;
  hasEveryLeagueMembership(userId: string, leagueIds: readonly string[]): Promise<boolean>;
  hasAnyLeagueMembership(userId: string, leagueIds: readonly string[]): Promise<boolean>;
  getVersion(versionId: string): Promise<RankingVersion | undefined>;
  appendVersion(input: AppendRankingVersionInput): Promise<RankingMutationResult>;
  listPlayerIdentities(): Promise<readonly RankingPlayerIdentity[]>;
  getPlayerIdentities(playerIds: readonly string[]): Promise<readonly RankingPlayerIdentity[]>;
  startImport(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly idempotencyKey: string;
    readonly sourceFormat: "csv" | "json";
    readonly sourceFileName: string | null;
    readonly sourceChecksumSha256: string;
    readonly now: Date;
  }): Promise<StartRankingImportResult>;
  getVersionByImportRunId(importRunId: string): Promise<RankingVersion | undefined>;
  commitImport(input: CommitRankingImportInput): Promise<RankingMutationResult>;
  failImport(importRunId: string, errorCode: string, now: Date): Promise<void>;
  createShare(input: {
    readonly id: string;
    readonly actorUserId: string;
    readonly listId: string;
    readonly tokenHash: string;
    readonly label: string | null;
    readonly allowCopy: boolean;
    readonly expiresAt: Date | null;
    readonly maxUses: number | null;
    readonly now: Date;
  }): Promise<CreatedRankingShareRecord | undefined>;
  consumeShare(tokenHash: string, now: Date): Promise<RankingShareAuthorization | undefined>;
  revokeShare(
    actorUserId: string,
    shareId: string,
    now: Date,
  ): Promise<"revoked" | "not_found" | "forbidden">;
}

export interface RankingShareKeyring {
  readonly tokenHmacKey: Uint8Array;
}

export function deriveRankingShareKeyring(rootSecret: Uint8Array): RankingShareKeyring {
  if (rootSecret.byteLength < 32) throw new TypeError("Ranking share root secret is too short");
  return {
    tokenHmacKey: createHmac("sha256", rootSecret)
      .update("laces-out/ranking-share-token/v1")
      .digest(),
  };
}

export function hashRankingShareToken(token: string, keyring: RankingShareKeyring): string {
  if (keyring.tokenHmacKey.byteLength < 32) {
    throw new TypeError("Ranking share HMAC key is too short");
  }
  if (!/^frs_[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new RankingServiceError("RANKING_SHARE_UNAVAILABLE");
  }
  return createHmac("sha256", keyring.tokenHmacKey).update(token, "utf8").digest("hex");
}

function shareToken(): string {
  return `frs_${randomBytes(32).toString("base64url")}`;
}

function visibilityLeagueIds(visibility: RankingVisibility): readonly string[] {
  return visibility.scope === "league" ? visibility.leagueIds : [];
}

function anchorLeagueId(list: RankingList): string | null {
  return visibilityLeagueIds(list.visibility)[0] ?? list.scoringContext.leagueId ?? null;
}

function allScopedLeagueIds(
  scoringContext: ScoringContext,
  visibility: RankingVisibility,
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...(scoringContext.leagueId ? [scoringContext.leagueId] : []),
      ...visibilityLeagueIds(visibility),
    ]),
  ]);
}

function throwMutationFailure(result: Exclude<RankingMutationResult, { status: "saved" }>): never {
  switch (result.status) {
    case "not_found":
      throw new RankingServiceError("RANKING_NOT_FOUND");
    case "forbidden":
      throw new RankingServiceError("RANKING_FORBIDDEN");
    case "conflict":
      throw new RankingServiceError("RANKING_VERSION_CONFLICT");
    case "unknown_players":
      throw new RankingServiceError("RANKING_UNKNOWN_PLAYER");
  }
}

function rankingFieldValue(
  entry: z.infer<typeof manualEntrySchema> | z.infer<typeof userOverlayPatchSchema>,
  field: RankingFieldName,
): unknown {
  return entry[field];
}

function manualEntries(
  input: readonly ManualRankingEntryInput[],
  authorUserId: string,
  authoredAt: string,
): readonly RankingEntry[] {
  const parsed = z.array(manualEntrySchema).max(10_000).parse(input);
  if (new Set(parsed.map((entry) => entry.playerId)).size !== parsed.length) {
    throw new RankingServiceError("RANKING_INVALID_INPUT");
  }
  const attribution = createUserAttribution(authorUserId, authoredAt);
  return Object.freeze(
    parsed.map((entry) => {
      const candidate: Record<string, unknown> = {
        playerId: entry.playerId,
        position: entry.position,
      };
      for (const field of RANKING_FIELD_NAMES) {
        const value = rankingFieldValue(entry, field);
        candidate[field] =
          value === undefined || value === null ? null : sourcedValue(value, attribution);
      }
      return rankingEntrySchema.parse(candidate);
    }),
  );
}

function applyUserPatches(
  baseEntries: readonly RankingEntry[],
  patchesInput: readonly UserRankingOverlayPatch[],
  actorUserId: string,
  authoredAt: string,
): readonly RankingEntry[] {
  const patches = z.array(userOverlayPatchSchema).min(1).max(10_000).parse(patchesInput);
  if (new Set(patches.map((patch) => patch.playerId)).size !== patches.length) {
    throw new RankingServiceError("RANKING_INVALID_INPUT");
  }
  const patchesByPlayer = new Map(patches.map((patch) => [patch.playerId, patch]));
  const known = new Set(baseEntries.map((entry) => entry.playerId));
  if (patches.some((patch) => !known.has(patch.playerId))) {
    throw new RankingServiceError("RANKING_UNKNOWN_PLAYER");
  }
  const attribution = createUserAttribution(actorUserId, authoredAt);
  return Object.freeze(
    baseEntries.map((entry) => {
      const patch = patchesByPlayer.get(entry.playerId);
      if (!patch) return entry;
      const candidate: Record<string, unknown> = { ...entry };
      if (patch.position !== undefined) candidate.position = patch.position;
      for (const field of RANKING_FIELD_NAMES) {
        const value = rankingFieldValue(patch, field);
        if (value !== undefined)
          candidate[field] = value === null ? null : sourcedValue(value, attribution);
      }
      return rankingEntrySchema.parse(candidate);
    }),
  );
}

function csvMappingRecord(mapping: CsvColumnMapping): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, String(value)])),
  );
}

function diagnosticRecords(
  preview: RankingCsvPreview,
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze([
    ...preview.diagnostics.map((issue) => ({ ...issue })),
    ...preview.rows.flatMap((row) => row.diagnostics.map((issue) => ({ ...issue }))),
  ]);
}

function changeNote(input: string | null | undefined): string | null {
  return changeNoteSchema.parse(input ?? null);
}

function sourceFileName(input: string | null | undefined): string | null {
  return sourceFileNameSchema.parse(input?.trim() || null);
}

function expectedVersionId(input: string | null): string | null {
  return uuidSchema.nullable().parse(input);
}

export interface RankingServiceOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
}

export class RankingService {
  readonly #repository: RankingRepository;
  readonly #shareKeyring: RankingShareKeyring;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(
    repository: RankingRepository,
    shareKeyring: RankingShareKeyring,
    options: RankingServiceOptions = {},
  ) {
    if (shareKeyring.tokenHmacKey.byteLength < 32) {
      throw new TypeError("Ranking share HMAC key is too short");
    }
    this.#repository = repository;
    this.#shareKeyring = { tokenHmacKey: Uint8Array.from(shareKeyring.tokenHmacKey) };
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  async listLists(
    actorUserIdInput: string,
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly RankingList[]> {
    const actorUserId = uuidSchema.parse(actorUserIdInput);
    return this.#repository.listAccessibleLists(actorUserId, options.includeArchived === true);
  }

  async getPlayerIdentities(
    actorUserIdInput: string,
    playerIdsInput: readonly string[],
  ): Promise<readonly RankingPlayerIdentity[]> {
    uuidSchema.parse(actorUserIdInput);
    const playerIds = z.array(uuidSchema).max(10_000).parse(playerIdsInput);
    return this.#repository.getPlayerIdentities([...new Set(playerIds)]);
  }

  async createList(actorUserIdInput: string, input: CreateRankingListInput): Promise<RankingList> {
    const actorUserId = uuidSchema.parse(actorUserIdInput);
    const parsed = createListInputSchema.parse(input);
    const visibility = parsed.visibility ?? ({ scope: "private" } as const);
    if (visibility.scope === "shared-link") {
      throw new RankingServiceError("RANKING_INVALID_INPUT");
    }
    await this.#assertLeagueMemberships(
      actorUserId,
      allScopedLeagueIds(parsed.scoringContext, visibility),
    );
    const createdAt = this.#now().toISOString();
    const list = createRankingList({
      id: this.#id(),
      ownerUserId: actorUserId,
      name: parsed.name,
      description: parsed.description ?? null,
      season: parsed.season,
      kind: parsed.kind,
      scoringContext: parsed.scoringContext,
      visibility,
      createdAt,
    });
    await this.#repository.createList(list, anchorLeagueId(list));
    return list;
  }

  async editList(
    actorUserIdInput: string,
    listIdInput: string,
    input: EditRankingListInput,
  ): Promise<RankingList> {
    const actorUserId = uuidSchema.parse(actorUserIdInput);
    const listId = uuidSchema.parse(listIdInput);
    const parsed = editListInputSchema.parse(input);
    const current = await this.#ownedList(actorUserId, listId);
    const visibility = parsed.visibility ?? current.visibility;
    if (parsed.visibility?.scope === "shared-link") {
      throw new RankingServiceError("RANKING_INVALID_INPUT");
    }
    await this.#assertLeagueMemberships(
      actorUserId,
      allScopedLeagueIds(current.scoringContext, visibility),
    );
    const updated = rankingListSchema.parse({
      ...current,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.visibility === undefined ? {} : { visibility }),
      ...(parsed.archived === undefined
        ? {}
        : { archivedAt: parsed.archived ? this.#now().toISOString() : null }),
      updatedAt: this.#now().toISOString(),
    });
    const result = await this.#repository.updateList(actorUserId, updated, anchorLeagueId(updated));
    if (result === "not_found") throw new RankingServiceError("RANKING_NOT_FOUND");
    if (result === "forbidden") throw new RankingServiceError("RANKING_FORBIDDEN");
    return (await this.#repository.getList(updated.id)) ?? updated;
  }

  async getList(actorUserIdInput: string, listIdInput: string): Promise<RankingList> {
    const actorUserId = uuidSchema.parse(actorUserIdInput);
    const list = await this.#existingList(uuidSchema.parse(listIdInput));
    if (list.ownerUserId === actorUserId) return list;
    if (list.visibility.scope !== "league") {
      throw new RankingServiceError("RANKING_FORBIDDEN");
    }
    if (!(await this.#repository.hasAnyLeagueMembership(actorUserId, list.visibility.leagueIds))) {
      throw new RankingServiceError("RANKING_FORBIDDEN");
    }
    return list;
  }

  async getVersion(
    actorUserId: string,
    listId: string,
    versionId?: string,
  ): Promise<RankingVersion> {
    const list = await this.getList(actorUserId, listId);
    const selectedVersionId = versionId ? uuidSchema.parse(versionId) : list.currentVersionId;
    if (!selectedVersionId) throw new RankingServiceError("RANKING_NOT_FOUND");
    const version = await this.#repository.getVersion(selectedVersionId);
    if (!version || version.listId !== list.id) throw new RankingServiceError("RANKING_NOT_FOUND");
    return version;
  }

  async cloneList(input: {
    readonly actorUserId: string;
    readonly sourceListId: string;
    readonly sourceVersionId?: string;
    readonly name: string;
    readonly changeNote?: string | null;
  }): Promise<{ readonly list: RankingList; readonly version: RankingVersion }> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const sourceList = await this.getList(actorUserId, uuidSchema.parse(input.sourceListId));
    if (
      sourceList.ownerUserId !== actorUserId &&
      (sourceList.visibility.scope !== "league" || !sourceList.visibility.allowClone)
    ) {
      throw new RankingServiceError("RANKING_FORBIDDEN");
    }
    const sourceVersion = await this.getVersion(actorUserId, sourceList.id, input.sourceVersionId);
    const now = this.#now();
    const cloned = cloneRanking(sourceList, sourceVersion, {
      listId: this.#id(),
      versionId: this.#id(),
      ownerUserId: actorUserId,
      authorUserId: actorUserId,
      name: z.string().trim().min(1).max(160).parse(input.name),
      visibility: { scope: "private" },
      createdAt: now.toISOString(),
      changeNote: changeNote(input.changeNote),
    });
    const result = await this.#repository.createClone(cloned.list, cloned.version);
    if (result.status === "conflict") {
      throw new RankingServiceError("RANKING_VERSION_CONFLICT");
    }
    if (result.status === "unknown_players") {
      throw new RankingServiceError("RANKING_UNKNOWN_PLAYER");
    }
    return cloned;
  }

  async compareLists(input: {
    readonly actorUserId: string;
    readonly leftListId: string;
    readonly leftVersionId?: string;
    readonly rightListId: string;
    readonly rightVersionId?: string;
  }): Promise<RankingBoardComparison> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const leftListId = uuidSchema.parse(input.leftListId);
    const rightListId = uuidSchema.parse(input.rightListId);
    const [leftList, rightList] = await Promise.all([
      this.getList(actorUserId, leftListId),
      this.getList(actorUserId, rightListId),
    ]);
    const [leftVersion, rightVersion] = await Promise.all([
      this.getVersion(actorUserId, leftList.id, input.leftVersionId),
      this.getVersion(actorUserId, rightList.id, input.rightVersionId),
    ]);
    const players = await this.#repository.getPlayerIdentities([
      ...new Set([
        ...leftVersion.entries.map((entry) => entry.playerId),
        ...rightVersion.entries.map((entry) => entry.playerId),
      ]),
    ]);
    return {
      left: { list: leftList, version: leftVersion },
      right: { list: rightList, version: rightVersion },
      players,
    };
  }

  async replaceWithManualDraft(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly expectedCurrentVersionId: string | null;
    readonly entries: readonly ManualRankingEntryInput[];
    readonly changeNote?: string | null;
  }): Promise<RankingVersion> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const list = await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    const now = this.#now();
    const entries = manualEntries(input.entries, actorUserId, now.toISOString());
    const expectedCurrentVersionId = expectedVersionId(input.expectedCurrentVersionId);
    const note = changeNote(input.changeNote);
    const result = await this.#repository.appendVersion({
      actorUserId,
      listId: list.id,
      expectedCurrentVersionId,
      state: "draft",
      entries,
      provenance: {
        operation: "edit",
        sources: [
          {
            kind: "manual",
            sourceId: actorUserId,
            versionId: expectedCurrentVersionId,
            checksumSha256: null,
            observedAt: now.toISOString(),
            label: "User-authored ranking",
          },
        ],
        note,
      },
      changeNote: note,
      createdAt: now,
    });
    return result.status === "saved" ? result.version : throwMutationFailure(result);
  }

  async applyUserOverlay(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly baseVersionId: string;
    readonly patches: readonly UserRankingOverlayPatch[];
    readonly changeNote?: string | null;
  }): Promise<RankingVersion> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const list = await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    const baseVersionId = uuidSchema.parse(input.baseVersionId);
    if (list.currentVersionId !== baseVersionId) {
      throw new RankingServiceError("RANKING_VERSION_CONFLICT");
    }
    const base = await this.#repository.getVersion(baseVersionId);
    if (!base || base.listId !== list.id) throw new RankingServiceError("RANKING_NOT_FOUND");
    const now = this.#now();
    const entries = applyUserPatches(base.entries, input.patches, actorUserId, now.toISOString());
    const note = changeNote(input.changeNote);
    const result = await this.#repository.appendVersion({
      actorUserId,
      listId: list.id,
      expectedCurrentVersionId: baseVersionId,
      state: "draft",
      entries,
      provenance: {
        operation: "overlay",
        sources: [
          {
            kind: "manual",
            sourceId: actorUserId,
            versionId: baseVersionId,
            checksumSha256: base.checksumSha256,
            observedAt: now.toISOString(),
            label: "User overlay",
          },
        ],
        note,
      },
      changeNote: note,
      createdAt: now,
    });
    return result.status === "saved" ? result.version : throwMutationFailure(result);
  }

  async applyLeagueOverlay(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly overlay: LeagueOverlay;
    readonly changeNote?: string | null;
  }): Promise<RankingVersion> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const list = await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    const overlay = parseLeagueOverlay(input.overlay);
    await this.#assertLeagueMemberships(actorUserId, [uuidSchema.parse(overlay.leagueId)]);
    if (list.currentVersionId !== overlay.baseVersionId) {
      throw new RankingServiceError("RANKING_VERSION_CONFLICT");
    }
    const base = await this.#repository.getVersion(overlay.baseVersionId);
    if (!base || base.listId !== list.id) throw new RankingServiceError("RANKING_NOT_FOUND");
    const applied = applyLeagueOverlay(base.entries, overlay, base.id);
    const now = this.#now();
    const note = changeNote(input.changeNote);
    const result = await this.#repository.appendVersion({
      actorUserId,
      listId: list.id,
      expectedCurrentVersionId: base.id,
      state: "draft",
      entries: applied.entries,
      provenance: {
        operation: "overlay",
        sources: [
          {
            kind: "league-overlay",
            sourceId: overlay.id,
            versionId: base.id,
            checksumSha256: overlay.checksumSha256,
            observedAt: now.toISOString(),
            label: `League ${overlay.leagueId} overlay`,
          },
        ],
        note,
      },
      changeNote: note,
      createdAt: now,
    });
    return result.status === "saved" ? result.version : throwMutationFailure(result);
  }

  async publish(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly expectedCurrentVersionId: string;
    readonly changeNote?: string | null;
  }): Promise<RankingVersion> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const list = await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    const baseId = uuidSchema.parse(input.expectedCurrentVersionId);
    if (list.currentVersionId !== baseId) {
      throw new RankingServiceError("RANKING_VERSION_CONFLICT");
    }
    const base = await this.#repository.getVersion(baseId);
    if (!base || base.listId !== list.id) throw new RankingServiceError("RANKING_NOT_FOUND");
    const now = this.#now();
    const note = changeNote(input.changeNote);
    const result = await this.#repository.appendVersion({
      actorUserId,
      listId: list.id,
      expectedCurrentVersionId: base.id,
      state: "published",
      entries: base.entries,
      provenance: {
        operation: "edit",
        sources: [
          {
            kind: "manual",
            sourceId: actorUserId,
            versionId: base.id,
            checksumSha256: base.checksumSha256,
            observedAt: now.toISOString(),
            label: "Publish immutable snapshot",
          },
        ],
        note,
      },
      changeNote: note,
      createdAt: now,
    });
    return result.status === "saved" ? result.version : throwMutationFailure(result);
  }

  async previewCsv(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly source: string;
    readonly mapping: CsvColumnMapping;
    readonly hasHeader?: boolean;
  }): Promise<RankingCsvPreview> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    const now = this.#now().toISOString();
    return previewRankingCsv(input.source, {
      mapping: input.mapping,
      attribution: createUserAttribution(actorUserId, now),
      ...(input.hasHeader === undefined ? {} : { hasHeader: input.hasHeader }),
      resolvePlayer: await this.#playerResolver(),
    });
  }

  async importCsv(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly expectedCurrentVersionId: string | null;
    readonly idempotencyKey: string;
    readonly source: string;
    readonly sourceFileName?: string | null;
    readonly mapping: CsvColumnMapping;
    readonly decision: RankingCsvCommitDecision;
    readonly hasHeader?: boolean;
    readonly changeNote?: string | null;
  }): Promise<RankingVersion> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const list = await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    const now = this.#now();
    const resolver = await this.#playerResolver();
    let preview: RankingCsvPreview;
    try {
      preview = previewRankingCsv(input.source, {
        mapping: input.mapping,
        attribution: createUserAttribution(actorUserId, now.toISOString()),
        ...(input.hasHeader === undefined ? {} : { hasHeader: input.hasHeader }),
        resolvePlayer: resolver,
      });
    } catch {
      throw new RankingServiceError("RANKING_IMPORT_INVALID");
    }
    let committed;
    try {
      committed = commitRankingCsvPreview(preview, input.decision);
    } catch {
      throw new RankingServiceError("RANKING_IMPORT_INVALID");
    }
    return this.#commitImport({
      actorUserId,
      list,
      expectedCurrentVersionId: expectedVersionId(input.expectedCurrentVersionId),
      idempotencyKey: idempotencyKeySchema.parse(input.idempotencyKey),
      sourceFormat: "csv",
      sourceFileName: sourceFileName(input.sourceFileName),
      sourceChecksumSha256: committed.sourceChecksumSha256,
      previewChecksumSha256: committed.previewChecksumSha256,
      columnMapping: csvMappingRecord(input.mapping),
      entries: committed.entries,
      rowsRead: preview.summary.total,
      rowsAccepted: committed.entries.length,
      rowsRejected: preview.summary.total - committed.entries.length,
      acceptedRowNumbers: committed.acceptedRowNumbers,
      validationSummary: { ...preview.summary, canCommitAll: preview.canCommitAll },
      diagnostics: diagnosticRecords(preview),
      changeNote: changeNote(input.changeNote),
      now,
    });
  }

  async importJson(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly expectedCurrentVersionId: string | null;
    readonly idempotencyKey: string;
    readonly source: string;
    readonly sourceFileName?: string | null;
    readonly changeNote?: string | null;
  }): Promise<RankingVersion> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const list = await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    let artifact;
    try {
      artifact = parseRankingJson(input.source);
    } catch {
      throw new RankingServiceError("RANKING_IMPORT_INVALID");
    }
    const sourceChecksumSha256 = checksumUtf8Sha256(input.source);
    const now = this.#now();
    return this.#commitImport({
      actorUserId,
      list,
      expectedCurrentVersionId: expectedVersionId(input.expectedCurrentVersionId),
      idempotencyKey: idempotencyKeySchema.parse(input.idempotencyKey),
      sourceFormat: "json",
      sourceFileName: sourceFileName(input.sourceFileName),
      sourceChecksumSha256,
      previewChecksumSha256: null,
      columnMapping: {},
      entries: artifact.version.entries,
      rowsRead: artifact.version.entries.length,
      rowsAccepted: artifact.version.entries.length,
      rowsRejected: 0,
      acceptedRowNumbers: [],
      validationSummary: {
        schemaVersion: RANKING_SCHEMA_VERSION,
        sourceVersionId: artifact.version.id,
      },
      diagnostics: [],
      changeNote: changeNote(input.changeNote),
      now,
      sourceVersion: artifact.version,
      sourceLabel: artifact.list.name,
    });
  }

  async export(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly versionId?: string;
    readonly format: "json" | "csv";
  }): Promise<string> {
    const list = await this.getList(input.actorUserId, input.listId);
    const version = await this.getVersion(input.actorUserId, list.id, input.versionId);
    return input.format === "csv"
      ? exportRankingEntriesCsv(version.entries)
      : exportRankingJson(list, version, this.#now().toISOString(), { indentation: 2 });
  }

  async createShare(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly label?: string | null;
    readonly allowCopy?: boolean;
    readonly expiresAt?: Date | null;
    readonly maxUses?: number | null;
  }): Promise<{
    readonly id: string;
    readonly token: string;
    readonly list: RankingList;
    readonly expiresAt: Date | null;
  }> {
    const actorUserId = uuidSchema.parse(input.actorUserId);
    const list = await this.#ownedList(actorUserId, uuidSchema.parse(input.listId));
    if (!list.currentVersionId) throw new RankingServiceError("RANKING_NOT_FOUND");
    const now = this.#now();
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt && (!dateSchema.safeParse(expiresAt).success || expiresAt <= now)) {
      throw new RankingServiceError("RANKING_INVALID_INPUT");
    }
    const maxUses = input.maxUses ?? null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000)) {
      throw new RankingServiceError("RANKING_INVALID_INPUT");
    }
    const token = shareToken();
    const id = this.#id();
    const record = await this.#repository.createShare({
      id,
      actorUserId,
      listId: list.id,
      tokenHash: hashRankingShareToken(token, this.#shareKeyring),
      label: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .nullable()
        .parse(input.label?.trim() || null),
      allowCopy: input.allowCopy === true,
      expiresAt,
      maxUses,
      now,
    });
    if (!record) throw new RankingServiceError("RANKING_FORBIDDEN");
    return { id: record.id, token, list: record.list, expiresAt };
  }

  async openShare(token: string): Promise<{
    readonly list: RankingList;
    readonly version: RankingVersion;
    readonly allowCopy: boolean;
    readonly players: readonly RankingPlayerIdentity[];
  }> {
    const authorization = await this.#repository.consumeShare(
      hashRankingShareToken(token, this.#shareKeyring),
      this.#now(),
    );
    if (!authorization) throw new RankingServiceError("RANKING_SHARE_UNAVAILABLE");
    const list = await this.#repository.getList(authorization.listId);
    if (!list?.currentVersionId) throw new RankingServiceError("RANKING_SHARE_UNAVAILABLE");
    const version = await this.#repository.getVersion(list.currentVersionId);
    if (!version || version.listId !== list.id) {
      throw new RankingServiceError("RANKING_SHARE_UNAVAILABLE");
    }
    return {
      list,
      version,
      allowCopy: authorization.allowCopy,
      players: await this.#repository.getPlayerIdentities(
        version.entries.map((entry) => entry.playerId),
      ),
    };
  }

  async exportShare(token: string, format: "json" | "csv"): Promise<string> {
    const shared = await this.openShare(token);
    if (!shared.allowCopy) throw new RankingServiceError("RANKING_SHARE_UNAVAILABLE");
    return format === "csv"
      ? exportRankingEntriesCsv(shared.version.entries)
      : exportRankingJson(shared.list, shared.version, this.#now().toISOString(), {
          indentation: 2,
        });
  }

  async revokeShare(actorUserId: string, shareId: string): Promise<void> {
    const result = await this.#repository.revokeShare(
      uuidSchema.parse(actorUserId),
      uuidSchema.parse(shareId),
      this.#now(),
    );
    if (result === "not_found") throw new RankingServiceError("RANKING_SHARE_UNAVAILABLE");
    if (result === "forbidden") throw new RankingServiceError("RANKING_FORBIDDEN");
  }

  async #commitImport(input: {
    readonly actorUserId: string;
    readonly list: RankingList;
    readonly expectedCurrentVersionId: string | null;
    readonly idempotencyKey: string;
    readonly sourceFormat: "csv" | "json";
    readonly sourceFileName: string | null;
    readonly sourceChecksumSha256: string;
    readonly previewChecksumSha256: string | null;
    readonly columnMapping: Readonly<Record<string, string>>;
    readonly entries: readonly RankingEntry[];
    readonly rowsRead: number;
    readonly rowsAccepted: number;
    readonly rowsRejected: number;
    readonly acceptedRowNumbers: readonly number[];
    readonly validationSummary: Readonly<Record<string, unknown>>;
    readonly diagnostics: readonly Readonly<Record<string, unknown>>[];
    readonly changeNote: string | null;
    readonly now: Date;
    readonly sourceVersion?: RankingVersion;
    readonly sourceLabel?: string;
  }): Promise<RankingVersion> {
    const started = await this.#repository.startImport({
      actorUserId: input.actorUserId,
      listId: input.list.id,
      idempotencyKey: input.idempotencyKey,
      sourceFormat: input.sourceFormat,
      sourceFileName: input.sourceFileName,
      sourceChecksumSha256: input.sourceChecksumSha256,
      now: input.now,
    });
    if (started.status === "conflict") {
      throw new RankingServiceError("RANKING_IMPORT_CONFLICT");
    }
    if (started.record.state === "succeeded") {
      const version = await this.#repository.getVersionByImportRunId(started.record.id);
      if (!version) throw new RankingServiceError("RANKING_IMPORT_CONFLICT");
      return version;
    }
    const provenance: RankingProvenance = {
      operation: "import",
      sources: [
        {
          kind: input.sourceFormat === "csv" ? "csv-import" : "json-import",
          sourceId: started.record.id,
          versionId: input.sourceVersion?.id ?? null,
          checksumSha256: input.sourceChecksumSha256,
          observedAt: input.now.toISOString(),
          label:
            input.sourceLabel ??
            input.sourceFileName ??
            `${input.sourceFormat.toUpperCase()} import`,
        },
      ],
      note: input.changeNote,
    };
    const result = await this.#repository.commitImport({
      actorUserId: input.actorUserId,
      listId: input.list.id,
      expectedCurrentVersionId: input.expectedCurrentVersionId,
      state: "draft",
      entries: input.entries,
      provenance,
      changeNote: input.changeNote,
      createdAt: input.now,
      importRunId: started.record.id,
      sourceFormat: input.sourceFormat,
      sourceChecksumSha256: input.sourceChecksumSha256,
      previewChecksumSha256: input.previewChecksumSha256,
      columnMapping: input.columnMapping,
      rowsRead: input.rowsRead,
      rowsAccepted: input.rowsAccepted,
      rowsRejected: input.rowsRejected,
      acceptedRowNumbers: input.acceptedRowNumbers,
      validationSummary: input.validationSummary,
      diagnostics: input.diagnostics,
    });
    if (result.status === "saved") return result.version;
    await this.#repository.failImport(started.record.id, result.status, this.#now());
    return throwMutationFailure(result);
  }

  async #ownedList(actorUserId: string, listId: string): Promise<RankingList> {
    const list = await this.#existingList(listId);
    if (list.ownerUserId !== actorUserId) throw new RankingServiceError("RANKING_FORBIDDEN");
    return list;
  }

  async #existingList(listId: string): Promise<RankingList> {
    const list = await this.#repository.getList(listId);
    if (!list) throw new RankingServiceError("RANKING_NOT_FOUND");
    return list;
  }

  async #assertLeagueMemberships(userId: string, leagueIds: readonly string[]): Promise<void> {
    if (leagueIds.length === 0) return;
    if (!(await this.#repository.hasEveryLeagueMembership(userId, leagueIds))) {
      throw new RankingServiceError("RANKING_FORBIDDEN");
    }
  }

  async #playerResolver() {
    const identities = await this.#repository.listPlayerIdentities();
    const byId = new Map(identities.map((player) => [player.id, player]));
    const byName = new Map<string, RankingPlayerIdentity[]>();
    for (const player of identities) {
      const normalized = player.fullName.trim().toLocaleLowerCase();
      const matches = byName.get(normalized) ?? [];
      matches.push(player);
      byName.set(normalized, matches);
    }
    return (identity: {
      readonly playerId: string | null;
      readonly playerName: string | null;
      readonly position: z.infer<typeof positionSchema> | null;
    }) => {
      if (identity.playerId) {
        const player = byId.get(identity.playerId);
        return player
          ? { status: "resolved" as const, playerId: player.id, position: player.position }
          : {
              status: "unresolved" as const,
              reason: "Player ID was not found",
              candidatePlayerIds: [],
            };
      }
      const candidates = byName.get(identity.playerName?.trim().toLocaleLowerCase() ?? "") ?? [];
      const positionMatches = identity.position
        ? candidates.filter((candidate) => candidate.position === identity.position)
        : candidates;
      return positionMatches.length === 1
        ? {
            status: "resolved" as const,
            playerId: positionMatches[0]?.id ?? "",
            position: positionMatches[0]?.position ?? null,
          }
        : {
            status: "unresolved" as const,
            reason:
              positionMatches.length === 0
                ? "Player name was not found"
                : "Player name is ambiguous",
            candidatePlayerIds: positionMatches.slice(0, 20).map((candidate) => candidate.id),
          };
    };
  }
}
