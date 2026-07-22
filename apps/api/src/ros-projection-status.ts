import {
  dataSources,
  firstPartyRosChampionArtifacts,
  playerProjections,
  projectionModelRuns,
  projectionSets,
  type Database,
} from "@fantasy/db";
import { FIRST_PARTY_ROS_MODEL_VERSION } from "@fantasy/projections";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * Read-only visibility for the fail-closed rest-of-season (ROS) projection rail. This surface only
 * reports the rail's recorded state — champion-artifact presence, the most recent ROS model-run
 * audit, and any league-scoped published ROS set (counts and provenance only). It NEVER exposes a
 * secret and is deliberately not consumed by lineup, waiver, trade, standings, or AI code paths.
 */

// The shadow rail (apps/worker) writes its degraded audit under this managed source key and, when an
// admitted champion artifact authorizes a release, its published sets under this source. Both values
// are stable literals mirrored here so this read-only surface does not import worker internals.
export const FIRST_PARTY_ROS_SHADOW_SOURCE_KEY = "laces-out.projections.first-party-ros-shadow";
export const FIRST_PARTY_ROS_RELEASE_SET_SOURCE = "laces-out-first-party-ros";

export type RosPublicationSummary = "fail-closed-shadow" | "publishable";

export interface RosChampionArtifactStatus {
  readonly present: true;
  readonly season: number;
  readonly scoringProfileKey: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
  readonly evidenceThroughSeason: number;
  readonly artifactChecksum: string;
  readonly sourceChecksums: readonly { readonly key: string; readonly checksum: string }[];
  readonly admittedAt: string;
}

export interface RosModelRunAudit {
  readonly sourceSyncRunId: string;
  readonly mode: string;
  readonly qualityState: string;
  readonly canPublish: boolean;
  readonly season: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: string | null;
  readonly playersEvaluated: number;
  readonly playersPublished: number;
  readonly reasons: readonly string[];
  readonly evidenceGate: Record<string, unknown> | null;
  readonly inputChecksum: string;
  readonly sourceAsOf: string | null;
  readonly createdAt: string;
}

export interface RosPublishedSetSummary {
  readonly projectionSetId: string;
  readonly leagueSeasonId: string;
  readonly source: string;
  readonly version: string;
  readonly season: number;
  readonly playerCount: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: string | null;
  readonly fetchedAt: string;
  readonly inputChecksum: string;
  readonly championArtifactChecksum: string | null;
  readonly scoringProfileKey: string | null;
  readonly createdAt: string;
}

export interface RosProjectionStatusResponse {
  readonly season: number;
  readonly modelVersion: string;
  readonly publication: RosPublicationSummary;
  readonly artifact: RosChampionArtifactStatus | { readonly present: false };
  readonly latestRun: RosModelRunAudit | null;
  readonly publishedSets: readonly RosPublishedSetSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: Date | null | undefined): string | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? value.toISOString() : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Row shape consumed by {@link deriveRunAudit}. Kept structural so the derivation can be unit-tested
 * without a database.
 */
export interface RosModelRunRow {
  readonly sourceSyncRunId: string;
  readonly qualityState: string;
  readonly season: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: Date | null;
  readonly playersEvaluated: number;
  readonly playersPublished: number;
  readonly inputChecksum: string;
  readonly configuration: Record<string, unknown> | null;
  readonly metrics: Record<string, unknown> | null;
  readonly sourceAsOf: Date | null;
  readonly createdAt: Date;
}

/**
 * Pure derivation of one ROS model-run audit. The shadow rail records degraded runs (mode "shadow",
 * `metrics.diagnostics`); a released run records mode "release" with `metrics.withheldReasons`. A run
 * only reports `canPublish` when it is an actually-published release with at least one player.
 */
export function deriveRunAudit(row: RosModelRunRow): RosModelRunAudit {
  const configuration = isRecord(row.configuration) ? row.configuration : {};
  const metrics = isRecord(row.metrics) ? row.metrics : {};
  const mode = typeof configuration.mode === "string" ? configuration.mode : "unknown";
  const reasons =
    metrics.diagnostics !== undefined
      ? stringList(metrics.diagnostics)
      : stringList(metrics.withheldReasons);
  const evidenceGate = isRecord(metrics.gate) ? metrics.gate : null;
  const canPublish =
    row.qualityState === "publishable" && mode === "release" && row.playersPublished > 0;
  return {
    sourceSyncRunId: row.sourceSyncRunId,
    mode,
    qualityState: row.qualityState,
    canPublish,
    season: row.season,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    asOfWeek: row.asOfWeek,
    asOfAt: toIso(row.asOfAt),
    playersEvaluated: row.playersEvaluated,
    playersPublished: row.playersPublished,
    reasons,
    evidenceGate,
    inputChecksum: row.inputChecksum,
    sourceAsOf: toIso(row.sourceAsOf),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

/**
 * Fail-closed publication posture. The rail is only "publishable" when the latest run actually
 * released or a league-scoped published set exists; anything else (no artifact, degraded shadow run,
 * withheld release) reports "fail-closed-shadow".
 */
export function derivePublication(input: {
  readonly latestRun: RosModelRunAudit | null;
  readonly publishedSetCount: number;
}): RosPublicationSummary {
  if (input.publishedSetCount > 0) return "publishable";
  if (input.latestRun?.canPublish) return "publishable";
  return "fail-closed-shadow";
}

interface PublishedSetRow {
  readonly projectionSetId: string;
  readonly leagueSeasonId: string | null;
  readonly source: string;
  readonly version: string;
  readonly season: number;
  readonly playerCount: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: Date | null;
  readonly fetchedAt: Date;
  readonly inputChecksum: string;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Date;
}

/**
 * Reduces every published ROS set row to the most recent set per league (by `fetchedAt`, then
 * `createdAt`) and shapes it to provenance-only output. No player-level projection value is exposed.
 */
export function latestPublishedSetPerLeague(
  rows: readonly PublishedSetRow[],
): readonly RosPublishedSetSummary[] {
  const latest = new Map<string, PublishedSetRow>();
  for (const row of rows) {
    if (!row.leagueSeasonId) continue;
    const current = latest.get(row.leagueSeasonId);
    if (
      !current ||
      row.fetchedAt.getTime() > current.fetchedAt.getTime() ||
      (row.fetchedAt.getTime() === current.fetchedAt.getTime() &&
        row.createdAt.getTime() > current.createdAt.getTime())
    ) {
      latest.set(row.leagueSeasonId, row);
    }
  }
  return [...latest.values()]
    .sort((left, right) => right.fetchedAt.getTime() - left.fetchedAt.getTime())
    .map((row) => {
      const metadata = isRecord(row.metadata) ? row.metadata : {};
      return {
        projectionSetId: row.projectionSetId,
        leagueSeasonId: row.leagueSeasonId as string,
        source: row.source,
        version: row.version,
        season: row.season,
        playerCount: row.playerCount,
        windowStartWeek: row.windowStartWeek,
        windowEndWeek: row.windowEndWeek,
        asOfWeek: row.asOfWeek,
        asOfAt: toIso(row.asOfAt),
        fetchedAt: toIso(row.fetchedAt) ?? new Date(0).toISOString(),
        inputChecksum: row.inputChecksum,
        championArtifactChecksum:
          typeof metadata.championArtifactChecksum === "string"
            ? metadata.championArtifactChecksum
            : null,
        scoringProfileKey:
          typeof metadata.scoringProfileKey === "string" ? metadata.scoringProfileKey : null,
        createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
      } satisfies RosPublishedSetSummary;
    });
}

export class RosProjectionStatusService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async getStatus(season: number): Promise<RosProjectionStatusResponse> {
    const [artifactRow] = await this.#database
      .select({
        season: firstPartyRosChampionArtifacts.season,
        scoringProfileKey: firstPartyRosChampionArtifacts.scoringProfileKey,
        modelVersion: firstPartyRosChampionArtifacts.modelVersion,
        policyVersion: firstPartyRosChampionArtifacts.policyVersion,
        calibrationVersion: firstPartyRosChampionArtifacts.calibrationVersion,
        evidenceThroughSeason: firstPartyRosChampionArtifacts.evidenceThroughSeason,
        sourceChecksums: firstPartyRosChampionArtifacts.sourceChecksums,
        artifactChecksum: firstPartyRosChampionArtifacts.artifactChecksum,
        admittedAt: firstPartyRosChampionArtifacts.admittedAt,
      })
      .from(firstPartyRosChampionArtifacts)
      .where(eq(firstPartyRosChampionArtifacts.season, season))
      .orderBy(desc(firstPartyRosChampionArtifacts.admittedAt))
      .limit(1);

    const artifact: RosProjectionStatusResponse["artifact"] = artifactRow
      ? {
          present: true,
          season: artifactRow.season,
          scoringProfileKey: artifactRow.scoringProfileKey,
          modelVersion: artifactRow.modelVersion,
          policyVersion: artifactRow.policyVersion,
          calibrationVersion: artifactRow.calibrationVersion,
          evidenceThroughSeason: artifactRow.evidenceThroughSeason,
          artifactChecksum: artifactRow.artifactChecksum,
          sourceChecksums: (artifactRow.sourceChecksums ?? []).map((entry) => ({
            key: entry.key,
            checksum: entry.checksum,
          })),
          admittedAt: toIso(artifactRow.admittedAt) ?? new Date(0).toISOString(),
        }
      : { present: false };

    const [shadowSource] = await this.#database
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.key, FIRST_PARTY_ROS_SHADOW_SOURCE_KEY))
      .limit(1);

    let latestRun: RosModelRunAudit | null = null;
    if (shadowSource) {
      const [runRow] = await this.#database
        .select({
          sourceSyncRunId: projectionModelRuns.sourceSyncRunId,
          qualityState: projectionModelRuns.qualityState,
          season: projectionModelRuns.season,
          windowStartWeek: projectionModelRuns.windowStartWeek,
          windowEndWeek: projectionModelRuns.windowEndWeek,
          asOfWeek: projectionModelRuns.asOfWeek,
          asOfAt: projectionModelRuns.asOfAt,
          playersEvaluated: projectionModelRuns.playersEvaluated,
          playersPublished: projectionModelRuns.playersPublished,
          inputChecksum: projectionModelRuns.inputChecksum,
          configuration: projectionModelRuns.configuration,
          metrics: projectionModelRuns.metrics,
          sourceAsOf: projectionModelRuns.sourceAsOf,
          createdAt: projectionModelRuns.createdAt,
        })
        .from(projectionModelRuns)
        .where(
          and(
            eq(projectionModelRuns.sourceId, shadowSource.id),
            eq(projectionModelRuns.season, season),
            eq(projectionModelRuns.horizon, "rest-of-season"),
          ),
        )
        .orderBy(desc(projectionModelRuns.createdAt), desc(projectionModelRuns.sourceSyncRunId))
        .limit(1);
      if (runRow) latestRun = deriveRunAudit(runRow);
    }

    const publishedRows = await this.#database
      .select({
        projectionSetId: projectionSets.id,
        leagueSeasonId: projectionSets.leagueSeasonId,
        source: projectionSets.source,
        version: projectionSets.version,
        season: projectionSets.season,
        windowStartWeek: projectionSets.windowStartWeek,
        windowEndWeek: projectionSets.windowEndWeek,
        asOfWeek: projectionSets.asOfWeek,
        asOfAt: projectionSets.asOfAt,
        fetchedAt: projectionSets.fetchedAt,
        inputChecksum: projectionSets.inputChecksum,
        metadata: projectionSets.metadata,
        createdAt: projectionSets.createdAt,
        playerCount: sql<number>`(
          select count(*)::int
          from ${playerProjections}
          where ${playerProjections.projectionSetId} = ${projectionSets.id}
        )`,
      })
      .from(projectionSets)
      .where(
        and(
          eq(projectionSets.source, FIRST_PARTY_ROS_RELEASE_SET_SOURCE),
          eq(projectionSets.season, season),
        ),
      )
      .orderBy(desc(projectionSets.fetchedAt));

    const publishedSets = latestPublishedSetPerLeague(publishedRows);

    return {
      season,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      publication: derivePublication({ latestRun, publishedSetCount: publishedSets.length }),
      artifact,
      latestRun,
      publishedSets,
    };
  }
}
