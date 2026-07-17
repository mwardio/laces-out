import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseYahooLeaguePageXml,
  parseYahooLeagueSyncArtifacts,
  parseYahooLeagueXml,
  parseYahooXml,
  YahooXmlError,
} from "./xml.js";

const fixture = readFileSync(
  new URL("../test/fixtures/sanitized-league.xml", import.meta.url),
  "utf8",
);

function fixtureNamed(name: string): string {
  return readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
}

describe("Yahoo XML normalization", () => {
  it("normalizes a sanitized league/settings/team/roster fixture", () => {
    const bundle = parseYahooLeagueXml(fixture, {
      fetchedAt: new Date("2026-07-16T12:00:00.000Z"),
      endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345",
    });

    expect(bundle.league).toMatchObject({
      externalId: "449.l.12345",
      providerLeagueId: "12345",
      season: 2026,
      name: "Sanitized Auction League",
      settings: {
        teamCount: 2,
        draftType: "auction",
        auctionBudget: 200,
        waiverType: "faab",
        faabBudget: 100,
      },
    });
    expect(bundle.league.settings.rosterSlots).toEqual([
      { position: "QB", count: 1, starting: true },
      { position: "W/R/T", count: 1, starting: true },
      { position: "BN", count: 2, starting: false },
    ]);
    expect(bundle.league.settings.scoringRules).toContainEqual({
      statId: "4",
      name: "Passing Yards",
      points: 0.04,
    });
    expect(bundle.teams).toHaveLength(2);
    expect(bundle.teams[0]).toMatchObject({
      externalId: "449.l.12345.t.1",
      providerTeamId: "1",
      isCurrentUser: true,
      managers: [{ externalId: "1001", displayName: "Sanitized Manager", isCommissioner: true }],
      roster: [
        {
          externalId: "449.p.9001",
          providerPlayerId: "9001",
          fullName: "Example Quarterback",
          lineupSlot: "QB",
        },
      ],
    });
    expect(bundle.provenance.artifactChecksumSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects doctype/entity payloads before parsing", () => {
    const malicious = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><fantasy_content><league><name>&leak;</name></league></fantasy_content>`;
    expect(() => parseYahooXml(malicious)).toThrowError(YahooXmlError);
    try {
      parseYahooXml(malicious);
    } catch (error) {
      expect(error).toMatchObject({ code: "UNSAFE_XML" });
    }
  });

  it("parses paginated logged-in league discovery without numeric-ID coercion", () => {
    const first = parseYahooLeaguePageXml(fixtureNamed("sanitized-user-leagues-page-1.xml"));
    const second = parseYahooLeaguePageXml(fixtureNamed("sanitized-user-leagues-page-2.xml"));

    expect(first).toEqual({
      start: 0,
      returned: 1,
      leagues: [
        {
          provider: "yahoo",
          externalId: "449.l.12345",
          providerLeagueId: "12345",
          season: 2026,
          name: "Sanitized Auction League",
        },
      ],
    });
    expect(second).toEqual({ start: 1, returned: 0, leagues: [] });
  });

  it("joins settings, teams, rosters, standings, and scoreboard into one strict bundle", () => {
    const bundle = parseYahooLeagueSyncArtifacts({
      settingsXml: fixtureNamed("sanitized-settings.xml"),
      teamsXml: fixtureNamed("sanitized-teams.xml"),
      rostersXml: fixtureNamed("sanitized-rosters.xml"),
      standingsXml: fixtureNamed("sanitized-standings.xml"),
      matchupsXml: fixtureNamed("sanitized-scoreboard.xml"),
      fetchedAt: new Date("2026-07-16T12:00:00.000Z"),
      endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345",
    });

    expect(bundle.league).toMatchObject({
      externalId: "449.l.12345",
      season: 2026,
      currentWeek: 4,
      settings: { teamCount: 2, draftType: "auction", waiverType: "faab" },
    });
    expect(bundle.teams.map((team) => [team.externalId, team.roster.length])).toEqual([
      ["449.l.12345.t.1", 1],
      ["449.l.12345.t.2", 1],
    ]);
    expect(bundle.standings?.entries[0]).toMatchObject({
      teamExternalId: "449.l.12345.t.1",
      rank: 1,
      wins: 3,
      pointsFor: 421.5,
    });
    expect(bundle.matchups?.matchups[0]).toMatchObject({
      providerMatchupId: "4-1",
      week: 4,
      status: "final",
      winnerTeamExternalId: "449.l.12345.t.1",
      home: { score: 112.6 },
      away: { score: 101.4 },
    });
    expect(bundle.provenance.artifactChecksumSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when a weekly artifact belongs to another league", () => {
    expect(() =>
      parseYahooLeagueSyncArtifacts({
        settingsXml: fixtureNamed("sanitized-settings.xml"),
        teamsXml: fixtureNamed("sanitized-teams.xml"),
        rostersXml: fixtureNamed("sanitized-rosters.xml"),
        standingsXml: fixtureNamed("sanitized-standings.xml").replace(
          "449.l.12345</league_key>",
          "449.l.99999</league_key>",
        ),
        matchupsXml: fixtureNamed("sanitized-scoreboard.xml"),
        fetchedAt: new Date("2026-07-16T12:00:00.000Z"),
        endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345",
      }),
    ).toThrowError(/different leagues/u);
  });
});
