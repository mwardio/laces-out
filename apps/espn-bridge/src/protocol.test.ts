import { describe, expect, it } from "vitest";

import {
  configurationStorageKey,
  maximumLeagueCount,
  parseLeagueIds,
  statusStorageKey,
  summarizeBridgeResults,
  syncAlarmName,
  validateBridgeConfiguration,
  validateLeagueIds,
  type BridgeLeagueResult,
} from "./protocol.js";

const deviceToken = `lo_espn_${"a".repeat(43)}`;

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
