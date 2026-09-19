import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYahooLeagueSyncArtifacts, parseYahooLeagueXml } from "./xml.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
const rosters = fixture("sanitized-rosters.xml");
const combined = fixture("sanitized-league.xml");
const firstPlayer = /<player>[\s\S]*?<\/player>/u.exec(rosters)![0];
const artifacts = {
  settingsXml: fixture("sanitized-settings.xml"),
  teamsXml: fixture("sanitized-teams.xml"),
  rostersXml: rosters,
  standingsXml: fixture("sanitized-standings.xml"),
  matchupsXml: fixture("sanitized-scoreboard.xml"),
  fetchedAt: new Date("2026-09-19T12:00:00.000Z"),
  endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345",
};
const firstRoster = /<roster\b[^>]*>[\s\S]*?<\/roster>/u;
function parseFirstRoster(replacement: string) {
  return parseYahooLeagueSyncArtifacts({
    ...artifacts,
    rostersXml: rosters.replace(firstRoster, replacement),
  });
}

const malformed = [
  ["missing roster", ""],
  ["empty roster", '<roster week="4"/>'],
  ["missing players", '<roster week="4"><coverage_type>week</coverage_type></roster>'],
  ["missing count", `<roster week="4"><players>${firstPlayer}</players></roster>`],
  ["empty without count", '<roster week="4"><players/></roster>'],
  ["negative count", `<roster week="4"><players count="-1">${firstPlayer}</players></roster>`],
  ["fractional count", `<roster week="4"><players count="1.5">${firstPlayer}</players></roster>`],
  [
    "unsafe count",
    `<roster week="4"><players count="9007199254740993">${firstPlayer}</players></roster>`,
  ],
  ["understated count", `<roster week="4"><players count="0">${firstPlayer}</players></roster>`],
  ["overstated count", `<roster week="4"><players count="2">${firstPlayer}</players></roster>`],
  ["truncated collection", '<roster week="4"><players count="1"/></roster>'],
  ["malformed player", '<roster week="4"><players count="1"><player/></players></roster>'],
  [
    "missing player key",
    `<roster week="4"><players count="1">${firstPlayer.replace(/<player_key>[^<]*<\/player_key>/u, "")}</players></roster>`,
  ],
  [
    "missing player id",
    `<roster week="4"><players count="1">${firstPlayer.replace(/<player_id>[^<]*<\/player_id>/u, "")}</players></roster>`,
  ],
  [
    "missing player name",
    `<roster week="4"><players count="1">${firstPlayer.replace(/<name>[\s\S]*?<\/name>/u, "")}</players></roster>`,
  ],
  [
    "mismatched player id",
    `<roster week="4"><players count="1">${firstPlayer.replace("<player_id>9001</player_id>", "<player_id>9002</player_id>")}</players></roster>`,
  ],
  [
    "wrong game identity",
    `<roster week="4"><players count="1">${firstPlayer.replace("449.p.9001", "399.p.9001")}</players></roster>`,
  ],
  [
    "duplicate player",
    `<roster week="4"><players count="2">${firstPlayer}${firstPlayer}</players></roster>`,
  ],
  [
    "unexpected collection wrapper",
    '<roster week="4"><players count="0"><results/></players></roster>',
  ],
  [
    "player outside counted collection",
    `<roster week="4"><players count="0"/>${firstPlayer}</roster>`,
  ],
  [
    "duplicate players collection",
    '<roster week="4"><players count="0"/><players count="0"/></roster>',
  ],
  [
    "duplicate roster",
    '<roster week="4"><players count="0"/></roster><roster week="4"><players count="0"/></roster>',
  ],
  ["stale coverage week", `<roster week="3"><players count="1">${firstPlayer}</players></roster>`],
  [
    "invalid coverage week",
    `<roster week="invalid"><players count="1">${firstPlayer}</players></roster>`,
  ],
  [
    "conflicting coverage week",
    `<roster week="4"><week>3</week><players count="1">${firstPlayer}</players></roster>`,
  ],
] as const;

describe("complete Yahoo roster collections", () => {
  it("accepts Yahoo's explicitly empty predraft element with observed child week metadata", () => {
    const settingsXml = artifacts.settingsXml.replace(
      "<current_week>4</current_week>",
      "<current_week>2</current_week><draft_status>predraft</draft_status>",
    );
    const rostersXml = rosters.replaceAll(
      /<roster\b[^>]*>[\s\S]*?<\/roster>/gu,
      "<roster><coverage_type>week</coverage_type><week>2</week><players/></roster>",
    );
    const bundle = parseYahooLeagueSyncArtifacts({ ...artifacts, settingsXml, rostersXml });
    expect(bundle.league.settings.draftStatus).toBe("predraft");
    expect(bundle.teams.map((team) => team.roster)).toEqual([[], []]);
    const complete = combined
      .replace(
        "<current_week>1</current_week>",
        "<current_week>2</current_week><draft_status>predraft</draft_status>",
      )
      .replaceAll(
        /<roster\b[^>]*>[\s\S]*?<\/roster>/gu,
        "<roster><coverage_type>week</coverage_type><week>2</week><players/></roster>",
      );
    expect(parseYahooLeagueXml(complete).teams.map((team) => team.roster)).toEqual([[], []]);
  });

  it.each([
    "<roster/>",
    "<roster><week>4</week></roster>",
    "<roster><players>unavailable</players></roster>",
    "<roster><players><results/></players></roster>",
    `<roster><players/>${firstPlayer}</roster>`,
  ])("does not reinterpret malformed predraft structure as an empty roster: %s", (replacement) => {
    const settingsXml = artifacts.settingsXml.replace(
      "<league_id>12345</league_id>",
      "<league_id>12345</league_id><draft_status>predraft</draft_status>",
    );
    expect(() =>
      parseYahooLeagueSyncArtifacts({
        ...artifacts,
        settingsXml,
        rostersXml: rosters.replace(firstRoster, replacement),
      }),
    ).toThrowError(expect.objectContaining({ code: "INCOMPLETE_ROSTER" }));
  });

  it.each(["drafting", "postdraft", "unknown"])(
    "rejects uncounted empty players when provider status is %s",
    (status) => {
      const settingsXml = artifacts.settingsXml.replace(
        "<league_id>12345</league_id>",
        `<league_id>12345</league_id><draft_status>${status}</draft_status>`,
      );
      expect(() =>
        parseYahooLeagueSyncArtifacts({
          ...artifacts,
          settingsXml,
          rostersXml: rosters.replace(firstRoster, "<roster><players/></roster>"),
        }),
      ).toThrowError(expect.objectContaining({ code: "INCOMPLETE_ROSTER" }));
    },
  );

  it.each(malformed)(
    "rejects %s before producing any replacement snapshot",
    (_name, replacement) => {
      expect(() => parseFirstRoster(replacement)).toThrowError(
        expect.objectContaining({ code: "INCOMPLETE_ROSTER" }),
      );
    },
  );

  it.each(["predraft", "drafting", "postdraft", null])(
    "preserves explicitly empty rosters with draft status %s",
    (status) => {
      const settingsXml =
        status === null
          ? artifacts.settingsXml
          : artifacts.settingsXml.replace(
              "<league_id>12345</league_id>",
              `<league_id>12345</league_id><draft_status>${status}</draft_status>`,
            );
      const bundle = parseYahooLeagueSyncArtifacts({
        ...artifacts,
        settingsXml,
        rostersXml: rosters.replaceAll(
          /<roster\b[^>]*>[\s\S]*?<\/roster>/gu,
          '<roster><players count="0"/></roster>',
        ),
      });
      expect(bundle.teams.map((team) => team.roster)).toEqual([[], []]);
      expect(bundle.league.settings.draftStatus).toBe(status ?? undefined);
      expect(bundle.warnings.some((warning) => warning.includes("Skipped a Yahoo roster"))).toBe(
        false,
      );
    },
  );

  it("accepts a complete empty team alongside an occupied team without inferring draft status", () => {
    const bundle = parseFirstRoster('<roster week="4"><players count="0"></players></roster>');
    expect(bundle.teams.map((team) => team.roster.length)).toEqual([0, 1]);
    expect(bundle.league.settings.draftStatus).toBeUndefined();
  });

  it("accepts matching child-based week metadata", () => {
    const bundle = parseFirstRoster(
      `<roster><coverage_type>week</coverage_type><week>4</week><players count="1">${firstPlayer}</players></roster>`,
    );
    expect(bundle.teams[0]?.roster).toHaveLength(1);
  });

  it("applies the same completeness rules to combined league artifacts", () => {
    expect(() => parseYahooLeagueXml(combined.replace(firstRoster, ""))).toThrowError(
      expect.objectContaining({ code: "INCOMPLETE_ROSTER" }),
    );
    const bundle = parseYahooLeagueXml(
      combined.replace(firstRoster, '<roster week="1"><players count="0"/></roster>'),
    );
    expect(bundle.teams.map((team) => team.roster.length)).toEqual([0, 1]);
  });

  it("preserves a long provider identity exactly rather than rounding it", () => {
    const id = "9007199254740993";
    const bundle = parseFirstRoster(
      `<roster week="4"><players count="1">${firstPlayer.replaceAll("9001", id)}</players></roster>`,
    );
    expect(bundle.teams[0]?.roster[0]).toMatchObject({
      externalId: `449.p.${id}`,
      providerPlayerId: id,
    });
  });

  it.each([
    ["in_draft", "drafting"],
    ["postdraft", "postdraft"],
    ["future-status", "unknown"],
  ])("retains normalized provider draft state %s as %s in core settings", (status, expected) => {
    const bundle = parseYahooLeagueSyncArtifacts({
      ...artifacts,
      settingsXml: artifacts.settingsXml.replace(
        "<league_id>12345</league_id>",
        `<league_id>12345</league_id><draft_status>${status}</draft_status>`,
      ),
    });
    expect(bundle.league.settings.draftStatus).toBe(expected);
    expect(JSON.parse(JSON.stringify(bundle.league.settings))).toMatchObject({
      draftStatus: expected,
    });
  });
});
