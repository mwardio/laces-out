/** Internal closed-contract helpers; no admission or source authentication is performed here. */
export function conditionalContractObject(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    throw new TypeError("Conditional contract has missing or unknown fields");
}
export function conditionalContractDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new TypeError("Conditional contract requires an exact SHA256");
}
export function conditionalContractArray(value: unknown, minimum: number, maximum: number): void {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Object.keys(value).length !== value.length
  )
    throw new TypeError("Conditional contract requires a bounded dense array");
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index))
      throw new TypeError("Conditional contract has a sparse array");
}
/** Finite, acyclic, bounded plain data, with object-key-order-independent hashes. */
export function conditionalContractCanonical(value: unknown): string {
  let nodes = 0,
    characters = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): string {
    if (++nodes > 8_000_000 || depth > 32)
      throw new RangeError("Conditional contract exceeds serialization bound");
    if (item !== null && typeof item === "object") {
      if (ancestors.has(item)) throw new TypeError("Conditional contract is cyclic");
      ancestors.add(item);
      let result: string;
      if (Array.isArray(item)) {
        conditionalContractArray(item, 0, 40_000);
        result = `[${item.map((entry) => visit(entry, depth + 1)).join(",")}]`;
      } else {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null))
          throw new TypeError("Conditional contract is not plain data");
        const entries = Object.entries(item);
        if (entries.length > 64) throw new RangeError("Conditional contract object exceeds bound");
        result = `{${entries
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => `${visit(key, depth + 1)}:${visit(entry, depth + 1)}`)
          .join(",")}}`;
      }
      ancestors.delete(item);
      return result;
    }
    if (
      (typeof item === "number" && !Number.isFinite(item)) ||
      (!["string", "number", "boolean"].includes(typeof item) && item !== null)
    )
      throw new TypeError("Conditional contract contains a non-JSON value");
    const encoded = JSON.stringify(item);
    characters += encoded.length;
    if (encoded.length > 131_072 || characters > 128 * 1024 * 1024)
      throw new RangeError("Conditional contract exceeds text bound");
    return encoded;
  }
  return visit(value, 0);
}
/** Walk the reconstructed expected shape, never a supplied unbounded proof tree. */
export function conditionalContractMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      Object.keys(actual).length === expected.length &&
      expected.every(
        (value, index) =>
          Object.hasOwn(actual, index) && conditionalContractMatches(actual[index], value),
      )
    );
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const keys = Object.keys(expected);
    return (
      Object.keys(actual).length === keys.length &&
      Object.entries(expected).every(
        ([key, value]) =>
          Object.hasOwn(actual, key) &&
          conditionalContractMatches((actual as Record<string, unknown>)[key], value),
      )
    );
  }
  return actual === expected;
}
