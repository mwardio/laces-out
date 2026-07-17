import { describe, expect, it } from "vitest";

import {
  RANKING_SCHEMA_VERSION,
  applyLeagueOverlay,
  bulkSetTier,
  canonicalJson,
  checksumRankingEntries,
  cloneRanking,
  createDerivedAttribution,
  createLeagueOverlay,
  createRankingList,
  createRankingVersion,
  createUserAttribution,
  diffRankingVersions,
  emptyRankingEntry,
  mergeRankingEntries,
  normalizeRanks,
  parseRankingVersion,
  rankingEntrySchema,
  rankingListSchema,
  reorderRankingEntries,
  reorderRankingEntry,
  sourcedValue,
  updateRankingList,
  verifyLeagueOverlayChecksum,
  verifyRankingVersionChecksum,
  type RankingEntry,
  type RankingProvenance,
  type RankingVersion,
} from "./index.js";

const TIME = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-17T12:00:00.000Z";
const USER = createUserAttribution("user-1", TIME);
const DERIVED = createDerivedAttribution("consensus-2026", TIME, "a".repeat(64));

function entry(
  playerId: string,
  position: "QB" | "RB" | "WR" | "TE" | null,
  fields: Partial<Omit<RankingEntry, "playerId" | "position">> = {},
): RankingEntry {
  return rankingEntrySchema.parse({ ...emptyRankingEntry(playerId, position), ...fields });
}

const provenance: RankingProvenance = {
  operation: "create",
  sources: [
    {
      kind: "manual",
      sourceId: "user-board",
      versionId: null,
      checksumSha256: null,
      observedAt: TIME,
      label: "My board",
    },
  ],
  note: null,
};

function version(
  id: string,
  versionNumber: number,
  entries: readonly RankingEntry[],
  overrides: Partial<{
    parentVersionId: string | null;
    provenance: RankingProvenance;
  }> = {},
): RankingVersion {
  return createRankingVersion({
    schemaVersion: RANKING_SCHEMA_VERSION,
    id,
    listId: "list-1",
    versionNumber,
    parentVersionId: overrides.parentVersionId ?? null,
    state: "draft",
    authorUserId: "user-1",
    createdAt: versionNumber === 1 ? TIME : LATER,
    publishedAt: null,
    changeNote: null,
    entries,
    provenance: overrides.provenance ?? provenance,
  });
}

describe("ranking list metadata", () => {
  it("defaults to private and only exposes safe metadata edits", () => {
    const list = createRankingList({
      id: "list-1",
      ownerUserId: "user-1",
      name: "Home league cheat sheet",
      season: 2026,
      kind: "cheat-sheet",
      scoringContext: {
        format: "PPR",
        leagueId: "league-1",
        settingsChecksumSha256: "b".repeat(64),
        label: "Home PPR",
      },
      createdAt: TIME,
    });

    expect(list.visibility).toEqual({ scope: "private" });
    expect(Object.isFrozen(list)).toBe(true);
    const shared = updateRankingList(list, {
      visibility: { scope: "league", leagueIds: ["league-1"], allowClone: true },
      updatedAt: LATER,
    });
    expect(shared.visibility.scope).toBe("league");
    expect(shared.ownerUserId).toBe("user-1");
    expect(list.visibility.scope).toBe("private");
  });

  it("rejects unsafe or inconsistent visibility and timestamps", () => {
    const base = {
      schemaVersion: RANKING_SCHEMA_VERSION,
      id: "list-1",
      ownerUserId: "user-1",
      name: "Board",
      description: null,
      season: 2026,
      kind: "rankings",
      scoringContext: {
        format: "PPR",
        leagueId: null,
        settingsChecksumSha256: null,
        label: null,
      },
      currentVersionId: null,
      latestPublishedVersionId: null,
      createdAt: LATER,
      updatedAt: TIME,
      archivedAt: null,
    } as const;

    expect(() =>
      rankingListSchema.parse({
        ...base,
        visibility: {
          scope: "league",
          leagueIds: ["league-1", "league-1"],
          allowClone: false,
        },
      }),
    ).toThrow();
    expect(() => rankingListSchema.parse({ ...base, visibility: { scope: "private" } })).toThrow(
      "updatedAt",
    );
  });
});

describe("entry and immutable version boundaries", () => {
  it("validates value ranges and contradictory authored fields", () => {
    expect(() =>
      entry("p1", "RB", {
        floorPrice: sourcedValue(50, USER),
        targetPrice: sourcedValue(40, USER),
      }),
    ).toThrow("floorPrice");
    expect(() =>
      entry("p1", "RB", {
        target: sourcedValue(true, USER),
        avoid: sourcedValue(true, DERIVED),
      }),
    ).toThrow("both a target and an avoid");
    expect(() => entry("p1", null, { positionRank: sourcedValue(1, USER) })).toThrow(
      "requires a position",
    );
  });

  it("creates checksummed, recursively frozen snapshots and detects tampering", () => {
    const original = version("v1", 1, [
      entry("p1", "RB", {
        overallRank: sourcedValue(1, USER),
        tags: sourcedValue(["upside"], USER),
      }),
    ]);

    expect(verifyRankingVersionChecksum(original)).toBe(true);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.entries)).toBe(true);
    expect(Object.isFrozen(original.entries[0])).toBe(true);
    expect(Object.isFrozen(original.entries[0]?.tags?.value)).toBe(true);
    const tampered = { ...original, changeNote: "silent rewrite" };
    expect(verifyRankingVersionChecksum(tampered)).toBe(false);
    expect(() => parseRankingVersion(tampered)).toThrow("checksum");
  });
});

describe("stable rank editing", () => {
  it("normalizes ties stably, fills gaps, and derives position order", () => {
    const source = [
      entry("late", "WR", { overallRank: sourcedValue(9, DERIVED) }),
      entry("tie-a", "RB", { overallRank: sourcedValue(2, DERIVED) }),
      entry("tie-b", "WR", { overallRank: sourcedValue(2, DERIVED) }),
      entry("unranked", "RB"),
    ];
    const normalized = normalizeRanks(source, { authorUserId: "user-1", authoredAt: LATER });

    expect(normalized.map((item) => item.playerId)).toEqual(["tie-a", "tie-b", "late", "unranked"]);
    expect(normalized.map((item) => item.overallRank?.value)).toEqual([1, 2, 3, 4]);
    expect(normalized.map((item) => item.positionRank?.value)).toEqual([1, 1, 2, 2]);
    expect(normalized.every((item) => item.overallRank?.kind === "user")).toBe(true);
    expect(source[0]?.overallRank?.value).toBe(9);
  });

  it("reorders deterministically and rejects incomplete bulk permutations", () => {
    const source = normalizeRanks(
      [entry("p1", "RB"), entry("p2", "RB"), entry("p3", "WR")],
      { authorUserId: "user-1", authoredAt: TIME },
      { orderBy: "input" },
    );
    const moved = reorderRankingEntry(source, "p3", 0, {
      authorUserId: "user-1",
      authoredAt: LATER,
    });
    expect(moved.map((item) => item.playerId)).toEqual(["p3", "p1", "p2"]);
    expect(moved.map((item) => item.overallRank?.value)).toEqual([1, 2, 3]);

    const reordered = reorderRankingEntries(source, ["p2", "p3", "p1"], {
      authorUserId: "user-1",
      authoredAt: LATER,
    });
    expect(reordered.map((item) => item.playerId)).toEqual(["p2", "p3", "p1"]);
    expect(() =>
      reorderRankingEntries(source, ["p1", "p2"], {
        authorUserId: "user-1",
        authoredAt: LATER,
      }),
    ).toThrow("complete");
  });

  it("applies a tier to an exact, validated selection without mutating other entries", () => {
    const p1 = entry("p1", "RB", { tier: sourcedValue(4, DERIVED) });
    const p2 = entry("p2", "WR");
    const result = bulkSetTier([p1, p2], ["p1"], 2, {
      authorUserId: "user-1",
      authoredAt: LATER,
    });
    expect(result[0]?.tier).toMatchObject({ value: 2, kind: "user" });
    expect(result[1]).toEqual(p2);
    expect(p1.tier?.value).toBe(4);
    expect(() =>
      bulkSetTier([p1, p2], ["missing"], 2, {
        authorUserId: "user-1",
        authoredAt: LATER,
      }),
    ).toThrow("Unknown");
  });
});

describe("merge, clone, and league overlays", () => {
  it("merges new derived data while preserving every existing user value", () => {
    const base = entry("p1", "RB", {
      overallRank: sourcedValue(3, USER),
      tier: sourcedValue(2, DERIVED),
      notes: sourcedValue("Do not erase this", USER),
      floorPrice: sourcedValue(10, DERIVED),
      targetPrice: sourcedValue(20, DERIVED),
      ceilingPrice: sourcedValue(30, DERIVED),
    });
    const incoming = entry("p1", "RB", {
      overallRank: sourcedValue(1, DERIVED),
      tier: sourcedValue(1, DERIVED),
      aav: sourcedValue(48, DERIVED),
      notes: sourcedValue("generic note", DERIVED),
      floorPrice: sourcedValue(30, DERIVED),
      targetPrice: sourcedValue(40, DERIVED),
      ceilingPrice: sourcedValue(50, DERIVED),
    });
    const added = entry("p2", "WR", { overallRank: sourcedValue(2, DERIVED) });
    const merged = mergeRankingEntries([base], [incoming, added]);

    expect(merged.entries[0]?.overallRank?.value).toBe(3);
    expect(merged.entries[0]?.notes?.value).toBe("Do not erase this");
    expect(merged.entries[0]?.tier?.value).toBe(1);
    expect(merged.entries[0]?.aav?.value).toBe(48);
    expect(merged.entries[0]?.floorPrice?.value).toBe(30);
    expect(merged.entries[0]?.targetPrice?.value).toBe(40);
    expect(merged.entries[0]?.ceilingPrice?.value).toBe(50);
    expect(merged.addedPlayerIds).toEqual(["p2"]);
    expect(merged.preservedUserFields).toEqual([
      { playerId: "p1", field: "overallRank" },
      { playerId: "p1", field: "notes" },
    ]);
  });

  it("applies verified league context without overwriting authored fields or adding strangers", () => {
    const base = entry("p1", "RB", {
      overallRank: sourcedValue(5, USER),
      tier: sourcedValue(3, DERIVED),
    });
    const overlay = createLeagueOverlay({
      schemaVersion: RANKING_SCHEMA_VERSION,
      id: "overlay-1",
      leagueId: "league-1",
      baseVersionId: "v1",
      generatedAt: LATER,
      entries: [
        {
          playerId: "p1",
          overallRank: sourcedValue(1, DERIVED),
          tier: sourcedValue(1, DERIVED),
        },
        { playerId: "unknown", overallRank: sourcedValue(2, DERIVED) },
      ],
      provenance: {
        operation: "overlay",
        sources: [
          {
            kind: "league-overlay",
            sourceId: "league-1",
            versionId: "v1",
            checksumSha256: "c".repeat(64),
            observedAt: LATER,
            label: "League scoring",
          },
        ],
        note: null,
      },
    });
    expect(verifyLeagueOverlayChecksum(overlay)).toBe(true);
    const applied = applyLeagueOverlay([base], overlay, "v1");
    expect(applied.entries[0]?.overallRank?.value).toBe(5);
    expect(applied.entries[0]?.tier?.value).toBe(1);
    expect(applied.preservedUserFields).toEqual([{ playerId: "p1", field: "overallRank" }]);
    expect(applied.unknownPlayerIds).toEqual(["unknown"]);
  });

  it("clones to independent IDs with traceable provenance", () => {
    const sourceList = createRankingList({
      id: "list-1",
      ownerUserId: "user-1",
      name: "Source board",
      season: 2026,
      kind: "rankings",
      scoringContext: {
        format: "PPR",
        leagueId: null,
        settingsChecksumSha256: null,
        label: null,
      },
      createdAt: TIME,
    });
    const sourceVersion = version("v1", 1, [
      entry("p1", "RB", { notes: sourcedValue("mine", USER) }),
    ]);
    const cloned = cloneRanking(sourceList, sourceVersion, {
      listId: "list-2",
      versionId: "clone-v1",
      ownerUserId: "friend-1",
      authorUserId: "friend-1",
      name: "Friend's board",
      createdAt: LATER,
    });

    expect(cloned.list.id).toBe("list-2");
    expect(cloned.list.visibility).toEqual({ scope: "private" });
    expect(cloned.version.listId).toBe("list-2");
    expect(cloned.version.provenance.sources[0]).toMatchObject({
      kind: "clone",
      versionId: "v1",
      checksumSha256: sourceVersion.checksumSha256,
    });
    expect(cloned.version.entries).not.toBe(sourceVersion.entries);
  });
});

describe("checksums and version diffs", () => {
  it("is stable across object key order and reports fields, moves, additions, and provenance", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    const p1 = entry("p1", "RB", {
      overallRank: sourcedValue(1, USER),
      tier: sourcedValue(1, USER),
    });
    const p2 = entry("p2", "WR", { overallRank: sourcedValue(2, USER) });
    const first = version("v1", 1, [p1, p2]);
    const updatedP1 = rankingEntrySchema.parse({ ...p1, tier: sourcedValue(2, USER) });
    const second = version("v2", 2, [p2, updatedP1, entry("p3", "QB")], {
      parentVersionId: "v1",
      provenance: { ...provenance, operation: "edit", note: "Moved and tiered" },
    });
    const diff = diffRankingVersions(first, second);

    expect(checksumRankingEntries(first.entries)).toMatch(/^[a-f0-9]{64}$/u);
    expect(diff.addedPlayerIds).toEqual(["p3"]);
    expect(diff.removedPlayerIds).toEqual([]);
    expect(diff.moves.map((move) => move.playerId)).toEqual(["p1", "p2"]);
    expect(diff.fieldChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ playerId: "p1", field: "tier" })]),
    );
    expect(diff.provenanceChanged).toBe(true);
  });
});
