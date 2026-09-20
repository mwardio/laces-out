import { createHash } from "node:crypto";
import {
  retainedV12RosHistoricalCorpusIdentity,
  snapshotRetainedV12RosHistoricalCorpus,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";
import { restoreRetainedV12CachedRosHistoricalOutcome } from "./ros-historical-outcome-replay.js";
import {
  readAuthenticatedRosOutcomeSource,
  type RosDerivedOutcomeSource,
} from "./ros-derived-outcome-cache.js";
import type { RosOutcomeCache, RosOutcomeCacheKey } from "./ros-outcome-cache.js";

/** Original benchmark paths, including v12 DST, never receive compatible/current metadata. */
export function createRosDerivedRetainedOutcomeCache(options: {
  readonly corpus: RosHistoricalCorpus;
  readonly expectedCorpusIdentity: string;
  readonly sources: readonly RosDerivedOutcomeSource[];
  readonly directory: string;
}): RosOutcomeCache {
  const corpus = snapshotRetainedV12RosHistoricalCorpus(options.corpus);
  if (
    retainedV12RosHistoricalCorpusIdentity(corpus) !== options.expectedCorpusIdentity ||
    options.sources.length !== corpus.forecasts.length * 2
  )
    throw new Error("Retained derived cache corpus or source count mismatch");
  const sourceJson = JSON.stringify(options.sources);
  if (Buffer.byteLength(sourceJson) > 64 * 1_024 * 1_024)
    throw new Error("Retained source inventory exceeds bounds");
  const sources = JSON.parse(sourceJson) as RosDerivedOutcomeSource[];
  const byKey = new Map<string, RosDerivedOutcomeSource>();
  function id(key: RosOutcomeCacheKey) {
    if (key.modelVersion !== "laces-ros-distribution-v12" || !/^[a-f0-9]{64}$/u.test(key.identity))
      throw new Error("Retained physical key required");
    return key.identity;
  }
  for (const source of sources) {
    const identity = id(source.key);
    if (source.namespace !== "original-v12" || byKey.has(identity))
      throw new Error("Invalid retained source namespace or duplicate key");
    byKey.set(identity, source);
  }
  const entries = new Map<
    string,
    {
      source: RosDerivedOutcomeSource;
      expected: Parameters<typeof restoreRetainedV12CachedRosHistoricalOutcome>[2];
    }
  >();
  for (const row of corpus.forecasts)
    for (const strategy of ["contextual", "availability-aware-recency"] as const) {
      const key = strategy === "contextual" ? row.contextualKey : row.recencyKey;
      const identity = id(key),
        source = byKey.get(identity);
      if (!source || entries.has(identity))
        throw new Error("Retained physical source coverage mismatch");
      const filename =
        createHash("sha256")
          .update(
            JSON.stringify({ identity: key.identity, modelVersion: key.modelVersion, version: 1 }),
          )
          .digest("hex") + ".ros-outcomes";
      if (source.filename !== filename)
        throw new Error("Retained basename differs from original key");
      entries.set(identity, {
        source,
        expected: {
          ...row.forecast,
          strategy,
          weeklyModelVersion: corpus.weeklyModelVersion,
          scheduledGames: row.scheduledGames,
        },
      });
    }
  const directory = options.directory;
  return Object.freeze({
    async read(key, readOptions = {}) {
      const signal = readOptions.signal;
      signal?.throwIfAborted();
      if (
        readOptions.expectedScenarioCount !== undefined &&
        readOptions.expectedScenarioCount !== 16_384
      )
        throw new Error("Retained full reference paths required");
      const entry = entries.get(id(key));
      if (!entry) throw new Error("Unknown retained physical reference");
      const result = await readAuthenticatedRosOutcomeSource(directory, entry.source, signal);
      restoreRetainedV12CachedRosHistoricalOutcome(
        result.ensemble,
        entry.source.key,
        entry.expected,
      );
      signal?.throwIfAborted();
      return result;
    },
    write() {
      return Promise.reject(
        new Error("Retained derived cache is read-only; no simulation or fallback"),
      );
    },
  } satisfies RosOutcomeCache);
}
