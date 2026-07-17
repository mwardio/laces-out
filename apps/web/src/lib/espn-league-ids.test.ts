import { describe, expect, it } from "vitest";

import { maximumEspnBridgeLeagues, parseEspnLeagueIds } from "./espn-league-ids.js";

describe("parseEspnLeagueIds", () => {
  it("accepts a unique comma-or-whitespace-separated set", () => {
    expect(parseEspnLeagueIds("12345, 67890\n90071992547409931234")).toEqual([
      "12345",
      "67890",
      "90071992547409931234",
    ]);
  });

  it("extracts league IDs from ESPN league URLs", () => {
    expect(
      parseEspnLeagueIds(
        "https://fantasy.espn.com/football/league?leagueId=12345 https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/67890",
      ),
    ).toEqual(["12345", "67890"]);
  });

  it("rejects duplicates, malformed IDs, and more than 32 leagues", () => {
    expect(() => parseEspnLeagueIds("123 123")).toThrow("duplicate");
    expect(() => parseEspnLeagueIds("123 league-two")).toThrow("league URL");
    expect(() =>
      parseEspnLeagueIds(
        Array.from({ length: maximumEspnBridgeLeagues + 1 }, (_, index) => String(index)).join(","),
      ),
    ).toThrow("at most 32");
  });
});
