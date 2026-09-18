import { createHash } from "node:crypto";
import {
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MINIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  firstPartyRosSeedHash,
  projectFirstPartyRestOfSeason,
  projectionScoringProfileKey,
  rosProfileDefinitionFromKey,
  scoreFirstPartyRosOutcomes,
  SCORING_LONG_TOUCHDOWN_COMPONENTS,
  type FirstPartyRosOutcomeEnsemble,
  type FirstPartyRosProjectionInput,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import {
  ROS_OUTCOME_CACHE_LIMITS,
  type RosOutcomeCache,
  type RosOutcomeCacheEnsemble,
  type RosOutcomeCacheJson,
  type RosOutcomeCacheKey,
} from "./ros-outcome-cache.js";
import type { FirstPartyRosLiveProjection } from "./ros-live-projection.js";

/** LIVE only. Historical outcome identities and numerical simulation versions are unchanged. */
export const ROS_LIVE_OUTCOME_VERSION = "live-aggregate-joint-outcomes-v2";
export const ROS_LIVE_OUTCOME_CACHE_LIMITS = Object.freeze({ ...ROS_OUTCOME_CACHE_LIMITS });
const NEUTRAL_PROFILE: ProjectionScoringProfile = {
  id: "laces-out-live-neutral-v1",
  rules: [{ statId: "receptions", points: 0 }],
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const fail = (): never => {
  throw new Error("Live ROS outcome evidence is invalid or incomplete");
};

function canonical(value: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 40_000 || depth > 20) return fail();
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number") return finite(item) ? JSON.stringify(item) : fail();
    if (typeof item !== "object" || ancestors.has(item)) return fail();
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) result = `[${item.map((child) => visit(child, depth + 1)).join(",")}]`;
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        return fail();
      result = `{${Object.entries(item)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${visit(child, depth + 1)}`)
        .join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > 512 * 1_024) return fail();
  return result;
}

type Football = Omit<FirstPartyRosProjectionInput, "scoringProfile"> & { scenarioCount: number };
interface Manifest {
  version: typeof ROS_LIVE_OUTCOME_VERSION;
  identity: string;
  neutral: FirstPartyRosLiveProjection;
}

function pin(input: FirstPartyRosProjectionInput) {
  const { scoringProfile, ...rest } = input;
  // Raw weekly thresholds cannot be applied to aggregate season totals. Accepted normalized
  // league bonuses are additive modeled components and pass this same exact-profile contract.
  const profile = structuredClone(scoringProfile);
  rosProfileDefinitionFromKey(projectionScoringProfileKey(profile));
  const serialized = canonical({
    ...rest,
    scenarioCount: input.scenarioCount ?? FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  });
  const football = JSON.parse(serialized) as Football;
  if (
    !Number.isSafeInteger(football.scenarioCount) ||
    football.scenarioCount < FIRST_PARTY_ROS_MINIMUM_SCENARIOS ||
    football.scenarioCount > FIRST_PARTY_ROS_MAXIMUM_SCENARIOS ||
    football.scenarioCount % 2 !== 0 ||
    !Array.isArray(football.weeks) ||
    football.weeks.length < 1 ||
    football.weeks.length > 18
  )
    return fail();
  const weeks = [...(football.weeks as FirstPartyRosProjectionInput["weeks"])].sort(
    (a, b) => a.week - b.week,
  );
  // Mirror the engine's scoring-dependent source-coverage guard on cache hits as well as misses.
  const scheduled = weeks.filter((week) => week.scheduled);
  for (const { total, fortyPlus, fiftyPlus } of SCORING_LONG_TOUCHDOWN_COMPONENTS) {
    const known = scheduled.filter(
      (week) => week.contextualComponents[fortyPlus] !== undefined,
    ).length;
    const priced =
      scheduled.some((week) => week.contextualComponents[total] !== undefined) &&
      profile.rules.some(
        (rule) => rule.points !== 0 && (rule.statId === fortyPlus || rule.statId === fiftyPlus),
      );
    if ((known > 0 || priced) && known !== scheduled.length) return fail();
  }
  return {
    football,
    weeks,
    profile,
    key: {
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      identity: hash(
        canonical({
          version: ROS_LIVE_OUTCOME_VERSION,
          outcomeSchemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
          modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          football,
        }),
      ),
    },
  };
}

/** Includes cutoff and exact path count. Caller owns the stable coherent live-football cutoff. */
export function rosLiveOutcomeCacheKey(input: FirstPartyRosProjectionInput): RosOutcomeCacheKey {
  return pin(input).key;
}

function capture(
  pinned: ReturnType<typeof pin>,
  simulate: typeof projectFirstPartyRestOfSeason,
): RosOutcomeCacheEnsemble {
  const { football, key } = pinned;
  const columns: Record<string, Float64Array> = Object.create(null) as Record<string, Float64Array>;
  const seen = new Uint8Array(football.scenarioCount);
  const games = new Uint8Array(football.scenarioCount);
  const allocate = (name: string) => {
    if (
      !/^[a-z][a-z0-9_]{0,127}$/u.test(name) ||
      Object.keys(columns).length >= ROS_LIVE_OUTCOME_CACHE_LIMITS.maximumColumns
    )
      return fail();
    const values = new Float64Array(football.scenarioCount);
    columns[name] = values;
    return values;
  };
  const projected = simulate({ ...football, scoringProfile: NEUTRAL_PROFILE }, (scenario) => {
    if (
      !Number.isSafeInteger(scenario.index) ||
      scenario.index < 0 ||
      scenario.index >= football.scenarioCount ||
      seen[scenario.index] ||
      !Number.isSafeInteger(scenario.games) ||
      scenario.games < 0 ||
      scenario.games > football.weeks.length
    )
      fail();
    seen[scenario.index] = 1;
    games[scenario.index] = scenario.games;
    for (const [name, value] of Object.entries(scenario.components)) {
      if (!finite(value)) fail();
      const column = columns[name] ?? allocate(name);
      column[scenario.index] = value;
    }
  });
  if (seen.some((value) => value !== 1)) fail();
  // These zeros are established by the engine, including entirely unavailable or bye windows.
  for (const name of Object.keys(projected.expectedComponents)) if (!columns[name]) allocate(name);
  const neutral: FirstPartyRosLiveProjection = {
    ...projected,
    // Aggregate vectors cannot reproduce weekly point quantiles. Persist only the physical
    // weekly availability consumed by publication; do not fabricate weekly point estimates.
    weekly: projected.weekly.map(({ week, scheduled, bye, availabilityProbability }) => ({
      week,
      scheduled,
      bye,
      availabilityProbability,
    })),
  };
  const metadata: Manifest = { version: ROS_LIVE_OUTCOME_VERSION, identity: key.identity, neutral };
  return {
    scenarioCount: football.scenarioCount,
    games,
    columns,
    metadata: metadata as unknown as Record<string, RosOutcomeCacheJson>,
  };
}

function restore(
  stored: RosOutcomeCacheEnsemble,
  pinned: ReturnType<typeof pin>,
): {
  neutral: FirstPartyRosLiveProjection;
  outcomes: FirstPartyRosOutcomeEnsemble;
} {
  const { football, weeks, key } = pinned;
  const value = stored.metadata;
  if (
    !object(value) ||
    canonical(Object.keys(value).sort()) !== canonical(["identity", "neutral", "version"]) ||
    value.version !== ROS_LIVE_OUTCOME_VERSION ||
    value.identity !== key.identity ||
    !object(value.neutral)
  )
    return fail();
  const neutral = value.neutral as unknown as FirstPartyRosLiveProjection;
  const expectedProvenance = {
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    strategy: football.strategy,
    weeklyModelVersion: football.weeklyModelVersion,
    scoringProfileKey: projectionScoringProfileKey(NEUTRAL_PROFILE),
    inputChecksum: football.inputChecksum,
    seedHash: firstPartyRosSeedHash(football),
    randomGenerator: "xoshiro128**-sha256-128",
    scenarioCount: football.scenarioCount,
    season: football.season,
    asOfWeek: football.asOfWeek,
    asOfAt: football.asOfAt,
    windowStartWeek: football.windowStartWeek,
    windowEndWeek: football.windowEndWeek,
    intervalCalibration: "simulation-only",
  };
  const scheduledGames = weeks.filter((week) => week.scheduled).length;
  if (
    stored.scenarioCount !== football.scenarioCount ||
    !(stored.games instanceof Uint8Array) ||
    stored.games.length !== football.scenarioCount ||
    stored.games.some((value) => value > scheduledGames) ||
    !object(stored.columns) ||
    Object.keys(stored.columns).length < 1 ||
    Object.keys(stored.columns).length > ROS_LIVE_OUTCOME_CACHE_LIMITS.maximumColumns ||
    canonical(neutral.provenance) !== canonical(expectedProvenance) ||
    neutral.playerId !== football.playerId ||
    neutral.position !== football.position ||
    neutral.scheduledGames !== scheduledGames ||
    neutral.state !== (scheduledGames === 0 ? "unavailable" : "projected") ||
    !finite(neutral.expectedGames) ||
    neutral.expectedGames < 0 ||
    neutral.expectedGames > scheduledGames ||
    [...stored.games].reduce((sum, games) => sum + games, 0) / stored.scenarioCount !==
      neutral.expectedGames ||
    neutral.weeklyMeanSemantics !== "unconditional-includes-zero-for-bye-or-unavailable" ||
    !object(neutral.expectedComponents) ||
    canonical(Object.keys(neutral.expectedComponents).sort()) !==
      canonical(Object.keys(stored.columns).sort()) ||
    !Object.values(neutral.expectedComponents).every(finite) ||
    !Array.isArray(neutral.weekly) ||
    neutral.weekly.length !== weeks.length ||
    ![
      neutral.meanPoints,
      neutral.standardDeviation,
      neutral.p15Points,
      neutral.p50Points,
      neutral.p85Points,
    ].every((value) => value === 0)
  )
    return fail();
  for (const [name, column] of Object.entries(stored.columns)) {
    if (
      !/^[a-z][a-z0-9_]{0,127}$/u.test(name) ||
      !(column instanceof Float64Array) ||
      column.length !== stored.scenarioCount ||
      column.some((value) => !finite(value))
    )
      return fail();
    // Engine means accumulate weekly observations in antithetic order; scenario totals associate
    // additions differently. Retain the original exact mean and allow only rounding-scale drift.
    const center = column.reduce((sum, value) => sum + value, 0) / column.length;
    const expected = neutral.expectedComponents[name]!;
    if (Math.abs(center - expected) > 1e-9 * Math.max(1, Math.abs(expected))) return fail();
  }
  let expectedGames = 0;
  for (let index = 0; index < weeks.length; index += 1) {
    const week = (neutral.weekly as FirstPartyRosLiveProjection["weekly"])[index];
    const expected = weeks[index]!;
    if (
      !object(week) ||
      canonical(Object.keys(week).sort()) !==
        canonical(["availabilityProbability", "bye", "scheduled", "week"]) ||
      week.week !== expected.week ||
      week.scheduled !== expected.scheduled ||
      week.bye !== expected.bye ||
      !finite(week.availabilityProbability) ||
      week.availabilityProbability < 0 ||
      week.availabilityProbability > 1 ||
      (!week.scheduled && week.availabilityProbability !== 0) ||
      Math.abs(
        week.availabilityProbability * stored.scenarioCount -
          Math.round(week.availabilityProbability * stored.scenarioCount),
      ) > 1e-9
    )
      return fail();
    expectedGames += week.availabilityProbability;
  }
  if (
    Math.abs(expectedGames - neutral.expectedGames) > 1e-12 ||
    !object(neutral.simulation) ||
    !Number.isSafeInteger(neutral.simulation.boundedRoleSamples) ||
    neutral.simulation.boundedRoleSamples < 0 ||
    neutral.simulation.boundedRoleSamples > stored.scenarioCount * weeks.length ||
    [
      neutral.simulation.availabilityLagOneCorrelation,
      neutral.simulation.roleLagOneCorrelation,
    ].some((value) => value !== null && (!finite(value) || value < -1 || value > 1)) ||
    !Array.isArray(neutral.diagnostics) ||
    neutral.diagnostics.length > 10 ||
    !neutral.diagnostics.every(
      (diagnostic) =>
        object(diagnostic) &&
        typeof diagnostic.severity === "string" &&
        ["info", "warning"].includes(diagnostic.severity) &&
        typeof diagnostic.code === "string" &&
        [
          "simulation_interval_not_calibrated",
          "current_unavailability_persisted",
          "role_multiplier_bounded",
          "kicker_yardage_mean_bounded",
          "no_scheduled_games",
        ].includes(diagnostic.code) &&
        typeof diagnostic.message === "string" &&
        diagnostic.message.length <= 2_048,
    )
  )
    return fail();
  const { scoringProfileKey: ignored, ...provenance } = neutral.provenance;
  void ignored;
  return {
    neutral,
    outcomes: {
      schemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      scenarioCount: stored.scenarioCount,
      columns: stored.columns,
      games: stored.games,
      metadata: {
        playerId: neutral.playerId,
        position: neutral.position,
        scheduledGames: neutral.scheduledGames,
        provenance,
        simulation: neutral.simulation,
        diagnostics: neutral.diagnostics,
      },
    },
  };
}

function rescore(
  ready: ReturnType<typeof restore>,
  profile: ProjectionScoringProfile,
): FirstPartyRosLiveProjection {
  const scored = scoreFirstPartyRosOutcomes(ready.outcomes, profile);
  return {
    ...structuredClone(ready.neutral),
    expectedGames: scored.expectedGames,
    meanPoints: scored.meanPoints,
    standardDeviation: scored.standardDeviation,
    p15Points: scored.p15Points,
    p50Points: scored.p50Points,
    p85Points: scored.p85Points,
    provenance: { ...ready.neutral.provenance, scoringProfileKey: scored.scoringProfileKey },
  };
}

/** Durable aligned LIVE outcomes. Publication still requires exact-profile proof and calibration. */
export function createRosLiveOutcomeProjector(options: {
  readonly cache: RosOutcomeCache;
  readonly simulate?: typeof projectFirstPartyRestOfSeason;
  /** Snapshot the refresh's profiles; score at most32 while each forecast's vectors are loaded. */
  readonly profiles?: readonly ProjectionScoringProfile[];
  readonly maximumSummaryBytes?: number;
}): (input: FirstPartyRosProjectionInput) => Promise<FirstPartyRosLiveProjection> {
  const maximumSummaryBytes = options.maximumSummaryBytes ?? 128 * 1_024 * 1_024;
  if (
    !Number.isSafeInteger(maximumSummaryBytes) ||
    maximumSummaryBytes < 0 ||
    maximumSummaryBytes > 128 * 1_024 * 1_024
  )
    throw new RangeError("Invalid live ROS summary cache bound");
  const profiles = [
    ...new Map(
      (options.profiles ?? []).map((profile) => {
        const snapshot = structuredClone(profile);
        return [projectionScoringProfileKey(snapshot), snapshot] as const;
      }),
    ).entries(),
  ].sort(([left], [right]) => left.localeCompare(right));
  const summaries = new Map<string, { bytes: number; projection: FirstPartyRosLiveProjection }>();
  let summaryBytes = 0;
  const remember = (identity: string, projection: FirstPartyRosLiveProjection) => {
    const previous = summaries.get(identity);
    if (previous) {
      summaryBytes -= previous.bytes;
      summaries.delete(identity);
    }
    const bytes = Buffer.byteLength(JSON.stringify(projection));
    while (summaryBytes + bytes > maximumSummaryBytes && summaries.size > 0) {
      const [oldest, value] = summaries.entries().next().value!;
      summaries.delete(oldest);
      summaryBytes -= value.bytes;
    }
    if (bytes <= maximumSummaryBytes) {
      summaries.set(identity, { bytes, projection });
      summaryBytes += bytes;
    }
  };
  return async (input) => {
    const pinned = pin(input);
    const { key, football } = pinned;
    const profileKey = projectionScoringProfileKey(pinned.profile);
    const summaryIdentity = `${key.identity}:${profileKey}`;
    const cached = summaries.get(summaryIdentity);
    if (cached) {
      summaries.delete(summaryIdentity);
      summaries.set(summaryIdentity, cached);
      return structuredClone(cached.projection);
    }
    const stored = await options.cache.read(key, { expectedScenarioCount: football.scenarioCount });
    if (stored.state === "corrupt") return fail();
    const ensemble =
      stored.state === "hit"
        ? stored.ensemble
        : capture(pinned, options.simulate ?? projectFirstPartyRestOfSeason);
    const ready = restore(ensemble, pinned);
    if (stored.state === "missing") await options.cache.write(key, ensemble);
    const projection = rescore(ready, pinned.profile);
    const index = profiles.findIndex(([candidate]) => candidate === profileKey);
    if (index >= 0 && maximumSummaryBytes > 0) {
      const start = Math.floor(index / 32) * 32;
      for (const [candidate, profile] of profiles.slice(start, start + 32)) {
        if (candidate === profileKey) continue;
        // An incompatible profile's coverage cannot poison this requested profile's valid result.
        // Requested incompatible profiles independently reject before any cache lookup.
        try {
          pin({ ...football, scoringProfile: profile });
          remember(`${key.identity}:${candidate}`, rescore(ready, profile));
        } catch {
          continue;
        }
      }
    }
    remember(summaryIdentity, projection);
    return structuredClone(projection);
  };
}
