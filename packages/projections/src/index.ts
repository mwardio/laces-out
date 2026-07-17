export * from "./projection-import.js";

export type ProjectionHorizon =
  | { readonly kind: "week"; readonly season: number; readonly week: number }
  | { readonly kind: "rest-of-season"; readonly season: number }
  | { readonly kind: "full-season"; readonly season: number };

export interface ProjectionObservation {
  readonly playerId: string;
  readonly sourceId: string;
  readonly points: number;
  readonly floor?: number;
  readonly ceiling?: number;
  readonly weight?: number;
  readonly fetchedAt: Date;
}

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

/**
 * Builds an intentionally transparent consensus. The weighted median limits the
 * influence of an outlier source; disagreement directly lowers confidence.
 */
export function buildProjectionConsensus(
  observations: readonly ProjectionObservation[],
): ProjectionConsensus {
  if (observations.length === 0) {
    throw new RangeError("At least one projection observation is required");
  }

  const playerId = observations[0]?.playerId;
  if (!playerId || observations.some((observation) => observation.playerId !== playerId)) {
    throw new Error("All projection observations must refer to the same player");
  }

  const points = observations.map((observation) => ({
    value: observation.points,
    weight: observation.weight ?? 1,
  }));
  const center = weightedMedian(points);
  const disagreement = weightedStandardDeviation(points);
  const explicitFloors = observations.flatMap((observation) =>
    observation.floor === undefined
      ? []
      : [{ value: observation.floor, weight: observation.weight ?? 1 }],
  );
  const explicitCeilings = observations.flatMap((observation) =>
    observation.ceiling === undefined
      ? []
      : [{ value: observation.ceiling, weight: observation.weight ?? 1 }],
  );
  const derivedSpread = Math.max(2, disagreement * 1.5, Math.abs(center) * 0.2);
  const sourceFactor = Math.min(1, observations.length / 3);
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
    sourceCount: observations.length,
    sourceIds: [...new Set(observations.map((observation) => observation.sourceId))].sort(),
    disagreement,
    confidence: Math.max(0, Math.min(1, sourceFactor * disagreementPenalty)),
    freshestAt: new Date(
      Math.max(...observations.map((observation) => observation.fetchedAt.getTime())),
    ),
  };
}

export function groupProjectionConsensus(
  observations: readonly ProjectionObservation[],
): readonly ProjectionConsensus[] {
  const grouped = new Map<string, ProjectionObservation[]>();
  for (const observation of observations) {
    const group = grouped.get(observation.playerId) ?? [];
    group.push(observation);
    grouped.set(observation.playerId, group);
  }
  return [...grouped.values()].map(buildProjectionConsensus);
}
