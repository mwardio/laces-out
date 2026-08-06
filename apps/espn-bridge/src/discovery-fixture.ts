// Sanitized ESPN fan-profile payload matching the community-documented shape of
// `https://fan.api.espn.com/apis/v2/fans/{SWID}`. IDs and names are invented.
// Re-verify against a live signed-in response before each store release: the
// endpoint is unofficial and this fixture is the parser's source of truth.
export const fanProfileFixture = {
  id: "{123E4567-E89B-42D3-A456-426614174000}",
  preferences: [
    {
      id: "9:44210001",
      typeId: 9,
      type: { id: 9, code: "fantasyLeagueManager" },
      metaData: {
        entry: {
          entryId: 44210001,
          gameId: 1,
          seasonId: 2026,
          abbrev: "FFL2026",
          entryMetadata: { teamName: "  Laces   Out!  ", teamAbbrev: "LACE" },
          groups: [
            {
              groupId: 111222333,
              groupName: "Championship Chasers",
              href: "https://fantasy.espn.com/football/league?leagueId=111222333",
            },
          ],
        },
      },
    },
    {
      // Same league reached through a second (co-managed) entry: must dedupe.
      id: "9:44210002",
      typeId: 9,
      metaData: {
        entry: {
          entryId: 44210002,
          gameId: 1,
          seasonId: 2026,
          entryMetadata: { teamName: "Substitute Squad" },
          groups: [{ groupId: 111222333, groupName: "Championship Chasers" }],
        },
      },
    },
    {
      // String game code variant with a string group id.
      id: "9:44210003",
      typeId: 9,
      metaData: {
        entry: {
          gameId: "ffl",
          seasonId: 2026,
          entryMetadata: { teamName: "Bench Warmers" },
          groups: [{ groupId: "444555666", groupName: "Air It Out" }],
        },
      },
    },
    {
      // Fantasy hockey: must be filtered from football discovery.
      id: "9:44210004",
      typeId: 9,
      metaData: {
        entry: {
          gameId: 4,
          seasonId: 2026,
          abbrev: "FHL2026",
          entryMetadata: { teamName: "Zamboni Drivers" },
          groups: [{ groupId: 999888777, groupName: "Ice Kings" }],
        },
      },
    },
    {
      // Prior-season football league: excluded while 2026 matches exist.
      id: "9:44210005",
      typeId: 9,
      metaData: {
        entry: {
          gameId: 1,
          seasonId: 2025,
          entryMetadata: { teamName: "Last Year's Heroes" },
          groups: [{ groupId: 121212121, groupName: "Throwback League" }],
        },
      },
    },
    {
      // No game marker at all: kept, with fallbacks for name and season.
      id: "9:44210006",
      typeId: 9,
      metaData: {
        entry: {
          groups: [{ groupId: 606060606 }],
        },
      },
    },
    {
      // Malformed entries the parser must skip without throwing.
      id: "9:44210007",
      typeId: 9,
      metaData: {
        entry: {
          gameId: 1,
          seasonId: 2026,
          groups: [{ groupId: "not-digits", groupName: "Broken" }, "garbage", null],
        },
      },
    },
    { id: "broken-preference-without-metadata", typeId: 9 },
    null,
    "garbage-preference",
  ],
} as const;
