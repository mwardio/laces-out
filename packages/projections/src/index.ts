export * from "./projection-import.js";
export * from "./scoring.js";
export * from "./first-party.js";
export * from "./rest-of-season.js";
export * from "./league-scoring.js";

import {
  projectionScoringProfileKey,
  projectionScoringProfilesAreCompatible,
  scoreProjectionStatComponents,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "./scoring.js";

export type ProjectionHorizon =
  | { readonly kind: "week"; readonly season: number; readonly week: number }
  | { readonly kind: "rest-of-season"; readonly season: number }
  | { readonly kind: "full-season"; readonly season: number };

interface ProjectionObservationBase {
  readonly playerId: string;
  readonly sourceId: string;
  /** Sources known to be mirrored or derivative must share an independence key. */
  readonly independenceKey?: string;
  readonly weight?: number;
  readonly fetchedAt: Date;
}

/**
 * Compatibility shape for existing callers. New adapters must use an explicitly scoped points or
 * stat-component observation instead. Legacy observations can blend only with other legacy data.
 */
export interface LegacyPointProjectionObservation extends ProjectionObservationBase {
  readonly kind?: never;
  readonly points: number;
  readonly floor?: number;
  readonly ceiling?: number;
  readonly sourceVersion?: never;
  readonly horizon?: never;
  readonly asOf?: never;
  readonly scoringProfile?: never;
}

interface ScopedProjectionObservationBase extends ProjectionObservationBase {
  readonly sourceVersion: string;
  readonly horizon: ProjectionHorizon;
  /** When the source published or observed this forecast. */
  readonly asOf: Date;
}

/** A points-only forecast tied to the exact scoring profile used by its source. */
export interface PointProjectionObservation extends ScopedProjectionObservationBase {
  readonly kind: "points";
  readonly points: number;
  readonly floor?: number;
  readonly ceiling?: number;
  readonly scoringProfile: ProjectionScoringProfile;
}

/** A scoring-independent forecast that can be recalculated for each league. */
export interface StatComponentProjectionObservation extends ScopedProjectionObservationBase {
  readonly kind: "stat-components";
  readonly components: ProjectionStatComponents;
  readonly floorComponents?: ProjectionStatComponents;
  readonly ceilingComponents?: ProjectionStatComponents;
}

export type ProjectionObservation =
  | LegacyPointProjectionObservation
  | PointProjectionObservation
  | StatComponentProjectionObservation;

export interface ProjectionConsensus {
  readonly playerId: string;
  readonly points: number;
  readonly floor: number;
  readonly ceiling: number;
  readonly sourceCount: number;
  readonly sourceIds: readonly string[];
  readonly disagreement: number;
  readonly confidence: number;
  readonly freshestAt: Date;
  readonly horizon?: ProjectionHorizon;
  readonly scoringProfile?: ProjectionScoringProfile;
  /** Stable grouping key for the horizon and scoring behavior represented by this result. */
  readonly compatibilityKey: string;
}

export interface ProjectionConsensusOptions {
  /** Required to score raw components and to combine them with compatible points-only forecasts. */
  readonly scoringProfile?: ProjectionScoringProfile;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
}

export function weightedMedian(
  values: readonly { readonly value: number; readonly weight: number }[],
): number {
  if (values.length === 0) {
    throw new RangeError("weightedMedian requires at least one value");
  }

  const ordered = values
    .map(({ value, weight }) => {
      assertFinite(value, "value");
      assertFinite(weight, "weight");
      if (weight <= 0) throw new RangeError("weight must be greater than zero");
      return { value, weight };
    })
    .sort((left, right) => left.value - right.value);

  const totalWeight = ordered.reduce((total, item) => total + item.weight, 0);
  const midpoint = totalWeight / 2;
  let cumulative = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (!item) continue;
    cumulative += item.weight;
    if (cumulative === midpoint) {
      const next = ordered[index + 1];
      return next ? (item.value + next.value) / 2 : item.value;
    }
    if (cumulative > midpoint) return item.value;
  }

  return ordered.at(-1)?.value ?? 0;
}

function weightedMean(
  values: readonly { readonly value: number; readonly weight: number }[],
): number {
  const weight = values.reduce((sum, item) => sum + item.weight, 0);
  return values.reduce((sum, item) => sum + item.value * item.weight, 0) / weight;
}

function weightedStandardDeviation(
  values: readonly { readonly value: number; readonly weight: number }[],
): number {
  const mean = weightedMean(values);
  const totalWeight = values.reduce((sum, item) => sum + item.weight, 0);
  const variance =
    values.reduce((sum, item) => sum + item.weight * (item.value - mean) ** 2, 0) / totalWeight;
  return Math.sqrt(variance);
}

function horizonKey(horizon: ProjectionHorizon | undefined): string {
  if (horizon === undefined) return "unscoped";
  if (horizon.kind === "week") return `week:${horizon.season}:${horizon.week}`;
  return `${horizon.kind}:${horizon.season}`;
}

function validateHorizon(horizon: ProjectionHorizon | undefined): void {
  if (horizon === undefined) return;
  if (!Number.isSafeInteger(horizon.season) || horizon.season <= 0) {
    throw new RangeError("projection horizon season must be a positive integer");
  }
  if (horizon.kind === "week" && (!Number.isSafeInteger(horizon.week) || horizon.week <= 0)) {
    throw new RangeError("projection horizon week must be a positive integer");
  }
}

function horizonsAreEqual(
  left: ProjectionHorizon | undefined,
  right: ProjectionHorizon | undefined,
): boolean {
  return horizonKey(left) === horizonKey(right);
}

interface ResolvedProjectionObservation {
  readonly playerId: string;
  readonly sourceId: string;
  readonly independenceKey: string;
  readonly sourceVersion?: string;
  readonly points: number;
  readonly floor?: number;
  readonly ceiling?: number;
  readonly weight: number;
  readonly horizon?: ProjectionHorizon;
  readonly scoringProfile?: ProjectionScoringProfile;
  readonly scoringKey: string;
  readonly asOf?: Date;
  readonly fetchedAt: Date;
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new TypeError(`${label} must be a valid date`);
}

function scoringKeyForPointObservation(
  observation: LegacyPointProjectionObservation | PointProjectionObservation,
  targetProfile: ProjectionScoringProfile | undefined,
): { readonly key: string; readonly profile?: ProjectionScoringProfile } {
  if (observation.scoringProfile === undefined) {
    if (targetProfile !== undefined) {
      throw new Error(
        `Points-only projection from ${observation.sourceId} has no scoring profile and cannot be used for the target league`,
      );
    }
    return { key: "legacy-unscoped" };
  }

  if (
    targetProfile !== undefined &&
    !projectionScoringProfilesAreCompatible(observation.scoringProfile, targetProfile)
  ) {
    throw new Error(
      `Points-only projection from ${observation.sourceId} uses an incompatible scoring profile`,
    );
  }

  const profile = targetProfile ?? observation.scoringProfile;
  return { key: projectionScoringProfileKey(profile), profile };
}

function resolveObservation(
  observation: ProjectionObservation,
  targetProfile: ProjectionScoringProfile | undefined,
): ResolvedProjectionObservation {
  if (observation.playerId.trim().length === 0) {
    throw new TypeError("projection playerId must not be empty");
  }
  if (observation.sourceId.trim().length === 0) {
    throw new TypeError("projection sourceId must not be empty");
  }
  if (observation.independenceKey?.trim().length === 0) {
    throw new TypeError("projection independenceKey must not be empty");
  }
  if (observation.sourceVersion?.trim().length === 0) {
    throw new TypeError("projection sourceVersion must not be empty");
  }
  validateHorizon(observation.horizon);
  assertValidDate(observation.fetchedAt, "projection fetchedAt");
  if (observation.asOf !== undefined) assertValidDate(observation.asOf, "projection asOf");
  const weight = observation.weight ?? 1;
  assertFinite(weight, "weight");
  if (weight <= 0) throw new RangeError("weight must be greater than zero");

  const shared = {
    playerId: observation.playerId,
    sourceId: observation.sourceId,
    independenceKey: observation.independenceKey ?? observation.sourceId,
    ...(observation.sourceVersion === undefined
      ? {}
      : { sourceVersion: observation.sourceVersion }),
    weight,
    ...(observation.horizon === undefined ? {} : { horizon: observation.horizon }),
    ...(observation.asOf === undefined ? {} : { asOf: observation.asOf }),
    fetchedAt: observation.fetchedAt,
  };

  if (observation.kind === "stat-components") {
    if (targetProfile === undefined) {
      throw new Error(
        `Stat-component projection from ${observation.sourceId} requires a target scoring profile`,
      );
    }
    const points = scoreProjectionStatComponents(observation.components, targetProfile);
    const floor =
      observation.floorComponents === undefined
        ? undefined
        : scoreProjectionStatComponents(observation.floorComponents, targetProfile);
    const ceiling =
      observation.ceilingComponents === undefined
        ? undefined
        : scoreProjectionStatComponents(observation.ceilingComponents, targetProfile);
    if (floor !== undefined && floor > points) {
      throw new RangeError("Scored projection floor cannot exceed its mean");
    }
    if (ceiling !== undefined && ceiling < points) {
      throw new RangeError("Scored projection ceiling cannot be less than its mean");
    }
    return {
      ...shared,
      points,
      ...(floor === undefined ? {} : { floor }),
      ...(ceiling === undefined ? {} : { ceiling }),
      scoringProfile: targetProfile,
      scoringKey: projectionScoringProfileKey(targetProfile),
    };
  }

  assertFinite(observation.points, "projection points");
  if (observation.floor !== undefined) assertFinite(observation.floor, "projection floor");
  if (observation.ceiling !== undefined) assertFinite(observation.ceiling, "projection ceiling");
  if (observation.floor !== undefined && observation.floor > observation.points) {
    throw new RangeError("Projection floor cannot exceed its mean");
  }
  if (observation.ceiling !== undefined && observation.ceiling < observation.points) {
    throw new RangeError("Projection ceiling cannot be less than its mean");
  }
  const scoring = scoringKeyForPointObservation(observation, targetProfile);
  return {
    ...shared,
    points: observation.points,
    ...(observation.floor === undefined ? {} : { floor: observation.floor }),
    ...(observation.ceiling === undefined ? {} : { ceiling: observation.ceiling }),
    ...(scoring.profile === undefined ? {} : { scoringProfile: scoring.profile }),
    scoringKey: scoring.key,
  };
}

function stableObservationKey(observation: ResolvedProjectionObservation): string {
  return JSON.stringify({
    playerId: observation.playerId,
    sourceId: observation.sourceId,
    sourceVersion: observation.sourceVersion ?? "",
    points: observation.points,
    floor: observation.floor ?? null,
    ceiling: observation.ceiling ?? null,
    weight: observation.weight,
    asOf: observation.asOf?.toISOString() ?? "",
    fetchedAt: observation.fetchedAt.toISOString(),
  });
}

function compareObservationRecency(
  left: ResolvedProjectionObservation,
  right: ResolvedProjectionObservation,
): number {
  const asOfDifference = (left.asOf?.getTime() ?? -Infinity) - (right.asOf?.getTime() ?? -Infinity);
  if (asOfDifference !== 0) return asOfDifference;
  const fetchedDifference = left.fetchedAt.getTime() - right.fetchedAt.getTime();
  if (fetchedDifference !== 0) return fetchedDifference;
  return stableObservationKey(left).localeCompare(stableObservationKey(right));
}

function deduplicateIndependentSources(
  observations: readonly ResolvedProjectionObservation[],
): readonly ResolvedProjectionObservation[] {
  const selected = new Map<string, ResolvedProjectionObservation>();
  for (const observation of observations) {
    const current = selected.get(observation.independenceKey);
    if (current === undefined || compareObservationRecency(observation, current) > 0) {
      selected.set(observation.independenceKey, observation);
    }
  }
  return [...selected.values()].sort((left, right) =>
    compareStrings(left.independenceKey, right.independenceKey),
  );
}

function compatibilityKeyFor(observation: ResolvedProjectionObservation): string {
  return `${horizonKey(observation.horizon)}|${observation.scoringKey}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function representativeScoringProfile(
  observations: readonly ResolvedProjectionObservation[],
  targetProfile: ProjectionScoringProfile | undefined,
): ProjectionScoringProfile | undefined {
  if (targetProfile !== undefined) return targetProfile;
  return observations
    .flatMap((observation) =>
      observation.scoringProfile === undefined ? [] : [observation.scoringProfile],
    )
    .sort((left, right) =>
      compareStrings(
        JSON.stringify({
          id: left.id,
          version: left.version ?? "",
          label: left.label ?? "",
          semanticKey: projectionScoringProfileKey(left),
        }),
        JSON.stringify({
          id: right.id,
          version: right.version ?? "",
          label: right.label ?? "",
          semanticKey: projectionScoringProfileKey(right),
        }),
      ),
    )[0];
}

/**
 * Returns the horizon/scoring key used to decide whether an observation can enter a consensus.
 * Raw observations require a target profile; legacy unscoped points receive their own key.
 */
export function projectionObservationCompatibilityKey(
  observation: ProjectionObservation,
  options: ProjectionConsensusOptions = {},
): string {
  return compatibilityKeyFor(resolveObservation(observation, options.scoringProfile));
}

/** Throws when observations cannot be scored and blended without changing their meaning. */
export function validateProjectionObservationCompatibility(
  observations: readonly ProjectionObservation[],
  options: ProjectionConsensusOptions = {},
): void {
  if (observations.length === 0) {
    throw new RangeError("At least one projection observation is required");
  }
  const keys = observations.map((observation) =>
    projectionObservationCompatibilityKey(observation, options),
  );
  if (keys.some((key) => key !== keys[0])) {
    throw new Error("Projection observations have incompatible horizons or scoring profiles");
  }
}

/**
 * Builds an intentionally transparent consensus. The weighted median limits the
 * influence of an outlier source; disagreement directly lowers confidence.
 */
export function buildProjectionConsensus(
  observations: readonly ProjectionObservation[],
  options: ProjectionConsensusOptions = {},
): ProjectionConsensus {
  if (observations.length === 0) {
    throw new RangeError("At least one projection observation is required");
  }

  const playerId = observations[0]?.playerId;
  if (!playerId || observations.some((observation) => observation.playerId !== playerId)) {
    throw new Error("All projection observations must refer to the same player");
  }

  const resolved = observations.map((observation) =>
    resolveObservation(observation, options.scoringProfile),
  );
  const first = resolved[0];
  if (!first) throw new RangeError("At least one projection observation is required");
  if (resolved.some((observation) => !horizonsAreEqual(observation.horizon, first.horizon))) {
    throw new Error("Projection observations with different horizons cannot be blended");
  }
  if (resolved.some((observation) => observation.scoringKey !== first.scoringKey)) {
    throw new Error("Projection observations with incompatible scoring profiles cannot be blended");
  }
  const independent = deduplicateIndependentSources(resolved);
  const scoringProfile = representativeScoringProfile(independent, options.scoringProfile);

  const points = independent.map((observation) => ({
    value: observation.points,
    weight: observation.weight,
  }));
  const center = weightedMedian(points);
  const disagreement = weightedStandardDeviation(points);
  const explicitFloors = independent.flatMap((observation) =>
    observation.floor === undefined
      ? []
      : [{ value: observation.floor, weight: observation.weight }],
  );
  const explicitCeilings = independent.flatMap((observation) =>
    observation.ceiling === undefined
      ? []
      : [{ value: observation.ceiling, weight: observation.weight }],
  );
  const derivedSpread = Math.max(2, disagreement * 1.5, Math.abs(center) * 0.2);
  const sourceFactor = Math.min(1, independent.length / 3);
  const disagreementPenalty = 1 / (1 + disagreement / Math.max(5, Math.abs(center)));

  return {
    playerId,
    points: center,
    floor:
      explicitFloors.length > 0
        ? weightedMedian(explicitFloors)
        : Math.max(0, center - derivedSpread),
    ceiling:
      explicitCeilings.length > 0 ? weightedMedian(explicitCeilings) : center + derivedSpread,
    sourceCount: independent.length,
    sourceIds: [...new Set(independent.map((observation) => observation.sourceId))].sort(
      compareStrings,
    ),
    disagreement,
    confidence: Math.max(0, Math.min(1, sourceFactor * disagreementPenalty)),
    freshestAt: new Date(
      Math.max(...independent.map((observation) => observation.fetchedAt.getTime())),
    ),
    ...(first.horizon === undefined ? {} : { horizon: first.horizon }),
    ...(scoringProfile === undefined ? {} : { scoringProfile }),
    compatibilityKey: compatibilityKeyFor(first),
  };
}

export function groupProjectionConsensus(
  observations: readonly ProjectionObservation[],
  options: ProjectionConsensusOptions = {},
): readonly ProjectionConsensus[] {
  const grouped = new Map<string, ProjectionObservation[]>();
  for (const observation of observations) {
    const resolved = resolveObservation(observation, options.scoringProfile);
    const key = JSON.stringify([observation.playerId, compatibilityKeyFor(resolved)]);
    const group = grouped.get(key) ?? [];
    group.push(observation);
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, group]) => buildProjectionConsensus(group, options));
}
