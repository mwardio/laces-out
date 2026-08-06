import { describe, expect, it } from "vitest";

import { fanProfileEndpoint, parseFanProfileLeagues } from "./discovery.js";
import { fanProfileFixture } from "./discovery-fixture.js";
import { maximumLeagueCount } from "./protocol.js";

describe("fan profile endpoint", () => {
  it("builds the fixed fans path from a validated braced SWID only", () => {
    const endpoint = fanProfileEndpoint("{123e4567-e89b-42d3-a456-426614174000}");
    expect(endpoint.origin).toBe("https://fan.api.espn.com");
    expect(endpoint.pathname).toBe("/apis/v2/fans/%7B123e4567-e89b-42d3-a456-426614174000%7D");
    expect(endpoint.search).toBe("");
  });

  it.each([
    "123e4567-e89b-42d3-a456-426614174000",
    "{not-a-uuid}",
    "{123e4567-e89b-42d3-a456-426614174000}/../secrets",
    "",
  ])("rejects a SWID that is not exactly a braced UUID: %s", (swid) => {
    expect(() => fanProfileEndpoint(swid)).toThrow("SWID");
  });
});

describe("fan profile league extraction", () => {
  it("extracts, dedupes, and sorts the requested season's football leagues", () => {
    expect(parseFanProfileLeagues(fanProfileFixture, 2026)).toEqual({
      seasonMatched: true,
      leagues: [
        {
          leagueId: "444555666",
          leagueName: "Air It Out",
          teamName: "Bench Warmers",
          seasonId: 2026,
        },
        {
          leagueId: "111222333",
          leagueName: "Championship Chasers",
          teamName: "Laces Out!",
          seasonId: 2026,
        },
        // Marker-less entry: kept with name and season fallbacks rather than
        // silently dropped when ESPN renames a field.
        { leagueId: "606060606", leagueName: "ESPN league 606060606", seasonId: 2026 },
      ],
    });
  });

  it("assumes the requested season for entries that carry no season at all", () => {
    const result = parseFanProfileLeagues(fanProfileFixture, 2027);
    expect(result.seasonMatched).toBe(true);
    expect(result.leagues).toEqual([
      { leagueId: "606060606", leagueName: "ESPN league 606060606", seasonId: 2027 },
    ]);
  });

  it("falls back to every discovered league when the requested season has none", () => {
    const seasonedOnly = {
      preferences: fanProfileFixture.preferences.filter(
        (preference) =>
          typeof preference === "object" &&
          preference !== null &&
          "id" in preference &&
          preference.id !== "9:44210006",
      ),
    };
    const result = parseFanProfileLeagues(seasonedOnly, 2027);
    expect(result.seasonMatched).toBe(false);
    expect(result.leagues.map((league) => league.leagueId).sort()).toEqual([
      "111222333",
      "121212121",
      "444555666",
    ]);
  });

  it("never includes non-football entries or malformed groups", () => {
    const leagueIds = parseFanProfileLeagues(fanProfileFixture, 2026).leagues.map(
      (league) => league.leagueId,
    );
    expect(leagueIds).not.toContain("999888777");
    expect(leagueIds).not.toContain("not-digits");
  });

  it.each([null, "garbage", 7, [], {}, { preferences: "nope" }, { preferences: [] }])(
    "returns an empty matched set for unusable payloads: %j",
    (payload) => {
      expect(parseFanProfileLeagues(payload, 2026)).toEqual({
        leagues: [],
        seasonMatched: true,
      });
    },
  );

  it("caps the discovered list at the pairing maximum", () => {
    const payload = {
      preferences: Array.from({ length: maximumLeagueCount + 8 }, (_, index) => ({
        metaData: {
          entry: {
            gameId: 1,
            seasonId: 2026,
            groups: [{ groupId: index + 1, groupName: `League ${index + 1}` }],
          },
        },
      })),
    };
    expect(parseFanProfileLeagues(payload, 2026).leagues).toHaveLength(maximumLeagueCount);
  });
});
