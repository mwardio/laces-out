import { dataSources, type Database, type JsonPrimitive } from "@fantasy/db";
import { and, eq } from "drizzle-orm";

/**
 * Shared reader for the `data_sources` admission record. Every research surface answers the
 * same three questions before it shows a number — did the latest artifact clear admission,
 * which checksum is live, and what did the read cover — so the provenance block and the
 * metadata parsing live here rather than being restated per surface.
 */
export interface AdmittedSourceRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly attribution: string | null;
  readonly attributionUrl: string | null;
  readonly lastSuccessfulAt: Date | null;
  readonly lastChecksum: string | null;
  readonly metadata: Record<string, JsonPrimitive>;
}

export interface AdmittedSourceQuality {
  readonly rowsRead: number | null;
  readonly rowsRejected: number | null;
  readonly rowsUnmatched: number | null;
  readonly matchRate: number | null;
}

export interface AdmittedSourceContract<Dataset extends string> {
  readonly dataset: Dataset;
  readonly state: "available" | "unavailable" | "quarantined";
  readonly key: string;
  readonly name: string;
  readonly attribution: string | null;
  readonly attributionUrl: string | null;
  readonly fetchedAt: string | null;
  readonly checksumSha256: string | null;
  readonly coveredWeeks: number[];
  readonly quality: AdmittedSourceQuality;
  readonly reason: string | null;
}

export function selectAdmittedSource(
  database: Database,
  key: string,
): Promise<AdmittedSourceRow | undefined> {
  return database
    .select({
      id: dataSources.id,
      key: dataSources.key,
      name: dataSources.name,
      attribution: dataSources.attribution,
      attributionUrl: dataSources.attributionUrl,
      lastSuccessfulAt: dataSources.lastSuccessfulAt,
      lastChecksum: dataSources.lastChecksum,
      metadata: dataSources.metadata,
    })
    .from(dataSources)
    .where(and(eq(dataSources.key, key), eq(dataSources.enabled, true)))
    .limit(1)
    .then(([row]) => row);
}

export function metadataInteger(
  metadata: Record<string, JsonPrimitive>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function metadataRate(
  metadata: Record<string, JsonPrimitive>,
  key = "matchRate",
): number | null {
  const value = metadata[key];
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

/** Ingestion stores covered weeks as a comma-joined string, so parse defensively. */
export function metadataCoveredWeeks(metadata: Record<string, JsonPrimitive>): number[] {
  const raw = metadata.coveredWeeks;
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 25),
    ),
  ].sort((left, right) => left - right);
}

export function metadataCoveredTeams(metadata: Record<string, JsonPrimitive>): string[] {
  const raw = metadata.coveredTeams;
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((team) => team.trim().toUpperCase())
        .filter((team) => /^[A-Z]{2,4}$/u.test(team)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function admittedSourceQuality(
  source: AdmittedSourceRow | undefined,
): AdmittedSourceQuality {
  return {
    rowsRead: source ? metadataInteger(source.metadata, "rowsRead") : null,
    rowsRejected: source ? metadataInteger(source.metadata, "rowsRejected") : null,
    rowsUnmatched: source ? metadataInteger(source.metadata, "rowsUnmatched") : null,
    matchRate: source ? metadataRate(source.metadata) : null,
  };
}

export function admittedSourceContract<Dataset extends string>(
  dataset: Dataset,
  key: string,
  fallbackName: string,
  source: AdmittedSourceRow | undefined,
): AdmittedSourceContract<Dataset> {
  const admitted = source?.metadata.publishable === true;
  const ready = admitted && source.lastChecksum !== null && source.lastSuccessfulAt !== null;
  return {
    dataset,
    state: !source ? "unavailable" : ready ? "available" : "quarantined",
    key: source?.key ?? key,
    name: source?.name ?? fallbackName,
    attribution: source?.attribution ?? null,
    attributionUrl: source?.attributionUrl ?? null,
    fetchedAt: source?.lastSuccessfulAt?.toISOString() ?? null,
    checksumSha256: ready ? source.lastChecksum : null,
    coveredWeeks: source ? metadataCoveredWeeks(source.metadata) : [],
    quality: admittedSourceQuality(source),
    reason: !source
      ? "This dataset has not completed its first refresh for the selected season."
      : ready
        ? null
        : "The latest dataset has not cleared admission and identity-quality checks.",
  };
}
