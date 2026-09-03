import { describe, expect, it } from "vitest";

import {
  projectionFreshnessObservedAt,
  projectionTimestampProvenance,
} from "./projection-provenance.js";

const SOURCE_TIME = new Date("2026-09-15T10:00:00.000Z");
const IMPORT_TIME = new Date("2026-09-15T11:00:00.000Z");

describe("projectionTimestampProvenance", () => {
  it("verifies a schema-v2 user CSV timestamp bound to fetchedAt", () => {
    expect(
      projectionTimestampProvenance({
        source: "user-csv",
        fetchedAt: SOURCE_TIME,
        createdAt: IMPORT_TIME,
        metadata: {
          schemaVersion: 2,
          importKind: "user-csv",
          sourceObservedAt: SOURCE_TIME.toISOString(),
        },
      }),
    ).toEqual({
      sourceObservedAt: SOURCE_TIME,
      sourceObservedAtStatus: "verified",
      importedAt: IMPORT_TIME,
    });
  });

  it.each([
    {},
    { schemaVersion: 1, importKind: "user-csv", sourceObservedAt: SOURCE_TIME.toISOString() },
    {
      schemaVersion: 2,
      importKind: "user-csv",
      sourceObservedAt: "2026-02-29T10:00:00.000Z",
    },
    {
      schemaVersion: 2,
      importKind: "user-csv",
      sourceObservedAt: "2026-09-15T09:00:00.000Z",
    },
  ])("never treats legacy or unbound user CSV metadata as fresh", (metadata) => {
    expect(
      projectionTimestampProvenance({
        source: "user-csv",
        fetchedAt: SOURCE_TIME,
        createdAt: IMPORT_TIME,
        metadata,
      }),
    ).toEqual({
      sourceObservedAt: null,
      sourceObservedAtStatus: "unverified",
      importedAt: IMPORT_TIME,
    });
  });

  it("retains provider-managed fetched-at provenance", () => {
    expect(
      projectionTimestampProvenance({
        source: "trusted-weekly-model",
        fetchedAt: SOURCE_TIME,
        createdAt: IMPORT_TIME,
        metadata: {},
      }),
    ).toEqual({
      sourceObservedAt: SOURCE_TIME,
      sourceObservedAtStatus: "verified",
      importedAt: IMPORT_TIME,
    });
  });

  it("judges first-party model freshness from generation time without hiding input provenance", () => {
    const oldInputTime = new Date("2026-08-17T15:53:54.229Z");
    const generatedAt = new Date("2026-09-02T23:09:12.814Z");
    const row = {
      source: "laces-out-first-party",
      fetchedAt: oldInputTime,
      createdAt: generatedAt,
      metadata: { sourceAsOf: oldInputTime.toISOString() },
    };
    const provenance = projectionTimestampProvenance(row);

    expect(provenance.sourceObservedAt).toEqual(oldInputTime);
    expect(projectionFreshnessObservedAt(row, provenance)).toEqual(generatedAt);
  });

  it("continues to judge imported projections from verified source time", () => {
    const row = {
      source: "trusted-weekly-model",
      fetchedAt: SOURCE_TIME,
      createdAt: IMPORT_TIME,
      metadata: {},
    };

    expect(projectionFreshnessObservedAt(row)).toEqual(SOURCE_TIME);
  });
});
