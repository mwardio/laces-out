import { createHash } from "node:crypto";

/**
 * Cross-client JSON canonicalization for ESPN artifact envelopes.
 *
 * Version 1 recursively sorts object keys by UTF-16 code unit, retains array order, and uses the
 * ECMAScript JSON representation for strings, booleans, null, and finite numbers. Inputs arriving
 * through an HTTP JSON parser cannot contain undefined, functions, symbols, bigint, or cycles; the
 * explicit rejection keeps programmatic callers on that same boundary.
 */
export function canonicalEspnPayloadJsonV1(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("ESPN JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalEspnPayloadJsonV1(entry)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("ESPN payload must contain only JSON values");
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalEspnPayloadJsonV1(record[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Portable checksum required for native agents and accepted from updated browser agents. */
export function canonicalEspnPayloadChecksumV1(payload: unknown): string {
  return sha256(canonicalEspnPayloadJsonV1(payload));
}

/** Published browser companions used insertion-order `JSON.stringify`; retain it for compatibility. */
export function legacyBrowserEspnPayloadChecksum(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new TypeError("ESPN payload is not JSON serializable");
  return sha256(serialized);
}

export function espnPayloadChecksumMatches(input: {
  readonly payload: unknown;
  readonly checksumSha256: string;
  readonly authority: "browser-local" | "native-local";
}): boolean {
  if (canonicalEspnPayloadChecksumV1(input.payload) === input.checksumSha256) return true;
  return (
    input.authority === "browser-local" &&
    legacyBrowserEspnPayloadChecksum(input.payload) === input.checksumSha256
  );
}
