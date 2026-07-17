import { createHash } from "node:crypto";

import { z } from "zod";

import {
  RANKING_FIELD_NAMES,
  RANKING_SCHEMA_VERSION,
  leagueOverlayPayloadSchema,
  leagueOverlaySchema,
  rankingEntrySchema,
  rankingListSchema,
  rankingVisibilitySchema,
  rankingVersionPayloadSchema,
  rankingVersionSchema,
  type LeagueOverlay,
  type LeagueOverlayPayload,
  type RankingEntry,
  type RankingEntryField,
  type RankingFieldName,
  type RankingList,
  type RankingProvenance,
  type RankingVersion,
  type RankingVersionPayload,
  type RankingVisibility,
  type ScoringContext,
} from "./model.js";

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function toCanonicalValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(toCanonicalValue);
  if (typeof value === "object") {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = toCanonicalValue(child);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

/** Deterministic JSON for checksums and portable exports. Object keys are sorted recursively. */
export function canonicalJson(value: unknown, indentation?: number): string {
  return JSON.stringify(toCanonicalValue(value), null, indentation);
}

export function checksumSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** SHA-256 of exact UTF-8 text bytes, used for imported source artifacts. */
export function checksumUtf8Sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function checksumRankingEntries(entries: readonly RankingEntry[]): string {
  const parsed = z.array(rankingEntrySchema).max(10_000).parse(entries);
  return checksumSha256(parsed);
}

export function createRankingVersion(input: RankingVersionPayload): RankingVersion {
  const payload = rankingVersionPayloadSchema.parse(input);
  return rankingVersionSchema.parse({
    ...payload,
    checksumSha256: checksumSha256(payload),
  });
}

export function verifyRankingVersionChecksum(version: RankingVersion): boolean {
  const parsed = rankingVersionSchema.parse(version);
  const { checksumSha256: expectedChecksum, ...payload } = parsed;
  return checksumSha256(payload) === expectedChecksum;
}

export class RankingIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RankingIntegrityError";
  }
}

export function parseRankingVersion(input: unknown): RankingVersion {
  const version = rankingVersionSchema.parse(input);
  if (!verifyRankingVersionChecksum(version)) {
    throw new RankingIntegrityError("Ranking version checksum does not match its contents");
  }
  return version;
}

export function createLeagueOverlay(input: LeagueOverlayPayload): LeagueOverlay {
  const payload = leagueOverlayPayloadSchema.parse(input);
  return leagueOverlaySchema.parse({
    ...payload,
    checksumSha256: checksumSha256(payload),
  });
}

export function verifyLeagueOverlayChecksum(overlay: LeagueOverlay): boolean {
  const parsed = leagueOverlaySchema.parse(overlay);
  const { checksumSha256: expectedChecksum, ...payload } = parsed;
  return checksumSha256(payload) === expectedChecksum;
}

export function parseLeagueOverlay(input: unknown): LeagueOverlay {
  const overlay = leagueOverlaySchema.parse(input);
  if (!verifyLeagueOverlayChecksum(overlay)) {
    throw new RankingIntegrityError("League overlay checksum does not match its contents");
  }
  return overlay;
}

export interface CreateRankingListInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly season: number;
  readonly kind: RankingList["kind"];
  readonly scoringContext: ScoringContext;
  readonly visibility?: RankingVisibility;
  readonly createdAt: string;
}

export function createRankingList(input: CreateRankingListInput): RankingList {
  return rankingListSchema.parse({
    schemaVersion: RANKING_SCHEMA_VERSION,
    id: input.id,
    ownerUserId: input.ownerUserId,
    name: input.name,
    description: input.description ?? null,
    season: input.season,
    kind: input.kind,
    scoringContext: input.scoringContext,
    visibility: input.visibility ?? { scope: "private" },
    currentVersionId: null,
    latestPublishedVersionId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
  });
}

const rankingListPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(4_000).nullable().optional(),
    visibility: rankingVisibilitySchema.optional(),
    currentVersionId: z.string().trim().min(1).max(160).nullable().optional(),
    latestPublishedVersionId: z.string().trim().min(1).max(160).nullable().optional(),
    archivedAt: z.string().datetime({ offset: true }).nullable().optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RankingListPatch = z.input<typeof rankingListPatchSchema>;

/** Metadata edits return a new frozen value and cannot transfer ownership or rewrite history. */
export function updateRankingList(list: RankingList, patch: RankingListPatch): RankingList {
  const current = rankingListSchema.parse(list);
  const change = rankingListPatchSchema.parse(patch);
  return rankingListSchema.parse({ ...current, ...change });
}

export interface RankingFieldChange {
  readonly playerId: string;
  readonly field: RankingFieldName | "position";
  readonly before: RankingEntryField | RankingEntry["position"];
  readonly after: RankingEntryField | RankingEntry["position"];
}

export interface RankingMove {
  readonly playerId: string;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromOverallRank: number | null;
  readonly toOverallRank: number | null;
}

export interface RankingVersionDiff {
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly fromChecksumSha256: string;
  readonly toChecksumSha256: string;
  readonly addedPlayerIds: readonly string[];
  readonly removedPlayerIds: readonly string[];
  readonly moves: readonly RankingMove[];
  readonly fieldChanges: readonly RankingFieldChange[];
  readonly provenanceChanged: boolean;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function diffRankingVersions(
  beforeInput: RankingVersion,
  afterInput: RankingVersion,
): RankingVersionDiff {
  const before = parseRankingVersion(beforeInput);
  const after = parseRankingVersion(afterInput);
  if (before.listId !== after.listId) {
    throw new RangeError("Ranking versions from different lists cannot be diffed");
  }

  const beforeByPlayer = new Map(
    before.entries.map((entry, index) => [entry.playerId, { entry, index }]),
  );
  const afterByPlayer = new Map(
    after.entries.map((entry, index) => [entry.playerId, { entry, index }]),
  );
  const addedPlayerIds = after.entries
    .filter((entry) => !beforeByPlayer.has(entry.playerId))
    .map((entry) => entry.playerId);
  const removedPlayerIds = before.entries
    .filter((entry) => !afterByPlayer.has(entry.playerId))
    .map((entry) => entry.playerId);
  const moves: RankingMove[] = [];
  const fieldChanges: RankingFieldChange[] = [];

  for (const [playerId, beforeRecord] of beforeByPlayer) {
    const afterRecord = afterByPlayer.get(playerId);
    if (!afterRecord) continue;
    if (beforeRecord.index !== afterRecord.index) {
      moves.push({
        playerId,
        fromIndex: beforeRecord.index,
        toIndex: afterRecord.index,
        fromOverallRank: beforeRecord.entry.overallRank?.value ?? null,
        toOverallRank: afterRecord.entry.overallRank?.value ?? null,
      });
    }
    if (beforeRecord.entry.position !== afterRecord.entry.position) {
      fieldChanges.push({
        playerId,
        field: "position",
        before: beforeRecord.entry.position,
        after: afterRecord.entry.position,
      });
    }
    for (const field of RANKING_FIELD_NAMES) {
      const previousValue = beforeRecord.entry[field];
      const nextValue = afterRecord.entry[field];
      if (!sameCanonicalValue(previousValue, nextValue)) {
        fieldChanges.push({ playerId, field, before: previousValue, after: nextValue });
      }
    }
  }

  return Object.freeze({
    fromVersionId: before.id,
    toVersionId: after.id,
    fromChecksumSha256: before.checksumSha256,
    toChecksumSha256: after.checksumSha256,
    addedPlayerIds: Object.freeze(addedPlayerIds),
    removedPlayerIds: Object.freeze(removedPlayerIds),
    moves: Object.freeze(moves.map((move) => Object.freeze(move))),
    fieldChanges: Object.freeze(fieldChanges.map((change) => Object.freeze(change))),
    provenanceChanged: !sameCanonicalValue(before.provenance, after.provenance),
  });
}

export interface CloneRankingInput {
  readonly listId: string;
  readonly versionId: string;
  readonly ownerUserId: string;
  readonly authorUserId: string;
  readonly name: string;
  readonly visibility?: RankingVisibility;
  readonly createdAt: string;
  readonly changeNote?: string | null;
}

export interface ClonedRanking {
  readonly list: RankingList;
  readonly version: RankingVersion;
}

/** Clone values and provenance into independent IDs; later source edits cannot leak into the clone. */
export function cloneRanking(
  sourceListInput: RankingList,
  sourceVersionInput: RankingVersion,
  input: CloneRankingInput,
): ClonedRanking {
  const sourceList = rankingListSchema.parse(sourceListInput);
  const sourceVersion = parseRankingVersion(sourceVersionInput);
  if (sourceVersion.listId !== sourceList.id) {
    throw new RangeError("The source version does not belong to the source list");
  }

  const list = createRankingList({
    id: input.listId,
    ownerUserId: input.ownerUserId,
    name: input.name,
    description: sourceList.description,
    season: sourceList.season,
    kind: sourceList.kind,
    scoringContext: sourceList.scoringContext,
    createdAt: input.createdAt,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
  });
  const provenance: RankingProvenance = {
    operation: "clone",
    sources: [
      {
        kind: "clone",
        sourceId: sourceList.id,
        versionId: sourceVersion.id,
        checksumSha256: sourceVersion.checksumSha256,
        observedAt: input.createdAt,
        label: sourceList.name,
      },
    ],
    note: input.changeNote ?? null,
  };
  const version = createRankingVersion({
    schemaVersion: RANKING_SCHEMA_VERSION,
    id: input.versionId,
    listId: list.id,
    versionNumber: 1,
    parentVersionId: null,
    state: "draft",
    authorUserId: input.authorUserId,
    createdAt: input.createdAt,
    publishedAt: null,
    changeNote: input.changeNote ?? `Cloned from ${sourceList.name}`,
    entries: sourceVersion.entries.map((entry) => rankingEntrySchema.parse(entry)),
    provenance,
  });

  return Object.freeze({
    list: updateRankingList(list, { currentVersionId: version.id, updatedAt: input.createdAt }),
    version,
  });
}
