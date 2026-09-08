import { normalizeProjectionSourceObservedAt } from "@laces-out/projections";

export type ProjectionSourceObservedAtStatus = "verified" | "unverified";

export interface ProjectionTimestampRow {
  readonly source: string;
  readonly fetchedAt: Date;
  readonly createdAt: Date;
  /** Explicit model cutoff for windowed managed sets such as rest-of-season forecasts. */
  readonly asOfAt?: Date;
  readonly metadata: Record<string, unknown>;
}

export interface ProjectionTimestampProvenance {
  readonly sourceObservedAt: Date | null;
  readonly sourceObservedAtStatus: ProjectionSourceObservedAtStatus;
  readonly importedAt: Date;
}

/**
 * Managed weekly projections are freshly computed artifacts whose oldest historical input can be
 * much older than the model run itself, so their freshness comes from creation time. Windowed ROS
 * releases instead expose their explicit model cutoff. Imported/provider projections continue to
 * use their verified source timestamp.
 */
export function projectionFreshnessObservedAt(
  row: ProjectionTimestampRow,
  provenance: ProjectionTimestampProvenance = projectionTimestampProvenance(row),
): Date | null {
  return row.source === "laces-out-first-party" ? row.createdAt : provenance.sourceObservedAt;
}

/**
 * `fetchedAt` historically meant import time for user CSV rows. Only schema-v2
 * rows that bind a valid source timestamp into metadata and the persisted
 * column may claim source freshness. Provider-managed sets retain their
 * existing fetched-at semantics.
 */
export function projectionTimestampProvenance(
  row: ProjectionTimestampRow,
): ProjectionTimestampProvenance {
  if (
    row.source === "laces-out-first-party-ros" &&
    row.asOfAt &&
    Number.isFinite(row.asOfAt.getTime())
  ) {
    return {
      sourceObservedAt: row.asOfAt,
      sourceObservedAtStatus: "verified",
      importedAt: row.createdAt,
    };
  }
  if (row.source !== "user-csv") {
    return {
      sourceObservedAt: row.fetchedAt,
      sourceObservedAtStatus: "verified",
      importedAt: row.createdAt,
    };
  }

  const metadata = row.metadata;
  if (
    metadata.schemaVersion === 2 &&
    metadata.importKind === "user-csv" &&
    typeof metadata.sourceObservedAt === "string"
  ) {
    try {
      const normalized = normalizeProjectionSourceObservedAt(metadata.sourceObservedAt);
      const observedAt = new Date(normalized);
      if (observedAt.getTime() === row.fetchedAt.getTime()) {
        return {
          sourceObservedAt: observedAt,
          sourceObservedAtStatus: "verified",
          importedAt: row.createdAt,
        };
      }
    } catch {
      // Legacy or malformed metadata must never inherit freshness from fetchedAt.
    }
  }

  return {
    sourceObservedAt: null,
    sourceObservedAtStatus: "unverified",
    importedAt: row.createdAt,
  };
}
