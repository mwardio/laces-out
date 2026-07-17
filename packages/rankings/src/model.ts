import { NFL_POSITIONS } from "@fantasy/domain";
import { z } from "zod";

export const RANKING_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().trim().min(1).max(160);
const labelSchema = z.string().trim().min(1).max(160);
const isoDateTimeSchema = z.string().datetime({ offset: true });
export const checksumSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be a SHA-256 checksum");
export const positionSchema = z.enum(NFL_POSITIONS);

const privateVisibilitySchema = z
  .object({
    scope: z.literal("private"),
  })
  .strict()
  .readonly();

const leagueVisibilitySchema = z
  .object({
    scope: z.literal("league"),
    leagueIds: z.array(idSchema).min(1).max(64).readonly(),
    allowClone: z.boolean(),
  })
  .strict()
  .superRefine((visibility, context) => {
    if (new Set(visibility.leagueIds).size !== visibility.leagueIds.length) {
      context.addIssue({
        code: "custom",
        path: ["leagueIds"],
        message: "leagueIds must be unique",
      });
    }
  })
  .readonly();

const sharedLinkVisibilitySchema = z
  .object({
    scope: z.literal("shared-link"),
    shareLinkId: idSchema,
    allowClone: z.boolean(),
    expiresAt: isoDateTimeSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .readonly();

export const rankingVisibilitySchema = z.discriminatedUnion("scope", [
  privateVisibilitySchema,
  leagueVisibilitySchema,
  sharedLinkVisibilitySchema,
]);
export type RankingVisibility = z.infer<typeof rankingVisibilitySchema>;

export const rankingListKindSchema = z.enum(["rankings", "adp", "auction-values", "cheat-sheet"]);
export type RankingListKind = z.infer<typeof rankingListKindSchema>;

export const scoringContextSchema = z
  .object({
    format: z.enum(["STANDARD", "HALF_PPR", "PPR", "CUSTOM"]),
    leagueId: idSchema.nullable(),
    settingsChecksumSha256: checksumSha256Schema.nullable(),
    label: z.string().trim().min(1).max(160).nullable(),
  })
  .strict()
  .readonly();
export type ScoringContext = z.infer<typeof scoringContextSchema>;

export const rankingListSchema = z
  .object({
    schemaVersion: z.literal(RANKING_SCHEMA_VERSION),
    id: idSchema,
    ownerUserId: idSchema,
    name: labelSchema,
    description: z.string().max(4_000).nullable(),
    season: z.number().int().min(2000).max(2100),
    kind: rankingListKindSchema,
    scoringContext: scoringContextSchema,
    visibility: rankingVisibilitySchema,
    currentVersionId: idSchema.nullable(),
    latestPublishedVersionId: idSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    archivedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((list, context) => {
    if (Date.parse(list.updatedAt) < Date.parse(list.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt cannot be before createdAt",
      });
    }
    if (list.archivedAt !== null && Date.parse(list.archivedAt) < Date.parse(list.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["archivedAt"],
        message: "archivedAt cannot be before createdAt",
      });
    }
  })
  .readonly();
export type RankingList = z.infer<typeof rankingListSchema>;

export const userFieldAttributionSchema = z
  .object({
    kind: z.literal("user"),
    authorUserId: idSchema,
    authoredAt: isoDateTimeSchema,
  })
  .strict()
  .readonly();

export const derivedFieldAttributionSchema = z
  .object({
    kind: z.literal("derived"),
    sourceId: idSchema,
    computedAt: isoDateTimeSchema,
    inputChecksumSha256: checksumSha256Schema,
  })
  .strict()
  .readonly();

export const fieldAttributionSchema = z.discriminatedUnion("kind", [
  userFieldAttributionSchema,
  derivedFieldAttributionSchema,
]);
export type FieldAttribution = z.infer<typeof fieldAttributionSchema>;

export type UserFieldAttribution = z.infer<typeof userFieldAttributionSchema>;
export type DerivedFieldAttribution = z.infer<typeof derivedFieldAttributionSchema>;

export type SourcedField<Value> = Readonly<
  | ({ readonly value: Value } & UserFieldAttribution)
  | ({ readonly value: Value } & DerivedFieldAttribution)
>;

function sourcedFieldSchema<ValueSchema extends z.ZodType>(valueSchema: ValueSchema) {
  return z
    .discriminatedUnion("kind", [
      z
        .object({
          value: valueSchema,
          kind: z.literal("user"),
          authorUserId: idSchema,
          authoredAt: isoDateTimeSchema,
        })
        .strict(),
      z
        .object({
          value: valueSchema,
          kind: z.literal("derived"),
          sourceId: idSchema,
          computedAt: isoDateTimeSchema,
          inputChecksumSha256: checksumSha256Schema,
        })
        .strict(),
    ])
    .readonly();
}

const positiveRankSchema = z.number().int().min(1).max(10_000);
const finiteNonNegativeSchema = z.number().finite().min(0).max(1_000_000);
const tagsSchema = z
  .array(z.string().trim().min(1).max(80))
  .max(64)
  .superRefine((tags, context) => {
    const normalized = tags.map((tag) => tag.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", message: "tags must be unique (case-insensitive)" });
    }
  })
  .readonly();

export const rankingEntrySchema = z
  .object({
    playerId: idSchema,
    position: positionSchema.nullable(),
    overallRank: sourcedFieldSchema(positiveRankSchema).nullable(),
    positionRank: sourcedFieldSchema(positiveRankSchema).nullable(),
    tier: sourcedFieldSchema(positiveRankSchema).nullable(),
    adp: sourcedFieldSchema(z.number().finite().gt(0).max(10_000)).nullable(),
    aav: sourcedFieldSchema(finiteNonNegativeSchema).nullable(),
    floorPrice: sourcedFieldSchema(finiteNonNegativeSchema).nullable(),
    targetPrice: sourcedFieldSchema(finiteNonNegativeSchema).nullable(),
    ceilingPrice: sourcedFieldSchema(finiteNonNegativeSchema).nullable(),
    confidence: sourcedFieldSchema(z.number().finite().min(0).max(1)).nullable(),
    tags: sourcedFieldSchema(tagsSchema).nullable(),
    notes: sourcedFieldSchema(z.string().max(10_000)).nullable(),
    target: sourcedFieldSchema(z.boolean()).nullable(),
    avoid: sourcedFieldSchema(z.boolean()).nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.position === null && entry.positionRank !== null) {
      context.addIssue({
        code: "custom",
        path: ["positionRank"],
        message: "positionRank requires a position",
      });
    }

    const floor = entry.floorPrice?.value;
    const target = entry.targetPrice?.value;
    const ceiling = entry.ceilingPrice?.value;
    if (floor !== undefined && target !== undefined && floor > target) {
      context.addIssue({
        code: "custom",
        path: ["floorPrice"],
        message: "floorPrice cannot exceed targetPrice",
      });
    }
    if (target !== undefined && ceiling !== undefined && target > ceiling) {
      context.addIssue({
        code: "custom",
        path: ["targetPrice"],
        message: "targetPrice cannot exceed ceilingPrice",
      });
    }
    if (floor !== undefined && ceiling !== undefined && floor > ceiling) {
      context.addIssue({
        code: "custom",
        path: ["floorPrice"],
        message: "floorPrice cannot exceed ceilingPrice",
      });
    }
    if (entry.target?.value === true && entry.avoid?.value === true) {
      context.addIssue({
        code: "custom",
        path: ["avoid"],
        message: "a player cannot be both a target and an avoid",
      });
    }
  })
  .readonly();
export type RankingEntry = z.infer<typeof rankingEntrySchema>;

export const RANKING_FIELD_NAMES = [
  "overallRank",
  "positionRank",
  "tier",
  "adp",
  "aav",
  "floorPrice",
  "targetPrice",
  "ceilingPrice",
  "confidence",
  "tags",
  "notes",
  "target",
  "avoid",
] as const;
export const rankingFieldNameSchema = z.enum(RANKING_FIELD_NAMES);
export type RankingFieldName = (typeof RANKING_FIELD_NAMES)[number];
export type RankingEntryField = RankingEntry[RankingFieldName];

export const provenanceSourceSchema = z
  .object({
    kind: z.enum([
      "manual",
      "csv-import",
      "json-import",
      "clone",
      "merge",
      "derived",
      "league-overlay",
    ]),
    sourceId: idSchema,
    versionId: idSchema.nullable(),
    checksumSha256: checksumSha256Schema.nullable(),
    observedAt: isoDateTimeSchema.nullable(),
    label: z.string().trim().min(1).max(240).nullable(),
  })
  .strict()
  .readonly();
export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;

export const rankingProvenanceSchema = z
  .object({
    operation: z.enum(["create", "edit", "import", "clone", "merge", "derive", "overlay"]),
    sources: z.array(provenanceSourceSchema).max(64).readonly(),
    note: z.string().max(2_000).nullable(),
  })
  .strict()
  .readonly();
export type RankingProvenance = z.infer<typeof rankingProvenanceSchema>;

const versionBaseShape = {
  schemaVersion: z.literal(RANKING_SCHEMA_VERSION),
  id: idSchema,
  listId: idSchema,
  versionNumber: z.number().int().min(1),
  parentVersionId: idSchema.nullable(),
  state: z.enum(["draft", "published"]),
  authorUserId: idSchema,
  createdAt: isoDateTimeSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  changeNote: z.string().max(2_000).nullable(),
  entries: z.array(rankingEntrySchema).max(10_000).readonly(),
  provenance: rankingProvenanceSchema,
} as const;

export const rankingVersionPayloadSchema = z
  .object(versionBaseShape)
  .strict()
  .superRefine((version, context) => {
    if (version.state === "published" && version.publishedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "published versions require publishedAt",
      });
    }
    if (version.state === "draft" && version.publishedAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "draft versions cannot have publishedAt",
      });
    }
    if (
      version.publishedAt !== null &&
      Date.parse(version.publishedAt) < Date.parse(version.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "publishedAt cannot be before createdAt",
      });
    }
    if (version.parentVersionId === version.id) {
      context.addIssue({
        code: "custom",
        path: ["parentVersionId"],
        message: "a version cannot be its own parent",
      });
    }

    const playerIds = version.entries.map((entry) => entry.playerId);
    if (new Set(playerIds).size !== playerIds.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "a ranking version cannot contain duplicate players",
      });
    }
  })
  .readonly();
export type RankingVersionPayload = z.infer<typeof rankingVersionPayloadSchema>;

export const rankingVersionSchema = z
  .object({
    ...versionBaseShape,
    checksumSha256: checksumSha256Schema,
  })
  .strict()
  .superRefine((version, context) => {
    const { checksumSha256: _checksumSha256, ...payload } = version;
    void _checksumSha256;
    const payloadResult = rankingVersionPayloadSchema.safeParse(payload);
    if (!payloadResult.success) {
      for (const issue of payloadResult.error.issues) {
        context.addIssue({ ...issue, path: issue.path });
      }
    }
  })
  .readonly();
export type RankingVersion = z.infer<typeof rankingVersionSchema>;

const overlayEntryShape = {
  playerId: idSchema,
  position: positionSchema.nullable().optional(),
  overallRank: sourcedFieldSchema(positiveRankSchema).optional(),
  positionRank: sourcedFieldSchema(positiveRankSchema).optional(),
  tier: sourcedFieldSchema(positiveRankSchema).optional(),
  adp: sourcedFieldSchema(z.number().finite().gt(0).max(10_000)).optional(),
  aav: sourcedFieldSchema(finiteNonNegativeSchema).optional(),
  floorPrice: sourcedFieldSchema(finiteNonNegativeSchema).optional(),
  targetPrice: sourcedFieldSchema(finiteNonNegativeSchema).optional(),
  ceilingPrice: sourcedFieldSchema(finiteNonNegativeSchema).optional(),
  confidence: sourcedFieldSchema(z.number().finite().min(0).max(1)).optional(),
  tags: sourcedFieldSchema(tagsSchema).optional(),
  notes: sourcedFieldSchema(z.string().max(10_000)).optional(),
  target: sourcedFieldSchema(z.boolean()).optional(),
  avoid: sourcedFieldSchema(z.boolean()).optional(),
} as const;

export const leagueOverlayEntrySchema = z.object(overlayEntryShape).strict().readonly();
export type LeagueOverlayEntry = z.infer<typeof leagueOverlayEntrySchema>;

const leagueOverlayPayloadShape = {
  schemaVersion: z.literal(RANKING_SCHEMA_VERSION),
  id: idSchema,
  leagueId: idSchema,
  baseVersionId: idSchema,
  generatedAt: isoDateTimeSchema,
  entries: z.array(leagueOverlayEntrySchema).max(10_000).readonly(),
  provenance: rankingProvenanceSchema,
} as const;

export const leagueOverlayPayloadSchema = z
  .object(leagueOverlayPayloadShape)
  .strict()
  .superRefine((overlay, context) => {
    const playerIds = overlay.entries.map((entry) => entry.playerId);
    if (new Set(playerIds).size !== playerIds.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "an overlay cannot contain duplicate players",
      });
    }
  })
  .readonly();
export type LeagueOverlayPayload = z.infer<typeof leagueOverlayPayloadSchema>;

export const leagueOverlaySchema = z
  .object({
    ...leagueOverlayPayloadShape,
    checksumSha256: checksumSha256Schema,
  })
  .strict()
  .superRefine((overlay, context) => {
    const { checksumSha256: _checksumSha256, ...payload } = overlay;
    void _checksumSha256;
    const payloadResult = leagueOverlayPayloadSchema.safeParse(payload);
    if (!payloadResult.success) {
      for (const issue of payloadResult.error.issues) {
        context.addIssue({ ...issue, path: issue.path });
      }
    }
  })
  .readonly();
export type LeagueOverlay = z.infer<typeof leagueOverlaySchema>;

export function createUserAttribution(
  authorUserId: string,
  authoredAt: string,
): UserFieldAttribution {
  return userFieldAttributionSchema.parse({ kind: "user", authorUserId, authoredAt });
}

export function createDerivedAttribution(
  sourceId: string,
  computedAt: string,
  inputChecksumSha256: string,
): DerivedFieldAttribution {
  return derivedFieldAttributionSchema.parse({
    kind: "derived",
    sourceId,
    computedAt,
    inputChecksumSha256,
  });
}

export function sourcedValue<Value>(
  value: Value,
  attribution: FieldAttribution,
): SourcedField<Value> {
  return Object.freeze({ value, ...attribution });
}

export function emptyRankingEntry(
  playerId: string,
  position: z.infer<typeof positionSchema> | null,
) {
  return rankingEntrySchema.parse({
    playerId,
    position,
    overallRank: null,
    positionRank: null,
    tier: null,
    adp: null,
    aav: null,
    floorPrice: null,
    targetPrice: null,
    ceilingPrice: null,
    confidence: null,
    tags: null,
    notes: null,
    target: null,
    avoid: null,
  });
}
