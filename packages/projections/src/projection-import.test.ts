import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  parseProjectionCsv,
  previewProjectionImport,
  ProjectionCsvError,
  ProjectionImportMetadataError,
  validateProjectionImportMetadata,
  type ProjectionPlayerResolver,
} from "./projection-import.js";

const metadata = {
  season: 2026,
  week: 7,
  horizon: "week" as const,
  sourceLabel: "Mack weekly model",
  sourceObservedAt: "2026-10-15T14:30:00.000Z",
};

const resolvePlayer: ProjectionPlayerResolver = ({ playerId, playerName }) => {
  const reference = playerId ?? playerName;
  return reference
    ? {
        status: "resolved",
        playerId: `canonical:${reference.toLowerCase()}`,
        ...(playerName === undefined ? {} : { playerName }),
      }
    : { status: "unresolved" };
};

describe("parseProjectionCsv", () => {
  it("normalizes supported aliases and RFC-style quoted fields", () => {
    const parsed = parseProjectionCsv(
      'Player,Projected Points,Floor,Ceil,Confidence\r\n"Smith, John",18.25,12,25,0.84\r\n',
    );

    expect(parsed.headers.map((header) => header.canonical)).toEqual([
      "player_name",
      "mean_points",
      "floor_points",
      "ceiling_points",
      "confidence",
    ]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.values).toEqual({
      player_name: "Smith, John",
      mean_points: "18.25",
      floor_points: "12",
      ceiling_points: "25",
      confidence: "0.84",
    });
  });

  it.each([
    {
      name: "bytes",
      csv: "name,mean\nJosh Allen,20",
      limits: { maxBytes: 10 },
      code: "byte_limit_exceeded",
    },
    {
      name: "rows",
      csv: "name,mean\nOne,1\nTwo,2",
      limits: { maxRows: 1 },
      code: "row_limit_exceeded",
    },
    {
      name: "columns",
      csv: "name,mean,floor\nOne,1,0",
      limits: { maxColumns: 2 },
      code: "column_limit_exceeded",
    },
    {
      name: "field bytes",
      csv: "name,mean\nLong Name,1",
      limits: { maxFieldBytes: 5 },
      code: "field_limit_exceeded",
    },
  ])("enforces the configured $name limit", ({ csv, limits, code }) => {
    expect(() => parseProjectionCsv(csv, { limits })).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("caps limit overrides at non-bypassable hard limits", () => {
    expect(() => parseProjectionCsv("name,mean\nOne,1", { limits: { maxRows: Infinity } })).toThrow(
      "maxRows must be a positive integer",
    );
  });

  it.each([
    ['name,mean\n"unfinished,12', "invalid_csv"],
    ['name,mean\nA"lice,12', "invalid_csv"],
    ["name,name,mean\nOne,One,1", "duplicate_column"],
    ["player_name,floor\nOne,1", "missing_required_column"],
    ["mean_points\n1", "missing_required_column"],
    ["", "missing_header"],
  ])("rejects malformed or incomplete schemas", (csv, code) => {
    expect(() => parseProjectionCsv(csv)).toThrowError(expect.objectContaining({ code }));
  });

  it("exposes stable typed parse errors", () => {
    try {
      parseProjectionCsv('name,mean\n"unfinished,12');
      throw new Error("Expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionCsvError);
      expect(error).toMatchObject({
        code: "invalid_csv",
        rowNumber: 2,
        columnNumber: 1,
      });
    }
  });
});

describe("validateProjectionImportMetadata", () => {
  it("normalizes a valid source label", () => {
    expect(
      validateProjectionImportMetadata({ ...metadata, sourceLabel: "  My   ROS Model  " }),
    ).toEqual({ ...metadata, sourceLabel: "My ROS Model" });
  });

  it("strictly validates and canonicalizes the source as-of timestamp", () => {
    expect(
      validateProjectionImportMetadata({
        ...metadata,
        sourceObservedAt: "2026-10-15T14:30:00.25Z",
      }).sourceObservedAt,
    ).toBe("2026-10-15T14:30:00.250Z");
  });

  it.each([
    [{ ...metadata, season: 1999 }, "invalid_season"],
    [{ ...metadata, week: 0 }, "invalid_week"],
    [{ ...metadata, week: 19 }, "invalid_week"],
    [{ ...metadata, horizon: "monthly" }, "invalid_horizon"],
    [{ ...metadata, sourceLabel: "x" }, "invalid_source_label"],
    [{ ...metadata, sourceLabel: "Bad\nLabel" }, "invalid_source_label"],
    [{ ...metadata, sourceObservedAt: "2026-02-29T12:00:00.000Z" }, "invalid_source_observed_at"],
    [{ ...metadata, sourceObservedAt: "2026-10-15 14:30:00Z" }, "invalid_source_observed_at"],
    [{ ...metadata, sourceObservedAt: "2026-10-15T14:30:00-05:00" }, "invalid_source_observed_at"],
  ])("rejects invalid metadata", (candidate, code) => {
    expect(() =>
      validateProjectionImportMetadata(
        candidate as Parameters<typeof validateProjectionImportMetadata>[0],
      ),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("exposes a stable metadata error type", () => {
    expect(() => validateProjectionImportMetadata({ ...metadata, week: 99 })).toThrow(
      ProjectionImportMetadataError,
    );
  });
});

describe("previewProjectionImport", () => {
  it("returns a portable all-or-nothing commit payload", async () => {
    const preview = await previewProjectionImport({
      csv: [
        "player_id,mean_points,floor_points,ceiling_points,confidence,notes",
        "nfl-1,19.4,12.1,27,0.91,manual adjustment",
        "nfl-2,11,,,0.6,",
      ].join("\n"),
      metadata,
      resolvePlayer,
    });

    expect(preview).toMatchObject({
      rowCount: 2,
      resolvedRowCount: 2,
      canCommit: true,
      diagnostics: [{ severity: "warning", code: "unknown_column", rowNumber: 1 }],
    });
    expect(preview.sourceChecksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(preview.normalized).toMatchObject({
      metadata,
      sourceChecksum: preview.sourceChecksum,
      playerProjections: [
        {
          rowNumber: 2,
          playerId: "canonical:nfl-1",
          meanPoints: 19.4,
          floorPoints: 12.1,
          ceilingPoints: 27,
          confidence: 0.91,
        },
        { rowNumber: 3, playerId: "canonical:nfl-2", meanPoints: 11, confidence: 0.6 },
      ],
    });
    expect(preview.normalized?.checksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.parse(JSON.stringify(preview.normalized))).toEqual(preview.normalized);
  });

  it("never accepts unresolved or ambiguous identities", async () => {
    const preview = await previewProjectionImport({
      csv: "player_name,mean_points\nUnknown Player,10\nChris Williams,12",
      metadata,
      resolvePlayer: ({ playerName }) =>
        playerName === "Unknown Player"
          ? { status: "unresolved" }
          : {
              status: "ambiguous",
              candidates: [
                { playerId: "p2", playerName: "Chris Williams (WR)" },
                { playerId: "p1", playerName: "Chris Williams (RB)" },
              ],
            },
    });

    expect(preview.canCommit).toBe(false);
    expect(preview.normalized).toBeNull();
    expect(preview.resolvedRowCount).toBe(0);
    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "player_unresolved",
      "player_ambiguous",
    ]);
    expect(preview.diagnostics[1]?.candidates?.map((candidate) => candidate.playerId)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("rejects duplicate raw references and duplicate canonical resolutions", async () => {
    const rawDuplicate = await previewProjectionImport({
      csv: "player_name,mean_points\nJosh Allen,20\n JOSH  ALLEN ,21",
      metadata,
      resolvePlayer,
    });
    expect(rawDuplicate.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_player_reference", rowNumber: 3 }),
      ]),
    );
    expect(rawDuplicate.canCommit).toBe(false);

    const canonicalDuplicate = await previewProjectionImport({
      csv: "player_id,mean_points\nyahoo-1,20\nespn-99,21",
      metadata,
      resolvePlayer: () => ({ status: "resolved", playerId: "same-player" }),
    });
    expect(canonicalDuplicate.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_resolved_player", rowNumber: 3 }),
      ]),
    );
    expect(canonicalDuplicate.normalized).toBeNull();
  });

  it("reports every numeric invariant with deterministic row diagnostics", async () => {
    const csv = [
      "player_id,mean_points,floor_points,ceiling_points,confidence",
      "p1,NaN,0,10,.5",
      "p2,301,0,301,.5",
      "p3,10,11,20,.5",
      "p4,10,0,9,.5",
      "p5,10,0,20,1.01",
      "p6,1e309,0,20,.5",
    ].join("\n");
    const first = await previewProjectionImport({ csv, metadata, resolvePlayer });
    const second = await previewProjectionImport({
      csv: csv.replaceAll("\n", "\r\n"),
      metadata,
      resolvePlayer,
    });

    expect(first.canCommit).toBe(false);
    expect(first.normalized).toBeNull();
    expect(first.diagnostics.map(({ rowNumber, code }) => [rowNumber, code])).toEqual([
      [2, "invalid_number"],
      [3, "points_out_of_bounds"],
      [3, "points_out_of_bounds"],
      [4, "incoherent_range"],
      [5, "incoherent_range"],
      [6, "confidence_out_of_bounds"],
      [7, "invalid_number"],
    ]);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(second.sourceChecksum).toBe(first.sourceChecksum);
  });

  it("rejects missing identities, malformed resolutions, resolver failures, and uneven rows", async () => {
    const resolver = vi
      .fn<ProjectionPlayerResolver>()
      .mockRejectedValueOnce(new Error("catalog offline"))
      .mockReturnValueOnce({ status: "resolved", playerId: "\n" });
    const preview = await previewProjectionImport({
      csv: "player_name,mean_points,confidence\n,10,0.5\nOne,12,0.5\nTwo,13,0.5\nThree,14",
      metadata,
      resolvePlayer: resolver,
    });

    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "missing_player_reference",
      "player_resolver_failed",
      "invalid_player_resolution",
      "column_count_mismatch",
    ]);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(preview.normalized).toBeNull();
  });

  it("rejects an empty data set", async () => {
    const preview = await previewProjectionImport({
      csv: "player_id,mean_points\n",
      metadata,
      resolvePlayer,
    });
    expect(preview).toMatchObject({ rowCount: 0, canCommit: false, normalized: null });
  });

  it("is deterministic for bounded arbitrary valid projection sets", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 100_000 }), {
          minLength: 1,
          maxLength: 40,
        }),
        async (ids) => {
          const csv = [
            "player_id,mean_points,floor_points,ceiling_points,confidence",
            ...ids.map((id) => {
              const mean = (id % 2_000) / 10;
              const floor = mean - 1;
              const ceiling = mean + 2;
              return `player-${id},${mean},${floor},${ceiling},0.75`;
            }),
          ].join("\n");
          const first = await previewProjectionImport({ csv, metadata, resolvePlayer });
          const second = await previewProjectionImport({ csv, metadata, resolvePlayer });

          expect(first.canCommit).toBe(true);
          expect(first.normalized?.playerProjections).toHaveLength(ids.length);
          expect(second.sourceChecksum).toBe(first.sourceChecksum);
          expect(second.normalized?.checksum).toBe(first.normalized?.checksum);
          expect(second.diagnostics).toEqual(first.diagnostics);
        },
      ),
      { numRuns: 75 },
    );
  });

  it("binds source as-of provenance into both confirmation checksums", async () => {
    const csv = "player_id,mean_points\nplayer-1,18";
    const first = await previewProjectionImport({ csv, metadata, resolvePlayer });
    const second = await previewProjectionImport({
      csv,
      metadata: { ...metadata, sourceObservedAt: "2026-10-15T14:31:00.000Z" },
      resolvePlayer,
    });

    expect(first.sourceChecksum).not.toBe(second.sourceChecksum);
    expect(first.normalized?.checksum).not.toBe(second.normalized?.checksum);
    expect(first.normalized?.metadata.sourceObservedAt).toBe(metadata.sourceObservedAt);
  });
});
