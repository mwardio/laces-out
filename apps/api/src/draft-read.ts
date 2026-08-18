import {
  DRAFT_READ_TOKEN_LIMITS,
  draftReadTokenClaimsSchema,
  type DraftReadLeagueScope,
  type DraftReadTokenClaims,
} from "@laces-out/contracts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const draftReadTokenPrefix = "dr1";
const draftReadKeyDomain = "laces-out/draft-read-signing-key/v1";
const draftReadMessageDomain = "laces-out/draft-read-capability/v1\u0000";
const hmacBytes = 32;
const encodedHmacCharacters = 43;
const encodedTokenPattern = new RegExp(
  `^${draftReadTokenPrefix}\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]{${encodedHmacCharacters}})$`,
  "u",
);

export interface MintDraftReadTokenInput {
  readonly sessionSecret: Uint8Array | string;
  readonly userId: string;
  readonly leagues: readonly DraftReadLeagueScope[];
  readonly lifetimeSeconds: number;
  readonly now?: Date;
}

export interface MintedDraftReadToken {
  readonly token: string;
  readonly claims: DraftReadTokenClaims;
  readonly expiresAt: Date;
}

function rootSecretBytes(rootSecret: Uint8Array | string): Uint8Array {
  const secret = typeof rootSecret === "string" ? Buffer.from(rootSecret, "utf8") : rootSecret;
  if (secret.byteLength < 32) {
    throw new RangeError("DraftRead root secret must contain at least 32 bytes");
  }
  return secret;
}

function signingKey(rootSecret: Uint8Array | string): Buffer {
  return createHmac("sha256", rootSecretBytes(rootSecret))
    .update(draftReadKeyDomain, "utf8")
    .digest();
}

function signatureForPayload(rootSecret: Uint8Array | string, encodedPayload: string): Buffer {
  return createHmac("sha256", signingKey(rootSecret))
    .update(draftReadMessageDomain, "utf8")
    .update(encodedPayload, "ascii")
    .digest();
}

function epochSeconds(now: Date): number {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) throw new RangeError("DraftRead time must be valid");
  return Math.floor(milliseconds / 1_000);
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a short-lived, read-only capability. The deployment secret is domain-separated before
 * it signs anything, and neither this function nor the verifier performs logging.
 */
export function mintDraftReadToken(input: MintDraftReadTokenInput): MintedDraftReadToken {
  if (
    !Number.isInteger(input.lifetimeSeconds) ||
    input.lifetimeSeconds < 1 ||
    input.lifetimeSeconds > DRAFT_READ_TOKEN_LIMITS.maximumLifetimeSeconds
  ) {
    throw new RangeError(
      `DraftRead lifetime must be 1-${DRAFT_READ_TOKEN_LIMITS.maximumLifetimeSeconds} seconds`,
    );
  }

  // Validate the root secret before generating a nonce so a configuration error has no side
  // effects and cannot accidentally produce token-looking material.
  rootSecretBytes(input.sessionSecret);
  const iat = epochSeconds(input.now ?? new Date());
  const claims = draftReadTokenClaimsSchema.parse({
    version: 1,
    userId: input.userId,
    leagues: [...input.leagues],
    permission: "espn-live-draft-pulse:read",
    iat,
    exp: iat + input.lifetimeSeconds,
    nonce: randomBytes(DRAFT_READ_TOKEN_LIMITS.nonceBytes).toString("base64url"),
  });
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const encodedSignature = signatureForPayload(input.sessionSecret, encodedPayload).toString(
    "base64url",
  );
  const token = `${draftReadTokenPrefix}.${encodedPayload}.${encodedSignature}`;
  if (token.length > DRAFT_READ_TOKEN_LIMITS.maximumTokenCharacters) {
    throw new RangeError("DraftRead token exceeds the encoded size limit");
  }
  return { token, claims, expiresAt: new Date(claims.exp * 1_000) };
}

/**
 * Verifies a token before parsing its JSON payload. Every syntactically valid signature is
 * compared at the fixed SHA-256 HMAC length with `timingSafeEqual`.
 */
export function verifyDraftReadToken(
  rootSecret: Uint8Array | string,
  token: string,
  now: Date = new Date(),
): DraftReadTokenClaims | undefined {
  if (token.length > DRAFT_READ_TOKEN_LIMITS.maximumTokenCharacters) return undefined;
  const match = encodedTokenPattern.exec(token);
  if (!match?.[1] || !match[2]) return undefined;

  const expected = signatureForPayload(rootSecret, match[1]);
  const decodedCandidate = decodeCanonicalBase64Url(match[2]);
  const candidate =
    decodedCandidate?.byteLength === hmacBytes ? decodedCandidate : Buffer.alloc(hmacBytes);
  const signatureMatches = timingSafeEqual(expected, candidate);
  if (!signatureMatches || decodedCandidate?.byteLength !== hmacBytes) return undefined;

  const decodedPayload = decodeCanonicalBase64Url(match[1]);
  if (!decodedPayload) return undefined;
  let untrustedClaims: unknown;
  try {
    untrustedClaims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodedPayload));
  } catch {
    return undefined;
  }
  const parsed = draftReadTokenClaimsSchema.safeParse(untrustedClaims);
  if (!parsed.success) return undefined;

  const currentEpochSeconds = epochSeconds(now);
  if (parsed.data.iat > currentEpochSeconds || parsed.data.exp <= currentEpochSeconds) {
    return undefined;
  }
  return parsed.data;
}

/** Exact, case-sensitive authorization scheme; bearer and bridge credentials cannot alias it. */
export function draftReadTokenFromAuthorization(
  authorization: string | undefined,
): string | undefined {
  if (
    authorization === undefined ||
    authorization.length > "DraftRead ".length + DRAFT_READ_TOKEN_LIMITS.maximumTokenCharacters
  ) {
    return undefined;
  }
  const match = /^DraftRead ([A-Za-z0-9._~-]+)$/u.exec(authorization);
  return match?.[1];
}

export function draftReadClaimsPermit(
  claims: DraftReadTokenClaims,
  leagueId: string,
  season: number,
): boolean {
  return claims.leagues.some((scope) => scope.leagueId === leagueId && scope.season === season);
}
