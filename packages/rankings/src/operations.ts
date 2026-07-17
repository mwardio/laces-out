import { z } from "zod";

import {
  RANKING_FIELD_NAMES,
  fieldAttributionSchema,
  leagueOverlaySchema,
  rankingEntrySchema,
  sourcedValue,
  type FieldAttribution,
  type LeagueOverlay,
  type RankingEntry,
  type RankingEntryField,
  type RankingFieldName,
} from "./model.js";
import { canonicalJson, verifyLeagueOverlayChecksum } from "./integrity.js";

const rankingEntriesSchema = z
  .array(rankingEntrySchema)
  .max(10_000)
  .superRefine((entries, context) => {
    const playerIds = entries.map((entry) => entry.playerId);
    if (new Set(playerIds).size !== playerIds.length) {
      context.addIssue({ code: "custom", message: "entries must have unique playerIds" });
    }
  })
  .readonly();

export interface RankEditContext {
  readonly authorUserId: string;
  readonly authoredAt: string;
}

const rankEditContextSchema = z
  .object({
    authorUserId: z.string().trim().min(1).max(160),
    authoredAt: z.string().datetime({ offset: true }),
  })
  .strict();

function userAttribution(context: RankEditContext): FieldAttribution {
  const parsed = rankEditContextSchema.parse(context);
  return fieldAttributionSchema.parse({
    kind: "user",
    authorUserId: parsed.authorUserId,
    authoredAt: parsed.authoredAt,
  });
}

function replaceField(
  entry: RankingEntry,
  field: RankingFieldName,
  value: RankingEntryField,
): RankingEntry {
  return rankingEntrySchema.parse({ ...entry, [field]: value });
}

function stableOrderByRank(entries: readonly RankingEntry[]): readonly RankingEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftRank = left.entry.overallRank?.value ?? Number.POSITIVE_INFINITY;
      const rightRank = right.entry.overallRank?.value ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export interface NormalizeRankOptions {
  /** `existing-rank` sorts by current rank with stable tie handling; `input` trusts caller order. */
  readonly orderBy?: "existing-rank" | "input";
  readonly positionRanks?: boolean;
}

/**
 * Produce gap-free 1-based ranks without mutating the source. Ties retain source order,
 * and unranked entries remain in source order after ranked entries.
 */
export function normalizeRanks(
  input: readonly RankingEntry[],
  context: RankEditContext,
  options: NormalizeRankOptions = {},
): readonly RankingEntry[] {
  const entries = rankingEntriesSchema.parse(input);
  const attribution = userAttribution(context);
  const ordered = options.orderBy === "input" ? entries : stableOrderByRank(entries);
  const positionCounters = new Map<string, number>();

  return Object.freeze(
    ordered.map((entry, index) => {
      let next = replaceField(entry, "overallRank", sourcedValue(index + 1, attribution));
      if (options.positionRanks !== false) {
        if (entry.position === null) {
          next = replaceField(next, "positionRank", null);
        } else {
          const rank = (positionCounters.get(entry.position) ?? 0) + 1;
          positionCounters.set(entry.position, rank);
          next = replaceField(next, "positionRank", sourcedValue(rank, attribution));
        }
      }
      return next;
    }),
  );
}

export function reorderRankingEntry(
  input: readonly RankingEntry[],
  playerId: string,
  targetIndex: number,
  context: RankEditContext,
): readonly RankingEntry[] {
  const entries = stableOrderByRank(rankingEntriesSchema.parse(input));
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= entries.length) {
    throw new RangeError("targetIndex must identify an entry");
  }
  const sourceIndex = entries.findIndex((entry) => entry.playerId === playerId);
  if (sourceIndex === -1) throw new RangeError(`Unknown playerId: ${playerId}`);
  const reordered = [...entries];
  const [moved] = reordered.splice(sourceIndex, 1);
  if (!moved) throw new RangeError(`Unknown playerId: ${playerId}`);
  reordered.splice(targetIndex, 0, moved);
  return normalizeRanks(reordered, context, { orderBy: "input" });
}

/** Apply a complete permutation. Partial or duplicate IDs are rejected to prevent accidental loss. */
export function reorderRankingEntries(
  input: readonly RankingEntry[],
  orderedPlayerIds: readonly string[],
  context: RankEditContext,
): readonly RankingEntry[] {
  const entries = rankingEntriesSchema.parse(input);
  if (
    orderedPlayerIds.length !== entries.length ||
    new Set(orderedPlayerIds).size !== orderedPlayerIds.length
  ) {
    throw new RangeError("orderedPlayerIds must be a complete, duplicate-free permutation");
  }
  const byPlayer = new Map(entries.map((entry) => [entry.playerId, entry]));
  const ordered = orderedPlayerIds.map((playerId) => {
    const entry = byPlayer.get(playerId);
    if (!entry) throw new RangeError(`Unknown playerId: ${playerId}`);
    return entry;
  });
  return normalizeRanks(ordered, context, { orderBy: "input" });
}

export function bulkSetTier(
  input: readonly RankingEntry[],
  playerIds: readonly string[],
  tier: number | null,
  context: RankEditContext,
): readonly RankingEntry[] {
  const entries = rankingEntriesSchema.parse(input);
  if (new Set(playerIds).size !== playerIds.length) {
    throw new RangeError("playerIds cannot contain duplicates");
  }
  if (tier !== null && (!Number.isInteger(tier) || tier < 1 || tier > 10_000)) {
    throw new RangeError("tier must be a positive integer or null");
  }
  const knownIds = new Set(entries.map((entry) => entry.playerId));
  const unknown = playerIds.filter((playerId) => !knownIds.has(playerId));
  if (unknown.length > 0) throw new RangeError(`Unknown playerIds: ${unknown.join(", ")}`);
  const selected = new Set(playerIds);
  const value = tier === null ? null : sourcedValue(tier, userAttribution(context));
  return Object.freeze(
    entries.map((entry) =>
      selected.has(entry.playerId) ? replaceField(entry, "tier", value) : entry,
    ),
  );
}

export interface PreservedUserField {
  readonly playerId: string;
  readonly field: RankingFieldName;
}

export interface RankingMergeResult {
  readonly entries: readonly RankingEntry[];
  readonly preservedUserFields: readonly PreservedUserField[];
  readonly addedPlayerIds: readonly string[];
}

function valuesDiffer(left: unknown, right: unknown): boolean {
  return canonicalJson(left) !== canonicalJson(right);
}

/**
 * Merge non-null incoming fields. A value already authored by a user is never replaced,
 * including by another user value; null incoming fields never erase existing data.
 */
export function mergeRankingEntries(
  baseInput: readonly RankingEntry[],
  incomingInput: readonly RankingEntry[],
): RankingMergeResult {
  const base = rankingEntriesSchema.parse(baseInput);
  const incoming = rankingEntriesSchema.parse(incomingInput);
  const incomingByPlayer = new Map(incoming.map((entry) => [entry.playerId, entry]));
  const preservedUserFields: PreservedUserField[] = [];
  const merged = base.map((entry) => {
    const candidate = incomingByPlayer.get(entry.playerId);
    if (!candidate) return entry;
    const changes: Partial<Record<RankingFieldName, RankingEntryField>> = {};
    for (const field of RANKING_FIELD_NAMES) {
      const currentValue = entry[field];
      const candidateValue = candidate[field];
      if (candidateValue === null) continue;
      if (currentValue?.kind === "user") {
        if (valuesDiffer(currentValue, candidateValue)) {
          preservedUserFields.push(Object.freeze({ playerId: entry.playerId, field }));
        }
        continue;
      }
      changes[field] = candidateValue;
    }
    // Validate the complete patch atomically: coordinated floor/target/ceiling or
    // target/avoid changes must not fail because of an invalid intermediate state.
    return rankingEntrySchema.parse({
      ...entry,
      ...(entry.position === null && candidate.position !== null
        ? { position: candidate.position }
        : {}),
      ...changes,
    });
  });

  const baseIds = new Set(base.map((entry) => entry.playerId));
  const additions = incoming.filter((entry) => !baseIds.has(entry.playerId));
  return Object.freeze({
    entries: Object.freeze([
      ...merged,
      ...additions.map((entry) => rankingEntrySchema.parse(entry)),
    ]),
    preservedUserFields: Object.freeze(preservedUserFields),
    addedPlayerIds: Object.freeze(additions.map((entry) => entry.playerId)),
  });
}

export interface AppliedLeagueOverlay {
  readonly entries: readonly RankingEntry[];
  readonly preservedUserFields: readonly PreservedUserField[];
  readonly unknownPlayerIds: readonly string[];
}

/** Apply a league-derived overlay only to known players, preserving every user-authored base field. */
export function applyLeagueOverlay(
  baseInput: readonly RankingEntry[],
  overlayInput: LeagueOverlay,
  expectedBaseVersionId?: string,
): AppliedLeagueOverlay {
  const base = rankingEntriesSchema.parse(baseInput);
  const overlay = leagueOverlaySchema.parse(overlayInput);
  if (!verifyLeagueOverlayChecksum(overlay)) throw new Error("League overlay checksum is invalid");
  if (expectedBaseVersionId !== undefined && overlay.baseVersionId !== expectedBaseVersionId) {
    throw new RangeError("League overlay does not target the expected base version");
  }
  const baseByPlayer = new Map(base.map((entry) => [entry.playerId, entry]));
  const unknownPlayerIds = overlay.entries
    .filter((entry) => !baseByPlayer.has(entry.playerId))
    .map((entry) => entry.playerId);
  const overlayByPlayer = new Map(overlay.entries.map((entry) => [entry.playerId, entry]));
  const preservedUserFields: PreservedUserField[] = [];
  const entries = base.map((entry) => {
    const overlayEntry = overlayByPlayer.get(entry.playerId);
    if (!overlayEntry) return entry;
    const changes: Partial<Record<RankingFieldName, RankingEntryField>> = {};
    for (const field of RANKING_FIELD_NAMES) {
      const overlayValue = overlayEntry[field];
      if (overlayValue === undefined) continue;
      const currentValue = entry[field];
      if (currentValue?.kind === "user") {
        if (valuesDiffer(currentValue, overlayValue)) {
          preservedUserFields.push(Object.freeze({ playerId: entry.playerId, field }));
        }
        continue;
      }
      changes[field] = overlayValue;
    }
    return rankingEntrySchema.parse({
      ...entry,
      ...(entry.position === null && overlayEntry.position !== undefined
        ? { position: overlayEntry.position }
        : {}),
      ...changes,
    });
  });

  return Object.freeze({
    entries: Object.freeze(entries),
    preservedUserFields: Object.freeze(preservedUserFields),
    unknownPlayerIds: Object.freeze(unknownPlayerIds),
  });
}
