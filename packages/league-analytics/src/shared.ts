export const ANALYTICS_EPSILON = 1e-9;

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly definition: string;
}

export function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
}

export function assertNonNegative(value: number, label: string): void {
  assertFinite(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must be greater than or equal to zero`);
  }
}

export function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique`);
  }
  if (values.some((value) => value.trim().length === 0)) {
    throw new Error(`${label} cannot contain an empty value`);
  }
}

export function compareNumbers(
  left: number,
  right: number,
  tolerance = ANALYTICS_EPSILON,
): -1 | 0 | 1 {
  if (left > right + tolerance) return 1;
  if (right > left + tolerance) return -1;
  return 0;
}

export function safeRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function populationStandardDeviation(values: readonly number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * A midrank percentile on a 0-100 scale. The weakest distinct value is 0 and
 * the strongest is 100; ties receive the same midpoint. A one-item sample is 50.
 */
export function strengthPercentile(
  value: number,
  values: readonly number[],
  higherIsBetter: boolean,
): number {
  if (values.length <= 1) return 50;
  const direction = higherIsBetter ? 1 : -1;
  const oriented = value * direction;
  let weaker = 0;

  for (const candidate of values) {
    const comparison = compareNumbers(oriented, candidate * direction);
    if (comparison > 0) weaker += 1;
  }

  // Comparing the numeric value cannot distinguish the current observation
  // from equal observations, so count every equal and remove one self item.
  const equalCount = values.filter(
    (candidate) => compareNumbers(oriented, candidate * direction) === 0,
  ).length;
  const tiedOther = Math.max(0, equalCount - 1);
  return ((weaker + tiedOther / 2) / (values.length - 1)) * 100;
}

export function sortedUniqueNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
