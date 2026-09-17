import { createHash } from "node:crypto";

import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_MINIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  FIRST_PARTY_ROS_SEED_VERSION,
  projectionScoringProfileKey,
  rosProfileDefinitionFromKey,
  scoreFirstPartyRosOutcomes,
  simulateFirstPartyRosOutcomes,
  type FirstPartyRosOutcomeEnsemble,
  type FirstPartyRosOutcomeInput,
  type FirstPartyRosOutcomeScore,
  type FirstPartyRosProjectionInput,
  type ProjectionScoringProfile,
} from "@laces-out/projections";

import type {
  RosOutcomeCache,
  RosOutcomeCacheEnsemble,
  RosOutcomeCacheKey,
} from "./ros-outcome-cache.js";

export type RosHistoricalOutcomeEvaluator = (
  input: FirstPartyRosProjectionInput,
) => Promise<FirstPartyRosOutcomeScore>;

export class RosHistoricalOutcomeReplayError extends Error {
  constructor(
    readonly code:
      "outcome_input_invalid" | "outcome_evidence_not_ready" | "outcome_evidence_corrupt",
    readonly identity?: string,
  ) {
    super(`ROS historical replay ${code}${identity ? ` (${identity})` : ""}`);
    this.name = "RosHistoricalOutcomeReplayError";
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const MAXIMUM_INPUT_BYTES = 512 * 1_024;

function canonicalInput(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > 20_000 || depth > 16)
      throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
      return JSON.stringify(item);
    }
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      if (bytes > MAXIMUM_INPUT_BYTES)
        throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
      return JSON.stringify(item);
    }
    if (typeof item !== "object" || item === null || ancestors.has(item))
      throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (item.length > 20_000) throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
      result = `[${Array.from(item, (child) => visit(child, depth + 1)).join(",")}]`;
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
      const values = item as Record<string, unknown>;
      const keys = Object.keys(values).sort();
      if (keys.length > 20_000) throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
      result = `{${keys
        .filter((key) => values[key] !== undefined)
        .map((key) => `${visit(key, depth + 1)}:${visit(values[key], depth + 1)}`)
        .join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  };
  const serialized = visit(value, 0);
  if (Buffer.byteLength(serialized) > MAXIMUM_INPUT_BYTES)
    throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
  return serialized;
}

function pinnedInput(input: FirstPartyRosProjectionInput): {
  readonly football: FirstPartyRosOutcomeInput;
  readonly key: RosOutcomeCacheKey;
} {
  const football = Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== "scoringProfile" && name !== "scenarioCount"),
  );
  // The input checksum must already describe football/model data, never a league scoring key.
  // Keeping it, instead of silently replacing it here, preserves the engine's actual seed.
  const serialized = canonicalInput({
    ...football,
    scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  });
  const normalized = JSON.parse(serialized) as FirstPartyRosOutcomeInput;
  return {
    football: normalized,
    key: {
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      identity: hash(
        canonicalInput({
          schemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
          modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          input: normalized,
        }),
      ),
    },
  };
}

/** Stable across exact league rules and release/reference counts, bound to all football inputs. */
export function rosHistoricalOutcomeCacheKey(
  input: FirstPartyRosProjectionInput,
): RosOutcomeCacheKey {
  return pinnedInput(input).key;
}

export interface RosHistoricalCachedOutcomeExpectation {
  readonly playerId: string;
  readonly position: FirstPartyRosProjectionInput["position"];
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly inputChecksum: string;
  readonly strategy: FirstPartyRosProjectionInput["strategy"];
  readonly weeklyModelVersion?: string;
  readonly scheduledGames?: number;
}

function restoreEnsemble(
  stored: RosOutcomeCacheEnsemble,
  football: FirstPartyRosOutcomeInput | RosHistoricalCachedOutcomeExpectation,
  identity: string,
): FirstPartyRosOutcomeEnsemble {
  const invalid = () => new RosHistoricalOutcomeReplayError("outcome_evidence_corrupt", identity);
  const metadata = stored.metadata;
  const core = metadata.core;
  if (
    metadata.schemaVersion !== FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION ||
    metadata.identity !== identity ||
    typeof metadata.seed !== "string" ||
    !object(core) ||
    !object(core.provenance) ||
    !object(core.simulation)
  )
    throw invalid();
  const fullInput = "weeks" in football;
  const season = fullInput ? football.season : football.forecastSeason;
  const scheduledGames = fullInput
    ? football.weeks.filter((week) => week.scheduled).length
    : football.scheduledGames;
  const provenance = core.provenance;
  if (
    typeof provenance.asOfAt !== "string" ||
    !Number.isFinite(Date.parse(provenance.asOfAt)) ||
    new Date(provenance.asOfAt).toISOString() !== provenance.asOfAt ||
    typeof provenance.weeklyModelVersion !== "string" ||
    provenance.weeklyModelVersion.length < 1 ||
    provenance.weeklyModelVersion.length > 256 ||
    !Number.isSafeInteger(core.scheduledGames) ||
    (core.scheduledGames as number) < 0 ||
    (core.scheduledGames as number) > 18 ||
    (fullInput && metadata.seed !== football.seed)
  )
    throw invalid();
  if (
    core.playerId !== football.playerId ||
    core.position !== football.position ||
    (scheduledGames !== undefined && core.scheduledGames !== scheduledGames) ||
    stored.scenarioCount !== FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS
  )
    throw invalid();
  const expectedProvenance = {
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    strategy: football.strategy,
    weeklyModelVersion: football.weeklyModelVersion ?? provenance.weeklyModelVersion,
    inputChecksum: football.inputChecksum,
    seedHash: hash(
      `${FIRST_PARTY_ROS_SEED_VERSION}|${metadata.seed}|${football.inputChecksum}|${football.playerId}|${football.strategy}|${season}|${football.asOfWeek}|${fullInput ? football.asOfAt : provenance.asOfAt}|${football.windowStartWeek}|${football.windowEndWeek}`,
    ),
    randomGenerator: "xoshiro128**-sha256-128",
    scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
    season,
    asOfWeek: football.asOfWeek,
    asOfAt: fullInput ? football.asOfAt : provenance.asOfAt,
    windowStartWeek: football.windowStartWeek,
    windowEndWeek: football.windowEndWeek,
    intervalCalibration: "simulation-only",
  };
  if (
    Object.hasOwn(provenance, "scoringProfileKey") ||
    Object.entries(expectedProvenance).some(([name, value]) => provenance[name] !== value)
  )
    throw invalid();
  const simulation = core.simulation;
  const diagnosticCodes = new Set([
    "simulation_interval_not_calibrated",
    "current_unavailability_persisted",
    "role_multiplier_bounded",
    "kicker_yardage_mean_bounded",
    "no_scheduled_games",
  ]);
  if (
    !Array.isArray(core.diagnostics) ||
    core.diagnostics.length > diagnosticCodes.size ||
    core.diagnostics.some(
      (diagnostic) =>
        !object(diagnostic) ||
        !["warning", "info"].includes(String(diagnostic.severity)) ||
        !diagnosticCodes.has(String(diagnostic.code)) ||
        typeof diagnostic.message !== "string" ||
        diagnostic.message.length > 2_048,
    )
  )
    throw invalid();
  for (const name of ["availabilityLagOneCorrelation", "roleLagOneCorrelation"]) {
    const value = simulation[name];
    if (
      value !== null &&
      (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1)
    )
      throw invalid();
  }
  if (
    !Number.isSafeInteger(simulation.boundedRoleSamples) ||
    (simulation.boundedRoleSamples as number) < 0 ||
    (simulation.boundedRoleSamples as number) >
      stored.scenarioCount * (football.windowEndWeek - football.windowStartWeek + 1)
  )
    throw invalid();
  return {
    schemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    scenarioCount: stored.scenarioCount,
    columns: stored.columns,
    games: stored.games,
    metadata: core as unknown as FirstPartyRosOutcomeEnsemble["metadata"],
  };
}

/** Validate each manifest reference against its complete immutable physical outcome identity. */
export function restoreCachedRosHistoricalOutcome(
  stored: RosOutcomeCacheEnsemble,
  key: RosOutcomeCacheKey,
  expected: RosHistoricalCachedOutcomeExpectation,
): FirstPartyRosOutcomeEnsemble {
  if (key.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION)
    throw new RosHistoricalOutcomeReplayError("outcome_evidence_corrupt", key.identity);
  return restoreEnsemble(stored, expected, key.identity);
}

/** Reprice a corpus reference without reconstructing historical weekly features or calibrations. */
export async function scoreCachedRosHistoricalOutcome(options: {
  readonly cache: RosOutcomeCache;
  readonly key: RosOutcomeCacheKey;
  readonly scoringProfile: ProjectionScoringProfile;
  readonly scenarioCount?: number;
  readonly expected: RosHistoricalCachedOutcomeExpectation;
  readonly signal?: AbortSignal;
}): Promise<FirstPartyRosOutcomeScore> {
  const { cache, signal } = options;
  signal?.throwIfAborted();
  const key = { ...options.key };
  const expected = { ...options.expected };
  const scoringProfile = rosProfileDefinitionFromKey(
    projectionScoringProfileKey(options.scoringProfile),
  ).profile;
  const scenarioCount = options.scenarioCount ?? FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
  if (key.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION)
    throw new RosHistoricalOutcomeReplayError("outcome_evidence_corrupt", key.identity);
  const read = await cache.read(key, {
    ...(signal ? { signal } : {}),
    expectedScenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  });
  signal?.throwIfAborted();
  if (read.state === "missing")
    throw new RosHistoricalOutcomeReplayError("outcome_evidence_not_ready", key.identity);
  if (read.state === "corrupt")
    throw new RosHistoricalOutcomeReplayError("outcome_evidence_corrupt", key.identity);
  return scoreFirstPartyRosOutcomes(
    restoreCachedRosHistoricalOutcome(read.ensemble, key, expected),
    scoringProfile,
    scenarioCount,
  );
}

interface BuildCoordinator {
  readonly inFlight: Map<string, Promise<FirstPartyRosOutcomeEnsemble>>;
  readonly queue: (() => void)[];
  active: number;
}
const coordinators = new WeakMap<RosOutcomeCache, BuildCoordinator>();

function scheduleBuild(
  coordinator: BuildCoordinator,
  build: () => Promise<FirstPartyRosOutcomeEnsemble>,
): Promise<FirstPartyRosOutcomeEnsemble> {
  return new Promise((resolve, reject) => {
    const run = () => {
      coordinator.active += 1;
      const finished = () => {
        coordinator.active -= 1;
        coordinator.queue.shift()?.();
      };
      void build().then(
        (result) => {
          finished();
          resolve(result);
        },
        (error: unknown) => {
          finished();
          reject(error instanceof Error ? error : new Error("ROS historical outcome build failed"));
        },
      );
    };
    if (coordinator.active < 2) run();
    else if (coordinator.queue.length < 2) coordinator.queue.push(run);
    else reject(new Error("ROS historical outcome build queue is full"));
  });
}

/**
 * Profile jobs must use replay mode; it can only rescore previously built evidence. Build mode
 * belongs to the separately serialized corpus-builder job. Single-flight and two-slot admission
 * protect one process/cache instance; the durable job queue must enforce one corpus builder
 * across processes. Completed vectors are not retained in memory.
 */
export function createRosHistoricalOutcomeEvaluator(options: {
  readonly cache: RosOutcomeCache;
  readonly mode: "build" | "replay";
  readonly signal?: AbortSignal;
  readonly simulate?: (
    input: FirstPartyRosOutcomeInput,
  ) => FirstPartyRosOutcomeEnsemble | Promise<FirstPartyRosOutcomeEnsemble>;
}): RosHistoricalOutcomeEvaluator {
  if (options.mode !== "build" && options.mode !== "replay")
    throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
  const { cache, signal } = options;
  const simulate = options.simulate ?? simulateFirstPartyRosOutcomes;
  let coordinator = coordinators.get(cache);
  if (!coordinator) {
    coordinator = { inFlight: new Map(), queue: [], active: 0 };
    coordinators.set(cache, coordinator);
  }
  const shared = coordinator;

  const load = async (
    football: FirstPartyRosOutcomeInput,
    key: RosOutcomeCacheKey,
  ): Promise<FirstPartyRosOutcomeEnsemble> => {
    signal?.throwIfAborted();
    const read = await cache.read(key, {
      ...(signal ? { signal } : {}),
      expectedScenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
    });
    signal?.throwIfAborted();
    if (read.state === "corrupt")
      throw new RosHistoricalOutcomeReplayError("outcome_evidence_corrupt", key.identity);
    if (read.state === "hit") return restoreEnsemble(read.ensemble, football, key.identity);
    if (options.mode === "replay")
      throw new RosHistoricalOutcomeReplayError("outcome_evidence_not_ready", key.identity);
    const outcome = await simulate(football);
    signal?.throwIfAborted();
    if (
      outcome.schemaVersion !== FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION ||
      outcome.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION
    )
      throw new RosHistoricalOutcomeReplayError("outcome_evidence_corrupt", key.identity);
    const stored: RosOutcomeCacheEnsemble = {
      scenarioCount: outcome.scenarioCount,
      columns: outcome.columns,
      games: outcome.games,
      metadata: {
        schemaVersion: outcome.schemaVersion,
        identity: key.identity,
        seed: football.seed,
        core: {
          ...outcome.metadata,
          diagnostics: outcome.metadata.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        },
      },
    };
    const restored = restoreEnsemble(stored, football, key.identity);
    // Validate the complete vector structure before committing. Zero rules cannot conceal NaN,
    // wrong games, a missing model/schema, or damaged columns in this structural pass.
    scoreFirstPartyRosOutcomes(restored, {
      id: "outcome-structure-check",
      rules: [{ statId: "receptions", points: 0 }],
    });
    await cache.write(key, stored, { ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    return restored;
  };

  return async (input) => {
    signal?.throwIfAborted();
    const scenarioCount = input.scenarioCount ?? FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
    if (
      !Number.isSafeInteger(scenarioCount) ||
      scenarioCount < FIRST_PARTY_ROS_MINIMUM_SCENARIOS ||
      scenarioCount > FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS ||
      scenarioCount % 2 !== 0
    )
      throw new RosHistoricalOutcomeReplayError("outcome_input_invalid");
    // Reject unsupported/nonlinear profiles before allowing any expensive build work.
    const scoringProfile = rosProfileDefinitionFromKey(
      projectionScoringProfileKey(input.scoringProfile),
    ).profile;
    const { football, key } = pinnedInput(input);
    let outcome: FirstPartyRosOutcomeEnsemble;
    if (options.mode === "replay") outcome = await load(football, key);
    else {
      let pending = shared.inFlight.get(key.identity);
      if (!pending) {
        pending = scheduleBuild(shared, () => load(football, key));
        shared.inFlight.set(key.identity, pending);
        const current = pending;
        void pending.then(
          () => {
            if (shared.inFlight.get(key.identity) === current) shared.inFlight.delete(key.identity);
          },
          () => {
            if (shared.inFlight.get(key.identity) === current) shared.inFlight.delete(key.identity);
          },
        );
      }
      outcome = await pending;
    }
    signal?.throwIfAborted();
    return scoreFirstPartyRosOutcomes(outcome, scoringProfile, scenarioCount);
  };
}
