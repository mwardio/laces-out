import type { PlayerId } from "./ids.js";

export interface ProjectionValue {
  readonly mean: number;
  readonly floor: number;
  readonly ceiling: number;
}

export interface PlayerProjection extends ProjectionValue {
  readonly playerId: PlayerId;
  readonly horizon: string;
  readonly asOf: string;
  readonly source: string;
  readonly confidence?: number;
  readonly standardDeviation?: number;
  readonly modelVersion?: string;
}

export type ProjectionMetric = keyof ProjectionValue;
export type ProjectionLookup =
  ReadonlyMap<string, ProjectionValue> | Readonly<Record<string, ProjectionValue | undefined>>;

function isProjectionMap(value: ProjectionLookup): value is ReadonlyMap<string, ProjectionValue> {
  return value instanceof Map;
}

export function createProjection(projection: PlayerProjection): PlayerProjection {
  const values = [projection.floor, projection.mean, projection.ceiling];
  if (!values.every(Number.isFinite)) {
    throw new TypeError("Projection values must be finite numbers");
  }
  if (projection.floor > projection.mean || projection.mean > projection.ceiling) {
    throw new RangeError("Projection must satisfy floor <= mean <= ceiling");
  }
  if (
    projection.confidence !== undefined &&
    (projection.confidence < 0 ||
      projection.confidence > 1 ||
      !Number.isFinite(projection.confidence))
  ) {
    throw new RangeError("Projection confidence must be between zero and one");
  }
  if (
    projection.standardDeviation !== undefined &&
    (!Number.isFinite(projection.standardDeviation) || projection.standardDeviation < 0)
  ) {
    throw new RangeError("Projection standard deviation must be a non-negative finite number");
  }

  return Object.freeze({ ...projection });
}

export function projectionFor(
  projections: ProjectionLookup,
  id: PlayerId,
): ProjectionValue | undefined {
  if (isProjectionMap(projections)) {
    return projections.get(id);
  }

  return projections[id];
}

export function projectionScore(
  projections: ProjectionLookup,
  id: PlayerId,
  metric: ProjectionMetric,
): number | undefined {
  return projectionFor(projections, id)?.[metric];
}
