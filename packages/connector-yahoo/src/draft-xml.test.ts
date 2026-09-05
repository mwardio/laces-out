import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseYahooDraftPlayersXml,
  parseYahooDraftResultsXml,
  SECURE_YAHOO_XML_OPTIONS,
  YahooXmlError,
} from "./xml.js";

function fixtureNamed(name: string): string {
  return readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
}

const draftResultsXml = fixtureNamed("sanitized-draft-results.xml");
const draftPlayersXml = fixtureNamed("sanitized-draft-players.xml");

function invalidContract(action: () => unknown): void {
  expect(action).toThrowError(YahooXmlError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code: "INVALID_CONTRACT" });
  }
}

describe("Yahoo draft result XML normalization", () => {
  it("normalizes repeated auction draft results with exact scoped identities", () => {
    const snapshot = parseYahooDraftResultsXml(draftResultsXml, {
      expectedLeagueKey: "449.l.12345",
    });

    expect(snapshot).toMatchObject({
      leagueKey: "449.l.12345",
      leagueId: "12345",
      status: "drafting",
      providerStatus: "drafting",
      declaredCount: 3,
      observedCount: 3,
      collectionComplete: true,
      refreshRateSeconds: 60,
      picks: [
        {
          pick: 1,
          round: 1,
          teamKey: "449.l.12345.t.1",
          teamId: "1",
          playerKey: "449.p.9001",
          playerId: "9001",
          cost: 47,
          keeper: null,
        },
        {
          pick: 2,
          round: 1,
          teamKey: "449.l.12345.t.2",
          teamId: "2",
          playerKey: "449.p.9002",
          playerId: "9002",
          cost: 35,
          keeper: null,
        },
        {
          pick: 3,
          round: 2,
          teamKey: "449.l.12345.t.2",
          teamId: "2",
          playerKey: "449.p.9003",
          playerId: "9003",
          cost: 18,
          keeper: null,
        },
      ],
    });
    expect(snapshot.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(SECURE_YAHOO_XML_OPTIONS.isArray("draft_result")).toBe(true);
  });

  it("handles one draft_result securely and keeps absent standard-draft costs nullable", () => {
    const onePick = draftResultsXml
      .replace('draft_results count="3"', 'draft_results count="1"')
      .replace(
        /\s*<draft_result>\s*<pick>2<\/pick>[\s\S]*<\/draft_result>\s*<\/draft_results>/u,
        "\n    </draft_results>",
      )
      .replace(/\s*<cost>47<\/cost>/u, "");

    expect(parseYahooDraftResultsXml(onePick).picks).toEqual([
      {
        pick: 1,
        round: 1,
        teamKey: "449.l.12345.t.1",
        teamId: "1",
        playerKey: "449.p.9001",
        playerId: "9001",
        cost: null,
        keeper: null,
      },
    ]);
  });

  it("retains round-pick and keeper metadata only when Yahoo supplies it", () => {
    const withOptionalMetadata = draftResultsXml
      .replace("<round>1</round>", "<round>1</round><round_pick>1</round_pick>")
      .replace("<cost>47</cost>", "<cost>47</cost><is_keeper>1</is_keeper>");

    expect(parseYahooDraftResultsXml(withOptionalMetadata).picks[0]).toMatchObject({
      roundPick: 1,
      keeper: true,
    });
  });

  it("allows an explicitly empty predraft collection", () => {
    const predraft = `<?xml version="1.0"?>
      <fantasy_content xmlns="http://fantasysports.yahooapis.com/fantasy/v2/base.rng">
        <league>
          <league_key>449.l.12345</league_key><league_id>12345</league_id>
          <draft_status>predraft</draft_status><draft_results/>
        </league>
      </fantasy_content>`;

    expect(parseYahooDraftResultsXml(predraft)).toMatchObject({
      status: "predraft",
      declaredCount: 0,
      observedCount: 0,
      collectionComplete: true,
      refreshRateSeconds: null,
      picks: [],
    });
  });

  it("accepts an empty active collection before pick one", () => {
    const drafting = `<?xml version="1.0"?>
      <fantasy_content xmlns="http://fantasysports.yahooapis.com/fantasy/v2/base.rng">
        <league>
          <league_key>449.l.12345</league_key><league_id>12345</league_id>
          <draft_status>drafting</draft_status><draft_results count="0"/>
        </league>
      </fantasy_content>`;

    expect(parseYahooDraftResultsXml(drafting)).toMatchObject({
      status: "drafting",
      declaredCount: 0,
      observedCount: 0,
      collectionComplete: true,
      picks: [],
    });
  });

  it("hashes normalized draft facts instead of volatile response-envelope metadata", () => {
    const original = parseYahooDraftResultsXml(draftResultsXml);
    const envelopeChanged = parseYahooDraftResultsXml(
      draftResultsXml.replace('refresh_rate="60"', 'refresh_rate="61"'),
    );
    const pickChanged = parseYahooDraftResultsXml(
      draftResultsXml.replace("<cost>47</cost>", "<cost>48</cost>"),
    );

    expect(envelopeChanged.checksumSha256).toBe(original.checksumSha256);
    expect(pickChanged.checksumSha256).not.toBe(original.checksumSha256);
  });

  it("exposes a declared truncation without treating it as complete", () => {
    const truncated = draftResultsXml.replace('draft_results count="3"', 'draft_results count="4"');

    expect(parseYahooDraftResultsXml(truncated)).toMatchObject({
      declaredCount: 4,
      observedCount: 3,
      collectionComplete: false,
    });
  });

  it("rejects draft picks that contradict a predraft provider status", () => {
    invalidContract(() =>
      parseYahooDraftResultsXml(
        draftResultsXml.replace(
          "<draft_status>drafting</draft_status>",
          "<draft_status>predraft</draft_status>",
        ),
      ),
    );
  });

  it.each([
    ["duplicate pick", "<pick>2</pick>", "<pick>1</pick>"],
    ["gapped pick", "<pick>2</pick>", "<pick>4</pick>"],
    ["zero round", "<round>2</round>", "<round>0</round>"],
    ["negative cost", "<cost>35</cost>", "<cost>-1</cost>"],
    ["fractional cost", "<cost>35</cost>", "<cost>3.5</cost>"],
    ["empty cost", "<cost>35</cost>", "<cost></cost>"],
    ["wrong team league", "449.l.12345.t.1", "449.l.99999.t.1"],
    ["wrong player game", "449.p.9001", "450.p.9001"],
    ["repeated player", "449.p.9002", "449.p.9001"],
    ["oversized refresh hint", 'refresh_rate="60"', 'refresh_rate="3601"'],
  ])("fails closed for %s", (_label, from, to) => {
    invalidContract(() => parseYahooDraftResultsXml(draftResultsXml.replace(from, to)));
  });

  it("rejects inconsistent league identity, overfull counts, and empty completed results", () => {
    invalidContract(() =>
      parseYahooDraftResultsXml(
        draftResultsXml.replace("<league_id>12345</league_id>", "<league_id>99</league_id>"),
      ),
    );
    invalidContract(() =>
      parseYahooDraftResultsXml(
        draftResultsXml.replace('draft_results count="3"', 'draft_results count="2"'),
      ),
    );
    invalidContract(() =>
      parseYahooDraftResultsXml(`<?xml version="1.0"?>
        <fantasy_content><league>
          <league_key>449.l.12345</league_key><league_id>12345</league_id>
          <draft_status>postdraft</draft_status><draft_results count="0"/>
        </league></fantasy_content>`),
    );
    invalidContract(() =>
      parseYahooDraftResultsXml(draftResultsXml, { expectedLeagueKey: "449.l.99999" }),
    );
  });
});

describe("Yahoo exact draft player XML normalization", () => {
  it("resolves the exact requested player keys with bounded identity metadata", () => {
    const snapshot = parseYahooDraftPlayersXml(draftPlayersXml, {
      expectedLeagueKey: "449.l.12345",
      expectedPlayerKeys: ["449.p.9003", "449.p.9001", "449.p.9002"],
    });

    expect(snapshot).toMatchObject({
      leagueKey: "449.l.12345",
      leagueId: "12345",
      declaredCount: 3,
      observedCount: 3,
      collectionComplete: true,
      players: [
        {
          playerKey: "449.p.9003",
          playerId: "9003",
          fullName: "Example Running Back",
          proTeamAbbreviation: "DET",
          primaryPosition: "RB",
          eligiblePositions: ["RB", "W/R/T"],
        },
        {
          playerKey: "449.p.9001",
          playerId: "9001",
          fullName: "Example Quarterback",
          proTeamAbbreviation: "BUF",
          primaryPosition: "QB",
          eligiblePositions: ["QB"],
        },
        {
          playerKey: "449.p.9002",
          playerId: "9002",
          fullName: "Example Receiver",
          proTeamAbbreviation: "SEA",
          primaryPosition: "WR",
          eligiblePositions: ["WR", "W/R/T"],
        },
      ],
    });
    expect(snapshot.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed unless the response resolves the exact expected set", () => {
    invalidContract(() =>
      parseYahooDraftPlayersXml(draftPlayersXml, {
        expectedPlayerKeys: ["449.p.9001", "449.p.9002"],
      }),
    );
    invalidContract(() =>
      parseYahooDraftPlayersXml(draftPlayersXml, {
        expectedPlayerKeys: ["449.p.9001", "449.p.9002", "449.p.9999"],
      }),
    );
    expect(() =>
      parseYahooDraftPlayersXml(draftPlayersXml, {
        expectedPlayerKeys: ["449.p.9001", "449.p.9001"],
      }),
    ).toThrowError(TypeError);
  });

  it.each([
    ["wrong player game", "449.p.9001", "450.p.9001"],
    ["mismatched player id", "<player_id>9001</player_id>", "<player_id>99</player_id>"],
    ["duplicate player", "449.p.9002", "449.p.9001"],
    ["missing positions", "<eligible_positions><position>QB</position></eligible_positions>", ""],
    ["wrong declared count", 'players count="3"', 'players count="4"'],
  ])("rejects %s", (_label, from, to) => {
    const changed = draftPlayersXml
      .replace(from, to)
      .replace(
        "<display_position>QB</display_position>",
        from.startsWith("<eligible_positions>") ? "" : "<display_position>QB</display_position>",
      );
    invalidContract(() => parseYahooDraftPlayersXml(changed));
  });
});
