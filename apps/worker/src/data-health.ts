import { dataSources, type Database } from "@fantasy/db";
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
  readonly consecutiveFailures: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export function assessDataSourceHealth(
  sources: readonly DataSourceHealthRow[],
  checkedAt: Date,
): DataHealthCheckResult {
  if (!Number.isFinite(checkedAt.getTime()))
    throw new RangeError("Health check time must be valid");

  let healthySources = 0;
  let pendingSources = 0;
  let failingSources = 0;
  let staleSources = 0;
  const degradedSourceKeys: string[] = [];

  for (const source of sources) {
    const failing = source.consecutiveFailures > 0;
    const freshnessAnchor = source.lastSuccessfulAt ?? source.createdAt;
    const staleAfterMilliseconds = source.checkIntervalMinutes * STALE_INTERVAL_MULTIPLIER * 60_000;
    const sourceStale = checkedAt.getTime() - freshnessAnchor.getTime() > staleAfterMilliseconds;
    const qualityState = source.metadata.qualityState;
    const qualityDegraded = typeof qualityState === "string" && qualityState !== "publishable";
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
    if (failing || stale || qualityDegraded) {
      degradedSourceKeys.push(source.key);
    } else if (source.lastSuccessfulAt) {
      healthySources += 1;
    } else {
      pendingSources += 1;
    }
  }

  degradedSourceKeys.sort((left, right) => left.localeCompare(right));
  return {
    checkedAt: checkedAt.toISOString(),
    enabledSources: sources.length,
    healthySources,
    pendingSources,
    degradedSources: degradedSourceKeys.length,
    failingSources,
    staleSources,
    degradedSourceKeys,
  };
}

export class DatabaseDataHealthService implements DataHealthService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(input: { readonly database: Database; readonly now?: () => Date }) {
    this.#database = input.database;
    this.#now = input.now ?? (() => new Date());
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
        consecutiveFailures: dataSources.consecutiveFailures,
        metadata: dataSources.metadata,
        createdAt: dataSources.createdAt,
      })
      .from(dataSources)
      .where(eq(dataSources.enabled, true))
      .orderBy(asc(dataSources.key));
    if (context.signal.aborted) throw new Error("Data health check was aborted during shutdown");
    return assessDataSourceHealth(sources, this.#now());
  }
}
