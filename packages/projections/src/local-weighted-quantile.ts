/** Exact arithmetic over the positive binary64 weights actually computed by the local kernel. */
const view = new DataView(new ArrayBuffer(8));
const MAX_ATOMS = 20_000;

export function localWeightMasses(weights: readonly number[]): readonly bigint[] {
  if (!Array.isArray(weights) || weights.length < 1 || weights.length > MAX_ATOMS)
    throw new RangeError("Local weight count is outside its bound");
  const parts = weights.map((weight: number) => {
    if (!Number.isFinite(weight) || weight <= 0)
      throw new RangeError("Local weights must be finite and strictly positive");
    view.setFloat64(0, weight, false);
    const bits = view.getBigUint64(0, false);
    const exponent = Number((bits >> 52n) & 2047n);
    return {
      mantissa: (bits & ((1n << 52n) - 1n)) + (exponent === 0 ? 0n : 1n << 52n),
      exponent: exponent === 0 ? -1074 : exponent - 1023 - 52,
    };
  });
  const commonExponent = Math.min(...parts.map((part) => part.exponent));
  return parts.map((part) => part.mantissa << BigInt(part.exponent - commonExponent));
}

/** Correctly round a bounded nonnegative rational to binary64 without overflowing its integers. */
export function localRationalNumber(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n || denominator <= 0n)
    throw new RangeError("Local rational must be nonnegative with a positive denominator");
  if (numerator === 0n) return 0;
  const nBits = numerator.toString(2).length;
  const dBits = denominator.toString(2).length;
  if (nBits > 8192 || dBits > 8192) throw new RangeError("Local rational exceeds its bit bound");
  let exponent = nBits - dBits;
  if (
    exponent >= 0
      ? numerator < denominator << BigInt(exponent)
      : numerator << BigInt(-exponent) < denominator
  )
    exponent -= 1;
  if (exponent > 1023) throw new RangeError("Local rational overflows binary64");
  const quantum = Math.max(exponent - 52, -1074);
  const n = quantum <= 0 ? numerator << BigInt(-quantum) : numerator;
  const d = quantum <= 0 ? denominator : denominator << BigInt(quantum);
  let mantissa = n / d;
  const remainder = n % d;
  if (2n * remainder > d || (2n * remainder === d && mantissa % 2n !== 0n)) mantissa += 1n;
  const value = Number(mantissa) * 2 ** quantum;
  if (!Number.isFinite(value)) throw new RangeError("Local rational overflows binary64");
  return value;
}

interface LocalResidualGroup {
  readonly value: number;
  readonly indices: readonly number[];
}
export interface LocalResidualGroups {
  readonly kind: "prepared-local-residual-groups";
  readonly count: number;
}
const preparedGroups = new WeakMap<LocalResidualGroups, readonly LocalResidualGroup[]>();

/** Own all group values/indices privately; serialized or forged tokens cannot bypass validation. */
export function groupLocalResiduals(values: readonly number[]): LocalResidualGroups {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ATOMS)
    throw new RangeError("Local residual count is outside its bound");
  const sorted = values.map((value: number, index: number) => {
    if (!Number.isFinite(value)) throw new RangeError("Local residual is nonfinite");
    return { value: value === 0 ? 0 : value, index };
  });
  sorted.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.index - b.index));
  const groups: { value: number; indices: number[] }[] = [];
  for (const item of sorted) {
    const last = groups.at(-1);
    if (last !== undefined && last.value === item.value) last.indices.push(item.index);
    else groups.push({ value: item.value, indices: [item.index] });
  }
  const token = Object.freeze({
    kind: "prepared-local-residual-groups" as const,
    count: values.length,
  });
  preparedGroups.set(token, groups);
  return token;
}

/** Midpoint-CDF linear interpolation, deliberately distinct from a discrete inverse CDF. */
export function localMidpointResidualQuantile(
  prepared: LocalResidualGroups,
  masses: readonly bigint[],
  numerator: 3 | 10 | 17,
): number {
  const groups = preparedGroups.get(prepared);
  if (!groups || ![3, 10, 17].includes(numerator))
    throw new RangeError("Invalid local quantile request");
  if (masses.length !== prepared.count || masses.some((mass) => mass <= 0n))
    throw new RangeError("Invalid local quantile masses");
  const total = masses.reduce((sum, mass) => sum + mass, 0n);
  const target = BigInt(numerator) * 2n * total;
  let cumulative = 0n;
  let previousMidpoint = 0n;
  let previousValue = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const mass = group.indices.reduce((sum, member) => sum + masses[member]!, 0n);
    const midpoint = 2n * cumulative + mass;
    if (target <= 20n * midpoint) {
      if (index === 0) return group.value;
      const fraction = localRationalNumber(
        target - 20n * previousMidpoint,
        20n * (midpoint - previousMidpoint),
      );
      if (fraction === 0) return previousValue;
      if (fraction === 1) return group.value;
      const value = previousValue + (group.value - previousValue) * fraction;
      if (!Number.isFinite(value)) throw new RangeError("Local residual interpolation overflow");
      return value === 0 ? 0 : value;
    }
    cumulative += mass;
    previousMidpoint = midpoint;
    previousValue = group.value;
  }
  return groups.at(-1)!.value;
}

export function localEffectiveSupport(masses: readonly bigint[], minimum: number) {
  if (
    masses.length < 1 ||
    masses.length > MAX_ATOMS ||
    masses.some((mass) => mass <= 0n) ||
    !Number.isSafeInteger(minimum) ||
    minimum < 1 ||
    minimum > MAX_ATOMS
  )
    throw new RangeError("Invalid local support request");
  const total = masses.reduce((sum, mass) => sum + mass, 0n);
  const squares = masses.reduce((sum, mass) => sum + mass * mass, 0n);
  return {
    sufficient: total * total >= BigInt(minimum) * squares,
    effective: localRationalNumber(total * total, squares),
  };
}
