import { z } from "zod";

import {
  RANKING_SCHEMA_VERSION,
  rankingListSchema,
  rankingVersionSchema,
  type RankingList,
  type RankingVersion,
} from "./model.js";
import { canonicalJson, parseRankingVersion } from "./integrity.js";

export const MAX_RANKING_JSON_BYTES = 10 * 1024 * 1024;

export const portableRankingArtifactSchema = z
  .object({
    schemaVersion: z.literal(RANKING_SCHEMA_VERSION),
    exportedAt: z.string().datetime({ offset: true }),
    list: rankingListSchema,
    version: rankingVersionSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.version.listId !== artifact.list.id) {
      context.addIssue({
        code: "custom",
        path: ["version", "listId"],
        message: "exported version does not belong to the exported list",
      });
    }
  })
  .readonly();
export type PortableRankingArtifact = z.infer<typeof portableRankingArtifactSchema>;

export interface RankingJsonExportOptions {
  readonly indentation?: 0 | 2;
}

export function exportRankingJson(
  listInput: RankingList,
  versionInput: RankingVersion,
  exportedAt: string,
  options: RankingJsonExportOptions = {},
): string {
  const list = rankingListSchema.parse(listInput);
  const version = parseRankingVersion(versionInput);
  const artifact = portableRankingArtifactSchema.parse({
    schemaVersion: RANKING_SCHEMA_VERSION,
    exportedAt,
    list,
    version,
  });
  return canonicalJson(artifact, options.indentation);
}

export class RankingJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RankingJsonError";
  }
}

export function parseRankingJson(source: string): PortableRankingArtifact {
  if (typeof source !== "string") throw new TypeError("Ranking JSON must be a string");
  if (new TextEncoder().encode(source).byteLength > MAX_RANKING_JSON_BYTES) {
    throw new RankingJsonError("Ranking JSON exceeds the size limit");
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new RankingJsonError("Ranking export is not valid JSON");
  }
  const result = portableRankingArtifactSchema.safeParse(input);
  if (!result.success) throw new RankingJsonError("Ranking export does not match schema version 1");
  try {
    parseRankingVersion(result.data.version);
  } catch {
    throw new RankingJsonError("Ranking export checksum is invalid");
  }
  return result.data;
}
