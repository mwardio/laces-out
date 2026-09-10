// Lightweight browser connection and identity helpers; no league schemas in public-page bundles.
const fallbackApiUrl = "http://localhost:4000";

const configuredApiBaseUrl = (process.env.NEXT_PUBLIC_API_URL ?? fallbackApiUrl).replace(
  /\/+$/,
  "",
);

/**
 * Where browser requests go. One image is served from more than one domain, so a base URL baked in
 * at build time would send every browser on the second domain cross-origin. In same-origin mode the
 * browser uses a relative `/v1` path instead and reaches whichever domain it loaded the app from;
 * the gateway in front of both domains routes `/v1` to the API. Anything that is not a browser —
 * server rendering, local development, tests — keeps the configured absolute base.
 */
export function resolveApiBaseUrl(
  configured: string,
  sameOrigin: string | undefined,
  inBrowser: boolean,
): string {
  return sameOrigin === "true" && inBrowser ? "" : configured;
}

export const apiBaseUrl = resolveApiBaseUrl(
  configuredApiBaseUrl,
  process.env.NEXT_PUBLIC_API_SAME_ORIGIN,
  typeof window !== "undefined",
);

/**
 * An absolute origin for the few places a relative path cannot work, such as a self-hosted pairing
 * value displayed to another client or a `new URL()` that has no base to resolve against.
 */
export function absoluteApiOrigin(): string {
  if (apiBaseUrl !== "") return apiBaseUrl;
  return typeof window === "undefined" ? configuredApiBaseUrl : window.location.origin;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: "member" | "admin";
}

export interface AuthenticatedSession {
  readonly authenticated: true;
  readonly user: SessionUser;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionUser(value: unknown): value is SessionUser {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.email === "string" &&
    typeof value.displayName === "string" &&
    (value.role === "member" || value.role === "admin")
  );
}

export function parseAuthenticatedSession(value: unknown): AuthenticatedSession | null {
  if (!isRecord(value) || value.authenticated !== true || !isSessionUser(value.user)) return null;
  return { authenticated: true, user: value.user };
}
