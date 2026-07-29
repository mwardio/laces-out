/**
 * Bounding and delimiter neutralization for every piece of untrusted content that reaches a model.
 *
 * Extracted from `ai-service.ts` so the tool registry and the tool loop apply the *same* defenses
 * to a tool result that the single-shot context blob already gets. A second implementation would
 * be a second thing to get wrong.
 */

/**
 * Any text that looks like an opening or closing league-data delimiter (bare or nonce'd,
 * case-insensitive, allowing incidental whitespace) is scrubbed from serialized untrusted content
 * so it cannot forge the real boundary.
 */
const LEAGUE_DATA_DELIMITER_PATTERN = /<\s*\/?\s*league_data(?:-[0-9a-fA-F]+)?\s*>?/giu;
export const NEUTRALIZED_DELIMITER = "[filtered-league-data-delimiter]";

export function neutralizeLeagueDataDelimiters(serialized: string): string {
  return serialized.replace(LEAGUE_DATA_DELIMITER_PATTERN, NEUTRALIZED_DELIMITER);
}

/** Depth-, breadth-, and length-bounded structural copy of an arbitrary JSON-ish value. */
export function boundedValue(value: unknown, depth = 0, arrayLimit = 12): unknown {
  if (depth > 7) return "[depth limited]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) {
    return value.slice(0, arrayLimit).map((item) => boundedValue(item, depth + 1, arrayLimit));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entry]) => [key.slice(0, 120), boundedValue(entry, depth + 1, arrayLimit)]),
    );
  }
  return undefined;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
