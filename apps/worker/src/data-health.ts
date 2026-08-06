import { dataSources, type Database } from "@laces-out/db";
import { isArchivedNflverseSource } from "@laces-out/domain";
import { asc, eq } from "drizzle-orm";

import type {
  DataHealthCheckResult,
  DataHealthJob,
  DataHealthService,
  WorkerJobContext,
} from "./jobs.js";

const STALE_INTERVAL_MULTIPLIER = 2;

export interface DataSourceHealthRow {
  readonly key: string;
  readonly checkIntervalMinutes: number;
  readonly lastSuccessfulAt: Date | null;
  readonly lastChecksum?: string | null;
  readonly consecutiveFailures: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface DataSourceHealthOptions {
  /** Completed nflverse seasons are integrity-checked artifacts, not freshness-monitored feeds. */
  readonly activeNflSeason?: number;
}

export function assessDataSourceHealth(
  sources: readonly DataSourceHealthRow[],
  checkedAt: Date,
  options: DataSourceHealthOptions = {},
): DataHealthCheckResult {
  if (!Number.isFinite(checkedAt.getTime()))
    throw new RangeError("Health check time must be valid");

  let healthySources = 0;
  let pendingSources = 0;
  let failingSources = 0;
  let staleSources = 0;
  let unmatchedIdentitySources = 0;
  const degradedSourceKeys: string[] = [];

  const monitoredSources = sources;
  for (const source of monitoredSources) {
    const archived =
      options.activeNflSeason !== undefined &&
      isArchivedNflverseSource(source.key, source.metadata, options.activeNflSeason);
    const archivedArtifactReady =
      archived &&
      typeof source.lastChecksum === "string" &&
      source.lastSuccessfulAt !== null &&
      source.metadata.availability === "available" &&
      source.metadata.publishable !== false;
    // A failed audit says the upstream endpoint was unavailable; it does not corrupt the admitted
    // snapshot already stored locally.
    const failing = source.consecutiveFailures > 0 && !archivedArtifactReady;
    const expectedPending = source.metadata.availability === "not-published" && !failing;
    const freshnessAnchor = source.lastSuccessfulAt ?? source.createdAt;
    const staleAfterMilliseconds = source.checkIntervalMinutes * STALE_INTERVAL_MULTIPLIER * 60_000;
    const sourceStale =
      !archivedArtifactReady &&
      !expectedPending &&
      checkedAt.getTime() - freshnessAnchor.getTime() > staleAfterMilliseconds;
    const qualityState = source.metadata.qualityState;
    // Shadow rails are intentionally non-publishable until their evidence gate clears. Their own
    // transport failures and staleness still count, but the expected shadow quality state does not.
    const qualityDegraded =
      source.metadata.mode !== "shadow" &&
      typeof qualityState === "string" &&
      qualityState !== "publishable";
    // The nflverse and FFC ingestions historically wrote only the boolean `publishable` pair, so a
    // source that fell below its match-rate threshold never reached the `qualityState` branch above
    // and was invisible to this job. Read the stored pair rather than calling the registry, so the
    // job reports against the threshold that was actually in force when the artifact was written.
    const matchRate = source.metadata.matchRate;
    const minimumMatchRate = source.metadata.minimumPublishableMatchRate;
    const identityDegraded =
      typeof matchRate === "number" &&
      typeof minimumMatchRate === "number" &&
      Number.isFinite(matchRate) &&
      Number.isFinite(minimumMatchRate) &&
      matchRate < minimumMatchRate;
    const hasActiveProjectionTargets =
      typeof source.metadata.targetWeeks === "string" && source.metadata.targetWeeks !== "none";
    const lastPublishedAt =
      typeof source.metadata.lastPublishedAt === "string"
        ? new Date(source.metadata.lastPublishedAt)
        : undefined;
    const lastEvaluationAt =
      typeof source.metadata.lastEvaluationAt === "string"
        ? new Date(source.metadata.lastEvaluationAt)
        : undefined;
    const publicationStale =
      hasActiveProjectionTargets &&
      (!lastPublishedAt ||
        !Number.isFinite(lastPublishedAt.getTime()) ||
        !lastEvaluationAt ||
        !Number.isFinite(lastEvaluationAt.getTime()) ||
        checkedAt.getTime() - lastEvaluationAt.getTime() > staleAfterMilliseconds);
    const stale = sourceStale || publicationStale;

    if (failing) failingSources += 1;
    if (stale) staleSources += 1;
    if (identityDegraded) unmatchedIdentitySources += 1;
    if (failing || stale || qualityDegraded || identityDegraded) {
      degradedSourceKeys.push(source.key);
    } else if (source.lastSuccessfulAt && !expectedPending) {
      healthySources += 1;
    } else {
      pendingSources += 1;
    }
  }

  degradedSourceKeys.sort((left, right) => left.localeCompare(right));
  return {
    checkedAt: checkedAt.toISOString(),
    enabledSources: monitoredSources.length,
    healthySources,
    pendingSources,
    degradedSources: degradedSourceKeys.length,
    failingSources,
    staleSources,
    unmatchedIdentitySources,
    degradedSourceKeys,
  };
}

export class DatabaseDataHealthService implements DataHealthService {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #options: DataSourceHealthOptions;

  constructor(input: {
    readonly database: Database;
    readonly now?: () => Date;
    readonly activeNflSeason?: number;
  }) {
    this.#database = input.database;
    this.#now = input.now ?? (() => new Date());
    this.#options =
      input.activeNflSeason === undefined ? {} : { activeNflSeason: input.activeNflSeason };
  }

  async checkDataHealth(
    _job: DataHealthJob,
    context: WorkerJobContext,
  ): Promise<DataHealthCheckResult> {
    if (context.signal.aborted) throw new Error("Data health check was aborted during shutdown");
    const sources = await this.#database
      .select({
        key: dataSources.key,
        checkIntervalMinutes: dataSources.checkIntervalMinutes,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        lastChecksum: dataSources.lastChecksum,
        consecutiveFailures: dataSources.consecutiveFailures,
        metadata: dataSources.metadata,
        createdAt: dataSources.createdAt,
      })
      .from(dataSources)
      .where(eq(dataSources.enabled, true))
      .orderBy(asc(dataSources.key));
    if (context.signal.aborted) throw new Error("Data health check was aborted during shutdown");
    return assessDataSourceHealth(sources, this.#now(), this.#options);
  }
}
