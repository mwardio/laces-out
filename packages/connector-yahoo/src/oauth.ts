import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

export const YAHOO_AUTHORIZATION_ENDPOINT =
  "https://api.login.yahoo.com/oauth2/request_auth" as const;

const PKCE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export interface YahooAuthorizationRequestOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly prompt?: "consent" | "login";
  readonly language?: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface YahooAuthorizationRequest {
  readonly authorizationUrl: string;
  /** Persist only `stateHash`; return the plaintext state to the browser. */
  readonly state: string;
  readonly stateHash: string;
  /** Encrypt at rest with the state transaction; never expose in logs. */
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly expiresAt: string;
}

export type YahooStateVerificationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "missing" | "expired" | "mismatch" };

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("base64url");
}

export function createPkceVerifier(
  randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
): string {
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  if (!PKCE_PATTERN.test(verifier)) {
    throw new TypeError("PKCE random source did not produce a valid verifier");
  }
  return verifier;
}

export function createPkceChallenge(codeVerifier: string): string {
  if (!PKCE_PATTERN.test(codeVerifier)) {
    throw new TypeError("PKCE code verifier must be 43-128 RFC 7636 characters");
  }
  return base64UrlSha256(codeVerifier);
}

export function createOAuthState(
  randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
): string {
  const state = Buffer.from(randomBytes(32)).toString("base64url");
  if (!STATE_PATTERN.test(state)) {
    throw new TypeError("OAuth random source did not produce a valid state");
  }
  return state;
}

/** Store this one-way digest rather than a bearer-equivalent plaintext state. */
export function hashOAuthState(state: string): string {
  if (!STATE_PATTERN.test(state)) throw new TypeError("OAuth state has an invalid format");
  return base64UrlSha256(state);
}

export function verifyOAuthState(input: {
  readonly returnedState: string | null | undefined;
  readonly expectedStateHash: string;
  readonly expiresAt: string;
  readonly now?: () => Date;
}): YahooStateVerificationResult {
  if (input.returnedState === null || input.returnedState === undefined) {
    return { valid: false, reason: "missing" };
  }
  if (!STATE_PATTERN.test(input.returnedState)) {
    return { valid: false, reason: "mismatch" };
  }
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? (() => new Date()))().getTime()) {
    return { valid: false, reason: "expired" };
  }

  const actual = Buffer.from(hashOAuthState(input.returnedState), "ascii");
  const expected = Buffer.from(input.expectedStateHash, "ascii");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    return { valid: false, reason: "mismatch" };
  }
  return { valid: true };
}

function validateRedirectUri(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new TypeError("Yahoo redirect URI must be an absolute URL");
  }

  const loopback =
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost") &&
    url.protocol === "http:";
  if (url.protocol !== "https:" && !loopback) {
    throw new TypeError("Yahoo redirect URI must use HTTPS (HTTP is allowed only for loopback)");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new TypeError("Yahoo redirect URI cannot include credentials or a fragment");
  }
}

export function createYahooAuthorizationRequest(
  options: YahooAuthorizationRequestOptions,
): YahooAuthorizationRequest {
  if (options.clientId.trim() === "") throw new TypeError("Yahoo client ID is required");
  validateRedirectUri(options.redirectUri);

  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60 * 1000) {
    throw new TypeError("OAuth state TTL must be between one and thirty minutes");
  }
  const now = (options.now ?? (() => new Date()))();
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const state = createOAuthState(randomBytes);
  const codeVerifier = createPkceVerifier(randomBytes);
  const codeChallenge = createPkceChallenge(codeVerifier);
  const url = new URL(YAHOO_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  // Yahoo's documented confidential-client authorization-code flow does not support PKCE.
  // Keep the encrypted verifier in the local one-time transaction for backward-compatible
  // persistence, but do not send unsupported challenge parameters to Yahoo.
  url.searchParams.set("language", options.language ?? "en-us");
  if (options.prompt !== undefined) url.searchParams.set("prompt", options.prompt);
  if (options.scopes !== undefined && options.scopes.length > 0) {
    const scopes = [...new Set(options.scopes.map((scope) => scope.trim()).filter(Boolean))];
    if (scopes.length > 0) {
      url.searchParams.set("scope", scopes.join(" "));
      // Yahoo requires a nonce for OpenID Connect authorization requests. The verifier is
      // already random, encrypted with this one-time transaction, and never exposed in logs.
      if (scopes.includes("openid")) url.searchParams.set("nonce", codeVerifier);
    }
  }

  return Object.freeze({
    authorizationUrl: url.toString(),
    state,
    stateHash: hashOAuthState(state),
    codeVerifier,
    codeChallenge,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}
