import { describe, expect, it } from "vitest";

import {
  RankingCsvCommitError,
  RankingCsvError,
  RankingJsonError,
  commitRankingCsvPreview,
  createDerivedAttribution,
  createRankingList,
  createRankingVersion,
  createUserAttribution,
  emptyRankingEntry,
  exportRankingEntriesCsv,
  exportRankingJson,
  parseCanonicalRankingCsv,
  parseRankingJson,
  previewRankingCsv,
  rankingEntrySchema,
  sourcedValue,
  type RankingEntry,
} from "./index.js";

const TIME = "2026-07-16T12:00:00.000Z";
const USER = createUserAttribution("user-1", TIME);
const DERIVED = createDerivedAttribution("market", TIME, "d".repeat(64));

function entry(
  playerId: string,
  position: "QB" | "RB" | "WR" | null,
  fields: Partial<Omit<RankingEntry, "playerId" | "position">> = {},
): RankingEntry {
  return rankingEntrySchema.parse({ ...emptyRankingEntry(playerId, position), ...fields });
}

describe("configurable CSV preview and commit", () => {
  it("maps headers, parses common formats, and commits only against the exact preview", () => {
    const csv = [
      "Player ID,Pos,Rank,Tier,AAV,Confidence,Target,Avoid,Tags,Notes",
      'p1,RB,2,1,$42,82%,yes,no,upside|keeper,"comma, quote ""and"" newline\nworks"',
      "p2,WR,1,1,$38,0.9,no,no,safe,steady",
    ].join("\n");
    const preview = previewRankingCsv(csv, {
      mapping: {
        playerId: "Player ID",
        position: "Pos",
        overallRank: "Rank",
        tier: "Tier",
        aav: "AAV",
        confidence: "Confidence",
        target: "Target",
        avoid: "Avoid",
        tags: "Tags",
        notes: "Notes",
      },
      attribution: USER,
    });

    expect(preview.summary).toEqual({
      total: 2,
      ready: 2,
      invalid: 0,
      unresolved: 0,
      duplicate: 0,
    });
    expect(preview.canCommitAll).toBe(true);
    expect(preview.rows[0]?.entry).toMatchObject({
      playerId: "p1",
      position: "RB",
      overallRank: { value: 2, kind: "user" },
      aav: { value: 42 },
      confidence: { value: 0.82 },
      target: { value: true },
      avoid: { value: false },
      tags: { value: ["upside", "keeper"] },
      notes: { value: 'comma, quote "and" newline\nworks' },
    });
    expect(() =>
      commitRankingCsvPreview(preview, {
        mode: "all-valid",
        previewChecksumSha256: "0".repeat(64),
      }),
    ).toThrow(RankingCsvCommitError);
    const committed = commitRankingCsvPreview(preview, {
      mode: "all-valid",
      previewChecksumSha256: preview.previewChecksumSha256,
    });
    expect(committed.entries.map((item) => item.playerId)).toEqual(["p1", "p2"]);
    expect(committed.skippedRowNumbers).toEqual([]);
  });

  it("surfaces malformed, duplicate, and unresolved rows without silently dropping any", () => {
    const csv = [
      "Name,Pos,Rank",
      "Alpha,RB,1",
      "Alpha,RB,2",
      "Beta,WR,not-a-number",
      "Mystery,QB,4",
    ].join("\n");
    const preview = previewRankingCsv(csv, {
      mapping: { playerName: "Name", position: "Pos", overallRank: "Rank" },
      attribution: USER,
      resolvePlayer(identity) {
        if (identity.playerName === "Alpha") {
          return { status: "resolved", playerId: "p1", position: "RB" };
        }
        if (identity.playerName === "Beta") {
          return { status: "resolved", playerId: "p2", position: "WR" };
        }
        return {
          status: "unresolved",
          reason: "No confident identity match",
          candidatePlayerIds: ["maybe-p3"],
        };
      },
    });

    expect(preview.summary).toEqual({
      total: 4,
      ready: 0,
      invalid: 1,
      unresolved: 1,
      duplicate: 2,
    });
    expect(preview.rows.map((row) => row.status)).toEqual([
      "duplicate",
      "duplicate",
      "invalid",
      "unresolved",
    ]);
    expect(() =>
      commitRankingCsvPreview(preview, {
        mode: "all-valid",
        previewChecksumSha256: preview.previewChecksumSha256,
      }),
    ).toThrow("every row");
    expect(() =>
      commitRankingCsvPreview(preview, {
        mode: "selected-rows",
        previewChecksumSha256: preview.previewChecksumSha256,
        rowNumbers: [2, 3],
      }),
    ).toThrow("one row");

    const explicit = commitRankingCsvPreview(preview, {
      mode: "selected-rows",
      previewChecksumSha256: preview.previewChecksumSha256,
      rowNumbers: [3],
    });
    expect(explicit.acceptedRowNumbers).toEqual([3]);
    expect(explicit.skippedRowNumbers).toEqual([2, 4, 5]);
    expect(explicit.entries[0]?.overallRank?.value).toBe(2);
  });

  it("reports malformed quote syntax and supports numeric mapping without headers", () => {
    const malformed = previewRankingCsv('player_id,notes\np1,"unterminated', {
      mapping: { playerId: "player_id", notes: "notes" },
      attribution: USER,
    });
    expect(malformed.rows[0]?.status).toBe("invalid");
    expect(malformed.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unterminated-quote" })]),
    );

    const positional = previewRankingCsv("p1,RB,3", {
      hasHeader: false,
      mapping: { playerId: 0, position: 1, overallRank: 2 },
      attribution: USER,
    });
    expect(positional.canCommitAll).toBe(true);
    expect(positional.rows[0]?.entry?.overallRank?.value).toBe(3);
  });
});

describe("canonical exports", () => {
  it("round-trips CSV losslessly, including multiline notes, tags, and mixed provenance", () => {
    const entries = [
      entry("p1", "RB", {
        overallRank: sourcedValue(1, USER),
        aav: sourcedValue(52.5, DERIVED),
        tags: sourcedValue(["keeper", "high-upside"], USER),
        notes: sourcedValue('Line one\nLine two, with "quotes"', USER),
        target: sourcedValue(true, USER),
      }),
      entry("p2", null, { notes: sourcedValue("", USER) }),
    ];
    const csv = exportRankingEntriesCsv(entries);
    const restored = parseCanonicalRankingCsv(csv);
    expect(restored).toEqual(entries);
    expect(exportRankingEntriesCsv(restored)).toBe(csv);
  });

  it("guards spreadsheet formulas without changing the canonical round trip", () => {
    const entries = [
      entry("p-formula", "WR", {
        notes: sourcedValue('=HYPERLINK("https://example.invalid","open")', USER),
      }),
      entry("p-apostrophe", "RB", {
        notes: sourcedValue("'+SUM(A1:A2)", USER),
      }),
    ];

    const csv = exportRankingEntriesCsv(entries);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("''+SUM");
    expect(parseCanonicalRankingCsv(csv)).toEqual(entries);
  });

  it("rejects malformed or duplicate canonical rows", () => {
    const one = exportRankingEntriesCsv([entry("p1", "RB")]);
    const duplicate = `${one}${one.split("\n")[1] ?? ""}\n`;
    expect(() => parseCanonicalRankingCsv(duplicate)).toThrow(RankingCsvError);
    try {
      parseCanonicalRankingCsv("player_id,rank\np1,1\n");
    } catch (error) {
      expect(error).toBeInstanceOf(RankingCsvError);
      expect((error as RankingCsvError).issues.map((issue) => issue.message).join(" ")).toContain(
        "header",
      );
    }
  });

  it("round-trips a canonical JSON artifact and refuses a changed checksum", () => {
    const list = createRankingList({
      id: "list-1",
      ownerUserId: "user-1",
      name: "Portable board",
      season: 2026,
      kind: "cheat-sheet",
      scoringContext: {
        format: "HALF_PPR",
        leagueId: "league-1",
        settingsChecksumSha256: "e".repeat(64),
        label: "Friends league",
      },
      createdAt: TIME,
    });
    const version = createRankingVersion({
      schemaVersion: 1,
      id: "v1",
      listId: list.id,
      versionNumber: 1,
      parentVersionId: null,
      state: "published",
      authorUserId: "user-1",
      createdAt: TIME,
      publishedAt: TIME,
      changeNote: "Draft day",
      entries: [entry("p1", "RB", { overallRank: sourcedValue(1, USER) })],
      provenance: { operation: "create", sources: [], note: null },
    });
    const json = exportRankingJson(list, version, TIME, { indentation: 2 });
    const restored = parseRankingJson(json);
    expect(restored.list).toEqual(list);
    expect(restored.version).toEqual(version);

    const tampered = JSON.parse(json) as {
      version: { entries: Array<{ playerId: string }> };
    };
    const firstEntry = tampered.version.entries[0];
    if (firstEntry) firstEntry.playerId = "changed-player";
    expect(() => parseRankingJson(JSON.stringify(tampered))).toThrow(RankingJsonError);
  });
});
