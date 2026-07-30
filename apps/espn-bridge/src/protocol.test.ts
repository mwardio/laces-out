import { describe, expect, it } from "vitest";

import {
  configurationFromPairingRedemption,
  configurationStorageKey,
  createPendingPairingOffer,
  maximumLeagueCount,
  normalizePairingCode,
  pairingOfferIsFresh,
  pairingOfferTtlMs,
  parseLeagueIds,
  pendingPairingStorageKey,
  statusStorageKey,
  summarizeBridgeResults,
  syncAlarmName,
  validateBridgeConfiguration,
  validateBridgePairingOffer,
  validateLeagueIds,
  validateStoredPendingOffer,
  type BridgeLeagueResult,
} from "./protocol.js";

const deviceToken = `lo_espn_${"a".repeat(43)}`;

function offerMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "PAIRING_OFFER",
    apiBaseUrl: "https://laces.example",
    deviceToken,
    leagues: ["123", "456"],
    season: 2026,
    ...overrides,
  };
}

describe("ESPN bridge multi-league protocol", () => {
  it("uses Laces Out storage and alarm namespaces", () => {
    expect([configurationStorageKey, statusStorageKey, syncAlarmName]).toEqual([
      "lacesOutEspnConfiguration",
      "lacesOutEspnStatus",
      "laces-out-espn-sync",
    ]);
  });

  it("parses comma and whitespace delimiters without changing decimal-string IDs", () => {
    expect(parseLeagueIds("12345, 90071992547409931234\n67890")).toEqual([
      "12345",
      "90071992547409931234",
      "67890",
    ]);
  });

  it("rejects duplicate, malformed, empty, and oversized league sets", () => {
    expect(() => parseLeagueIds("123, 123")).toThrow("unique");
    expect(() => parseLeagueIds("123, league-2")).toThrow("1 to 20 digits");
    expect(() => parseLeagueIds("  , \n ")).toThrow("at least one");
    expect(() =>
      validateLeagueIds(
        Array.from({ length: maximumLeagueCount + 1 }, (_, index) => String(index)),
      ),
    ).toThrow(`at most ${maximumLeagueCount}`);
  });

  it("normalizes an exact HTTPS or loopback API origin and fails closed otherwise", () => {
    expect(
      validateBridgeConfiguration({
        apiBaseUrl: "https://laces.example/path-is-discarded",
        deviceToken,
        leagueIds: ["123", "456"],
        season: 2026,
        automaticSync: true,
      }),
    ).toEqual({
      apiBaseUrl: "https://laces.example",
      deviceToken,
      leagueIds: ["123", "456"],
      season: 2026,
      automaticSync: true,
    });
    expect(() =>
      validateBridgeConfiguration({
        apiBaseUrl: "http://laces.example",
        deviceToken,
        leagueIds: ["123"],
        season: 2026,
        automaticSync: false,
      }),
    ).toThrow("HTTPS");
    expect(
      validateBridgeConfiguration({
        apiBaseUrl: "http://127.0.0.1:4000",
        deviceToken,
        leagueIds: ["123"],
        season: 2026,
        automaticSync: false,
      }).apiBaseUrl,
    ).toBe("http://127.0.0.1:4000");
  });

  it("uses the Laces Out pending-pairing storage namespace", () => {
    expect(pendingPairingStorageKey).toBe("lacesOutEspnPendingPairing");
  });

  it("normalizes a self-hosted pairing code and validates the redeemed credential", () => {
    expect(normalizePairingCode("  abcd-efgh-jklm-npqr ")).toBe("ABCD-EFGH-JKLM-NPQR");
    expect(() => normalizePairingCode("ABCD-EFGH-IJKL-MNOP")).toThrow("pairing code");
    expect(
      configurationFromPairingRedemption(
        {
          deviceId: "00000000-0000-4000-8000-000000000010",
          deviceToken,
          expiresAt: "2099-07-30T13:00:00.000Z",
          leagueIds: ["123", "456"],
          season: 2026,
          automaticSync: true,
        },
        "https://self-hosted.example/connections",
      ),
    ).toEqual({
      apiBaseUrl: "https://self-hosted.example",
      deviceToken,
      leagueIds: ["123", "456"],
      season: 2026,
      automaticSync: true,
    });
  });

  it("rejects malformed, expired, or downgraded self-hosted pairing responses", () => {
    const response = {
      deviceId: "00000000-0000-4000-8000-000000000010",
      deviceToken,
      expiresAt: "2099-07-30T13:00:00.000Z",
      leagueIds: ["123"],
      season: 2026,
      automaticSync: true,
    };
    expect(() =>
      configurationFromPairingRedemption(
        { ...response, expiresAt: "2020-01-01T00:00:00.000Z" },
        "https://self-hosted.example",
      ),
    ).toThrow("expiry");
    expect(() =>
      configurationFromPairingRedemption(
        { ...response, automaticSync: false },
        "https://self-hosted.example",
      ),
    ).toThrow("automatic-sync");
    expect(() =>
      configurationFromPairingRedemption(response, "http://self-hosted.example"),
    ).toThrow("HTTPS");
  });

  it("accepts a self-originated pairing offer and normalizes the configuration", () => {
    expect(
      validateBridgePairingOffer(
        offerMessage({ apiBaseUrl: "https://laces.example/connections" }),
        "https://laces.example",
      ),
    ).toEqual({
      apiBaseUrl: "https://laces.example",
      deviceToken,
      leagueIds: ["123", "456"],
      season: 2026,
      automaticSync: true,
    });
  });

  it("ignores unknown extra fields and honors an explicit automaticSync flag", () => {
    const offer = validateBridgePairingOffer(
      offerMessage({ automaticSync: false, nonce: "ignored", extra: { a: 1 } }),
      "https://laces.example",
    );
    expect(offer.automaticSync).toBe(false);
    expect(offer.leagueIds).toEqual(["123", "456"]);
  });

  it("rejects offers whose sender origin does not match the offered API origin", () => {
    expect(() => validateBridgePairingOffer(offerMessage(), "https://evil.example")).toThrow(
      "own origin",
    );
    expect(() => validateBridgePairingOffer(offerMessage(), "not-a-url")).toThrow("invalid");
    expect(() => validateBridgePairingOffer(offerMessage(), "")).toThrow("browser-attested");
  });

  it("rejects short tokens, bad URLs, wrong message types, and missing offers", () => {
    expect(() =>
      validateBridgePairingOffer(
        offerMessage({ deviceToken: "too-short" }),
        "https://laces.example",
      ),
    ).toThrow("device token");
    expect(() =>
      validateBridgePairingOffer(
        offerMessage({ apiBaseUrl: "ftp://laces.example" }),
        "ftp://laces.example",
      ),
    ).toThrow("HTTPS");
    expect(() =>
      validateBridgePairingOffer(
        { ...offerMessage(), type: "SOMETHING_ELSE" },
        "https://laces.example",
      ),
    ).toThrow("Not a bridge pairing offer");
    expect(() => validateBridgePairingOffer(null, "https://laces.example")).toThrow(
      "Not a bridge pairing offer",
    );
  });

  it("round-trips and expires stored pending offers, failing closed on tampering", () => {
    const configuration = validateBridgePairingOffer(offerMessage(), "https://laces.example");
    const fresh = createPendingPairingOffer(configuration, new Date(1_000_000).toISOString());
    expect(validateStoredPendingOffer(fresh)).toEqual(fresh);
    expect(pairingOfferIsFresh(fresh, 1_000_000 + pairingOfferTtlMs - 1)).toBe(true);
    expect(pairingOfferIsFresh(fresh, 1_000_000 + pairingOfferTtlMs)).toBe(false);
    expect(pairingOfferIsFresh(fresh, 999_999)).toBe(false);
    expect(
      validateStoredPendingOffer({ ...fresh, origin: "https://evil.example" }),
    ).toBeUndefined();
    expect(validateStoredPendingOffer({ ...fresh, receivedAt: "not-a-date" })).toBeUndefined();
    expect(validateStoredPendingOffer(undefined)).toBeUndefined();
  });

  it("reports full success, partial failure, and login-required aggregates clearly", () => {
    const synced: BridgeLeagueResult = {
      leagueId: "123",
      state: "synced",
      message: "Synced successfully.",
    };
    const failed: BridgeLeagueResult = {
      leagueId: "456",
      state: "error",
      message: "ESPN returned status 500",
    };
    const login: BridgeLeagueResult = {
      leagueId: "789",
      state: "espn-login-required",
      message: "ESPN sign-in or league access is required.",
    };

    expect(summarizeBridgeResults([synced])).toEqual({
      state: "healthy",
      message: "Synced 1 ESPN league.",
    });
    expect(summarizeBridgeResults([synced, failed])).toEqual({
      state: "partial-failure",
      message: "Synced 1 of 2 ESPN leagues; 1 needs attention.",
    });
    expect(summarizeBridgeResults([login, login])).toEqual({
      state: "espn-login-required",
      message: "Sign in to ESPN in this browser, then sync again.",
    });
  });
});
