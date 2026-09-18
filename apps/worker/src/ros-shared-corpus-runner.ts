import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";
import path from "node:path";

import {
  HISTORICAL_ROS_DEFAULT_CUTOFFS,
  HISTORICAL_ROS_SUPPORTED_POSITIONS,
} from "./first-party-ros-backtest.js";
import {
  FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
  FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
} from "./first-party-ros-validation-contract.js";
import type { RosCorpusLock } from "./ros-corpus-lock.js";
import {
  createRosHistoricalCorpusStore,
  ROS_HISTORICAL_CORPUS_SCHEMA_VERSION,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";
import {
  hasCurrentRosHistoricalCoverageThresholds,
  hasRosHistoricalCorpusReleaseThresholds,
  isCompatibleRosHistoricalCorpusBuildProtocol,
  ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL,
  ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
  ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
} from "./ros-historical-corpus-protocol.js";
import { restoreCachedRosHistoricalOutcome } from "./ros-historical-outcome-replay.js";
import { createRosOutcomeCache } from "./ros-outcome-cache.js";
import type { RosProfileValidationRunner } from "./ros-profile-validation-runner.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const POINTER_MAXIMUM_BYTES = 64 * 1_024;
export const ROS_SHARED_CORPUS_BUILD_LOCK = "all-historical-ros-corpus-builds-v1";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const sorted = (values: readonly (string | number)[]) => JSON.stringify([...values].sort());
const sourceKey = (sources: Readonly<Record<string, string>>) =>
  JSON.stringify(Object.entries(sources).sort(([left], [right]) => left.localeCompare(right)));

/** No league identity or scoring rules enter this shared model/season/protocol identity. */
export function rosSharedCorpusRequest(season: number) {
  if (!Number.isSafeInteger(season) || season < 2007 || season > 2200)
    throw new RangeError("Invalid ROS shared corpus season");
  const protocol = {
    ...ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL,
    version: "shared-historical-football-corpus-v3",
    buildProtocolVersion: ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL.version,
    corpusSchemaVersion: ROS_HISTORICAL_CORPUS_SCHEMA_VERSION,
    ...ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
    coverageThresholds: ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
    season,
    sourceSeasons: Array.from({ length: 7 }, (_, index) => season - 7 + index),
    heldOutSeasons: Array.from({ length: 4 }, (_, index) => season - 4 + index),
    asOfWeeks: HISTORICAL_ROS_DEFAULT_CUTOFFS,
    positions: HISTORICAL_ROS_SUPPORTED_POSITIONS,
    playersPerPosition: FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
    maximumForecasts: FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
  };
  return {
    identity: createHash("sha256").update(JSON.stringify(protocol)).digest("hex"),
    protocol,
  };
}

type CorpusRequest = ReturnType<typeof rosSharedCorpusRequest>;
interface ReadyPointer {
  readonly format: "laces-ros-corpus-ready-v1";
  readonly requestIdentity: string;
  readonly corpusIdentity: string;
  readonly sourceChecksums: Readonly<Record<string, string>>;
  readonly protocol: CorpusRequest["protocol"];
  readonly builtAt: string;
}

function assertCorpusScope(corpus: RosHistoricalCorpus, request: CorpusRequest): void {
  const expected = request.protocol;
  if (
    !isCompatibleRosHistoricalCorpusBuildProtocol(corpus.buildProtocol) ||
    !hasRosHistoricalCorpusReleaseThresholds(corpus.options) ||
    !hasCurrentRosHistoricalCoverageThresholds(corpus.coverage.thresholds) ||
    corpus.coverage.state !== "qualified" ||
    sorted(corpus.coverage.heldOutSeasonsRequested) !== sorted(expected.heldOutSeasons) ||
    expected.heldOutSeasons.some(
      (season) => !corpus.coverage.fullyHeldOutSeasons.includes(season),
    ) ||
    corpus.coverage.completeAsOfBatches <
      expected.heldOutSeasons.length * expected.asOfWeeks.length ||
    corpus.modelVersion !== expected.modelVersion ||
    corpus.outcomeSchemaVersion !== expected.outcomeSchemaVersion ||
    corpus.weeklyModelVersion !== expected.weeklyModelVersion ||
    corpus.productionBasis !== expected.productionBasis ||
    sorted(corpus.sourceAudit.map((row) => row.season!)) !== sorted(expected.sourceSeasons) ||
    sorted(corpus.options.heldOutSeasons) !== sorted(expected.heldOutSeasons) ||
    sorted(corpus.options.asOfWeeks) !== sorted(expected.asOfWeeks) ||
    sorted(corpus.options.positions) !== sorted(expected.positions) ||
    corpus.options.playersPerPosition !== expected.playersPerPosition ||
    corpus.options.maximumForecasts !== expected.maximumForecasts
  )
    throw new Error("Shared ROS corpus does not match its requested model or validation scope");
  const covered = new Set(
    corpus.forecasts.map(
      ({ forecast }) => `${forecast.forecastSeason}:${forecast.asOfWeek}:${forecast.position}`,
    ),
  );
  for (const season of expected.heldOutSeasons) {
    for (const week of expected.asOfWeeks) {
      for (const position of expected.positions) {
        if (!covered.has(`${season}:${week}:${position}`))
          throw new Error(
            `Shared ROS corpus is incomplete for ${season} cutoff ${week} ${position}`,
          );
      }
    }
  }
}

async function verifySharedCorpus(
  directory: string,
  identity: string,
  request: CorpusRequest,
  signal: AbortSignal,
): Promise<RosHistoricalCorpus> {
  const store = createRosHistoricalCorpusStore({ directory: path.join(directory, "corpora") });
  const cache = createRosOutcomeCache({ directory });
  const loaded = await store.read(identity, { signal });
  if (loaded.state !== "hit")
    throw new Error(`Shared ROS builder returned a ${loaded.state} corpus`);
  assertCorpusScope(loaded.corpus, request);
  // Verify every immutable vector with bounded one-entry memory; a small release-only ensemble
  // cannot stand in for the full convergence-reference evidence.
  for (const forecast of loaded.corpus.forecasts) {
    for (const [strategy, key] of [
      ["contextual", forecast.contextualKey],
      ["availability-aware-recency", forecast.recencyKey],
    ] as const) {
      const entry = await cache.read(key, {
        signal,
        expectedScenarioCount: request.protocol.referenceScenarioCount,
      });
      if (entry.state !== "hit")
        throw new Error(`Shared ROS builder left a ${entry.state} outcome entry`);
      // A key reused by another forecast still has to match that reference's player, cutoff,
      // strategy and checksum. Byte integrity alone cannot establish manifest correctness.
      restoreCachedRosHistoricalOutcome(entry.ensemble, key, {
        ...forecast.forecast,
        strategy,
        weeklyModelVersion: loaded.corpus.weeklyModelVersion,
        scheduledGames: forecast.scheduledGames,
      });
    }
  }
  return loaded.corpus;
}

function readyPointer(
  request: CorpusRequest,
  corpusIdentity: string,
  corpus: RosHistoricalCorpus,
): ReadyPointer {
  return {
    format: "laces-ros-corpus-ready-v1",
    requestIdentity: request.identity,
    corpusIdentity,
    sourceChecksums: corpus.sourceChecksums,
    protocol: request.protocol,
    builtAt: new Date().toISOString(),
  };
}

async function readPointer(file: string, request: CorpusRequest): Promise<ReadyPointer | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error("Shared ROS corpus ready pointer cannot be read", { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > POINTER_MAXIMUM_BYTES)
      throw new Error("Shared ROS corpus ready pointer exceeds its bounds");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (
      !object(value) ||
      value.format !== "laces-ros-corpus-ready-v1" ||
      value.requestIdentity !== request.identity ||
      typeof value.corpusIdentity !== "string" ||
      !SHA256.test(value.corpusIdentity) ||
      !object(value.sourceChecksums) ||
      !Object.values(value.sourceChecksums).every(
        (checksum) => typeof checksum === "string" && SHA256.test(checksum),
      ) ||
      JSON.stringify(value.protocol) !== JSON.stringify(request.protocol)
    )
      throw new Error("Shared ROS corpus ready pointer is corrupt or incompatible");
    return value as unknown as ReadyPointer;
  } finally {
    await handle.close();
  }
}

async function writePointer(file: string, pointer: ReadyPointer, signal: AbortSignal) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(pointer);
  await assertRosCacheHeadroom(path.dirname(file), Buffer.byteLength(serialized), signal);
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    // Never replace an existing winner, even if a database connection failed immediately after
    // the final fencing check and another worker recovered the build.
    await link(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readyCorpusIdentity(
  directory: string,
  request: CorpusRequest,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const pointer = await readPointer(
    path.join(directory, "ready", `${request.identity}.json`),
    request,
  );
  if (!pointer) return null;
  const store = createRosHistoricalCorpusStore({ directory: path.join(directory, "corpora") });
  const loaded = await store.read(pointer.corpusIdentity, { signal });
  if (loaded.state !== "hit")
    throw new Error(`Shared ROS ready corpus is ${loaded.state}; explicit repair is required`);
  assertCorpusScope(loaded.corpus, request);
  if (sourceKey(loaded.corpus.sourceChecksums) !== sourceKey(pointer.sourceChecksums))
    throw new Error("Shared ROS ready corpus source lineage differs from its pointer");
  return pointer.corpusIdentity;
}

/** A ready pointer is committed only after full vector verification; replays verify vectors again. */
export function readyRosSharedCorpusIdentity(
  directory: string,
  season: number,
  signal: AbortSignal,
): Promise<string | null> {
  return readyCorpusIdentity(directory, rosSharedCorpusRequest(season), signal);
}

/**
 * One durable football build serves all exact-profile proofs. An existing broken pointer or
 * corpus fails visibly; it never silently starts expensive modeling for an individual league.
 */
export function createSharedRosCorpusValidationRunner(options: {
  readonly directory: string;
  readonly lock: RosCorpusLock;
  readonly runner: RosProfileValidationRunner;
  /** Durable bootstrap claim fencing around the final immutable ready-pointer commit. */
  readonly commitReady?: (input: {
    readonly corpusIdentity: string;
    readonly commit: () => Promise<void>;
  }) => Promise<void>;
}): RosProfileValidationRunner {
  const replay = async (input: Parameters<RosProfileValidationRunner>[0], identity: string) => {
    const report = await options.runner({ ...input, replayCorpusIdentity: identity });
    if (report.outcomeCorpusIdentity !== identity)
      throw new Error("Shared ROS replay returned a different corpus identity");
    return report;
  };
  return async (input) => {
    if (input.replayCorpusIdentity !== undefined)
      throw new Error("Shared ROS runner owns corpus selection");
    const request = rosSharedCorpusRequest(input.season);
    const file = path.join(options.directory, "ready", `${request.identity}.json`);
    // Ready data remains usable while a different season or model is building its own corpus.
    const ready = await readyCorpusIdentity(options.directory, request, input.signal);
    if (input.requiredReadyCorpusIdentity !== undefined) {
      if (
        typeof input.requiredReadyCorpusIdentity !== "string" ||
        !SHA256.test(input.requiredReadyCorpusIdentity) ||
        ready !== input.requiredReadyCorpusIdentity
      )
        throw new Error(
          "Required ready ROS corpus is absent or changed; recovery cannot build a replacement",
        );
      return replay(input, ready);
    }
    if (ready) return replay(input, ready);
    const result = await options.lock(ROS_SHARED_CORPUS_BUILD_LOCK, input.signal, async (guard) => {
      const identityAfterWait = await readyCorpusIdentity(options.directory, request, guard.signal);
      if (identityAfterWait) return { identity: identityAfterWait };
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await assertRosCacheHeadroom(options.directory, POINTER_MAXIMUM_BYTES, guard.signal);
      const report = await options.runner({ ...input, signal: guard.signal });
      guard.signal.throwIfAborted();
      const identity = report.outcomeCorpusIdentity;
      if (identity === undefined && report.state === "blocked-before-modeling") return { report };
      if (typeof identity !== "string" || !SHA256.test(identity))
        throw new Error("Shared ROS builder did not return a valid immutable corpus identity");
      const corpus = await verifySharedCorpus(options.directory, identity, request, guard.signal);
      await guard.assertHeld();
      const commit = async () => {
        await guard.assertHeld();
        await writePointer(file, readyPointer(request, identity, corpus), guard.signal);
      };
      if (options.commitReady) await options.commitReady({ corpusIdentity: identity, commit });
      else await commit();
      return { report };
    });
    if ("report" in result) return result.report;
    // Exact scoring proofs can run concurrently after the shared builder releases its lock.
    return replay(input, result.identity);
  };
}

/** Adopts a prebuilt complete corpus without invoking fitting, simulation, or a profile runner. */
export async function adoptRosSharedCorpus(options: {
  readonly directory: string;
  readonly corpusIdentity: string;
  readonly season: number;
  readonly lock: RosCorpusLock;
  readonly signal: AbortSignal;
}): Promise<{
  readonly state: "adopted" | "existing";
  readonly requestIdentity: string;
  readonly corpusIdentity: string;
}> {
  if (!SHA256.test(options.corpusIdentity)) throw new Error("Invalid ROS corpus identity");
  const request = rosSharedCorpusRequest(options.season);
  const file = path.join(options.directory, "ready", `${request.identity}.json`);
  return options.lock(ROS_SHARED_CORPUS_BUILD_LOCK, options.signal, async (guard) => {
    const existing = await readPointer(file, request);
    if (existing && existing.corpusIdentity !== options.corpusIdentity)
      throw new Error("A conflicting shared ROS corpus is already committed for this protocol");
    if (!existing)
      await assertRosCacheHeadroom(options.directory, POINTER_MAXIMUM_BYTES, guard.signal);
    const corpus = await verifySharedCorpus(
      options.directory,
      options.corpusIdentity,
      request,
      guard.signal,
    );
    if (existing && sourceKey(existing.sourceChecksums) !== sourceKey(corpus.sourceChecksums))
      throw new Error("Shared ROS ready corpus source lineage differs from its pointer");
    await guard.assertHeld();
    if (!existing)
      await writePointer(file, readyPointer(request, options.corpusIdentity, corpus), guard.signal);
    return {
      state: existing ? "existing" : "adopted",
      requestIdentity: request.identity,
      corpusIdentity: options.corpusIdentity,
    };
  });
}
