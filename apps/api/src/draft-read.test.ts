import { DRAFT_READ_TOKEN_LIMITS } from "@laces-out/contracts";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  draftReadClaimsPermit,
  draftReadTokenFromAuthorization,
  mintDraftReadToken,
  verifyDraftReadToken,
} from "./draft-read.js";

const SECRET = "s".repeat(48);
const USER_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-24T18:05:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

function signedToken(payload: unknown, rootSecret = SECRET): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = createHmac("sha256", Buffer.from(rootSecret, "utf8"))
    .update("laces-out/draft-read-signing-key/v1", "utf8")
    .digest();
  const signature = createHmac("sha256", key)
    .update("laces-out/draft-read-capability/v1\u0000", "utf8")
    .update(encodedPayload, "ascii")
    .digest("base64url");
  return `dr1.${encodedPayload}.${signature}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId: USER_ID,
    leagues: [{ leagueId: "1234567", season: 2026 }],
    permission: "espn-live-draft-pulse:read",
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 3_600,
    nonce: "abcdefghijklmnopqrstuv",
    ...overrides,
  };
}

describe("DraftRead token", () => {
  it("mints and verifies a bounded capability with a fresh random nonce", () => {
    const first = mintDraftReadToken({
      sessionSecret: SECRET,
      userId: USER_ID,
      leagues: [
        { leagueId: "1234567", season: 2026 },
        { leagueId: "7654321", season: 2027 },
      ],
      lifetimeSeconds: DRAFT_READ_TOKEN_LIMITS.maximumLifetimeSeconds,
      now: NOW,
    });
    const second = mintDraftReadToken({
      sessionSecret: SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 60,
      now: NOW,
    });

    expect(first.token).not.toBe(second.token);
    expect(first.claims.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(first.claims.nonce).not.toBe(second.claims.nonce);
    expect(first.expiresAt.toISOString()).toBe("2026-08-25T06:05:00.000Z");
    expect(verifyDraftReadToken(SECRET, first.token, NOW)).toEqual(first.claims);
  });

  it("rejects payload and signature tampering as well as a different root secret", () => {
    const { token } = mintDraftReadToken({
      sessionSecret: SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 3_600,
      now: NOW,
    });
    const [prefix, payload, signature] = token.split(".") as [string, string, string];
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    expect(verifyDraftReadToken(SECRET, `${prefix}.${tamperedPayload}.${signature}`, NOW)).toBe(
      undefined,
    );
    expect(verifyDraftReadToken(SECRET, `${prefix}.${payload}.${tamperedSignature}`, NOW)).toBe(
      undefined,
    );
    expect(verifyDraftReadToken("x".repeat(48), token, NOW)).toBe(undefined);
  });

  it("rejects expired and not-yet-issued tokens at exact epoch boundaries", () => {
    const token = signedToken(claims({ iat: NOW_SECONDS - 60, exp: NOW_SECONDS }));
    expect(verifyDraftReadToken(SECRET, token, new Date(NOW.getTime() - 1_000))).toBeDefined();
    expect(verifyDraftReadToken(SECRET, token, NOW)).toBe(undefined);

    const future = signedToken(claims({ iat: NOW_SECONDS + 1, exp: NOW_SECONDS + 61 }));
    expect(verifyDraftReadToken(SECRET, future, NOW)).toBe(undefined);
  });

  it.each([
    ["duplicate scopes", { leagues: Array(2).fill({ leagueId: "1234567", season: 2026 }) }],
    ["wrong permission", { permission: "espn-live-draft-pulse:write" }],
    ["unknown claim", { administrator: true }],
    ["wrong version", { version: 2 }],
    [
      "excessive lifetime",
      { exp: NOW_SECONDS + DRAFT_READ_TOKEN_LIMITS.maximumLifetimeSeconds + 1 },
    ],
  ])("rejects a correctly signed payload with %s", (_label, override) => {
    expect(verifyDraftReadToken(SECRET, signedToken(claims(override)), NOW)).toBe(undefined);
  });

  it("refuses invalid mint inputs before producing capability material", () => {
    expect(() =>
      mintDraftReadToken({
        sessionSecret: "short",
        userId: USER_ID,
        leagues: [{ leagueId: "1234567", season: 2026 }],
        lifetimeSeconds: 60,
        now: NOW,
      }),
    ).toThrow(/at least 32 bytes/u);
    expect(() =>
      mintDraftReadToken({
        sessionSecret: SECRET,
        userId: USER_ID,
        leagues: Array(2).fill({ leagueId: "1234567", season: 2026 }),
        lifetimeSeconds: 60,
        now: NOW,
      }),
    ).toThrow(/unique/u);
    expect(() =>
      mintDraftReadToken({
        sessionSecret: SECRET,
        userId: USER_ID,
        leagues: [{ leagueId: "1234567", season: 2026 }],
        lifetimeSeconds: DRAFT_READ_TOKEN_LIMITS.maximumLifetimeSeconds + 1,
        now: NOW,
      }),
    ).toThrow(/1-43200/u);
  });

  it("parses only the distinct exact scheme and matches exact league-season pairs", () => {
    const minted = mintDraftReadToken({
      sessionSecret: SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 60,
      now: NOW,
    });
    expect(draftReadTokenFromAuthorization(`DraftRead ${minted.token}`)).toBe(minted.token);
    expect(draftReadTokenFromAuthorization(`draftread ${minted.token}`)).toBe(undefined);
    expect(draftReadTokenFromAuthorization(`Bearer ${minted.token}`)).toBe(undefined);
    expect(draftReadClaimsPermit(minted.claims, "1234567", 2026)).toBe(true);
    expect(draftReadClaimsPermit(minted.claims, "1234567", 2027)).toBe(false);
    expect(draftReadClaimsPermit(minted.claims, "7654321", 2026)).toBe(false);
  });
});
