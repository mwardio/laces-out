export const REDACTED = "[REDACTED]" as const;

const SENSITIVE_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "authorization",
  "clientsecret",
  "codesverifier",
  "codeverifier",
  "consumersecret",
  "cookie",
  "espns2",
  "idtoken",
  "password",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "sessioncookie",
  "setcookie",
  "swid",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("clientsecret") ||
    normalized.endsWith("sessioncookie")
  );
}

const SECRET_NAME =
  "access_token|refresh_token|id_token|client_secret|consumer_secret|code_verifier|espn_s2|swid|cookie";
const JSON_SECRET_PATTERN = new RegExp(`("(?:${SECRET_NAME})"\\s*:\\s*")[^"]*(")`, "giu");
const QUERY_SECRET_PATTERN = new RegExp(`([?&](?:${SECRET_NAME})=)[^&#\\s]*`, "giu");

/** Redact common OAuth, Authorization, and cookie material embedded in text. */
export function redactText(input: string): string {
  return input
    .replace(JSON_SECRET_PATTERN, `$1${REDACTED}$2`)
    .replace(QUERY_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `$1 ${REDACTED}`)
    .replace(
      /\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/giu,
      `$1${REDACTED}`,
    )
    .replace(/\b(espn_s2|SWID)=([^;\s,]+)/giu, `$1=${REDACTED}`);
}

/**
 * Produce a detached log-safe value. This does not mutate the caller's value
 * and handles circular structures without throwing in an error path.
 */
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function visit(current: unknown): unknown {
    if (typeof current === "string") return redactText(current);
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "bigint" ||
      typeof current === "undefined"
    ) {
      return current;
    }
    if (typeof current === "symbol" || typeof current === "function") {
      return String(current);
    }
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      return {
        name: current.name,
        message: redactText(current.message),
        stack: current.stack === undefined ? undefined : redactText(current.stack),
      };
    }
    if (typeof current !== "object") return current;
    if (seen.has(current)) return "[Circular]";
    seen.add(current);

    if (Array.isArray(current)) return current.map(visit);

    return Object.fromEntries(
      Object.entries(current).map(([key, child]) => [
        key,
        isSensitiveKey(key) ? REDACTED : visit(child),
      ]),
    );
  }

  return visit(value);
}
