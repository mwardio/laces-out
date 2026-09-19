import { readFileSync } from "node:fs";
import type { YahooXmlArtifact } from "@laces-out/connector-yahoo";
import type { LeagueSyncBundle } from "@laces-out/connectors";
import { describe, expect, it, vi } from "vitest";
import { YahooSyncService, type YahooReadPort, type YahooSyncRepository } from "./yahoo-sync.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const fixture = (name: string) =>
  readFileSync(new URL(`../../connector-yahoo/test/fixtures/${name}`, import.meta.url), "utf8");
const artifact = (xml: string): Promise<YahooXmlArtifact> =>
  Promise.resolve({
    xml,
    endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/test",
    fetchedAt: NOW.toISOString(),
    contentType: "application/xml",
    etag: null,
    lastModified: null,
  });
function harness() {
  let rostersXml = fixture("sanitized-rosters.xml");
  let settingsXml = fixture("sanitized-settings.xml");
  let saved: LeagueSyncBundle | undefined;
  const persistBundle = vi.fn<YahooSyncRepository["persistBundle"]>(
    async (_user, _connection, bundle) => {
      saved = bundle;
      return {
        syncRunId: "fixture-run",
        leagueId: "fixture-league",
        leagueSeasonId: "fixture-season",
        externalLeagueKey: bundle.league.externalId,
        season: bundle.league.season,
        state: "accepted",
        recordsWritten: 12,
        syncedAt: NOW.toISOString(),
      };
    },
  );
  const markFailure = vi.fn<YahooSyncRepository["markFailure"]>(async () => {});
  const markLeagueFailure = vi.fn<YahooSyncRepository["markLeagueFailure"]>(async () => {});
  const repository: YahooSyncRepository = {
    findOwnedConnection: async () => ({
      id: "fixture-connection",
      health: "healthy",
      circuitOpenUntil: null,
      lastErrorCode: null,
    }),
    listConnectionStatus: async () => [],
    disconnectOwnedConnection: async () => true,
    listLeagueExclusions: async () => [],
    clearLeagueExclusions: async () => {},
    markDiscoverySuccess: async () => {},
    persistBundle,
    markFailure,
    markLeagueFailure,
  };
  const client: YahooReadPort = {
    getUserLeagues: () => artifact(fixture("sanitized-user-leagues-page-2.xml")),
    getLeagueSettings: () => artifact(settingsXml),
    getLeagueTeams: () => artifact(fixture("sanitized-teams.xml")),
    getLeagueRosters: () => artifact(rostersXml),
    getLeagueStandings: () => artifact(fixture("sanitized-standings.xml")),
    getLeagueMatchups: () => artifact(fixture("sanitized-scoreboard.xml")),
  };
  const service = new YahooSyncService({
    repository,
    client,
    tokens: { getAccessToken: async () => "fixture-token-must-not-leak" },
    now: () => NOW,
  });
  return {
    sync: () => service.syncLeague("fixture-user", "fixture-connection", "449.l.12345"),
    persistBundle,
    markFailure,
    markLeagueFailure,
    saved: () => saved,
    setRosters: (value: string) => {
      rostersXml = value;
    },
    setSettings: (value: string) => {
      settingsXml = value;
    },
  };
}

describe("Yahoo roster sync integrity", () => {
  it("treats failed roster-error bookkeeping as a persistence fault, not an isolated failure", async () => {
    const test = harness();
    test.setRosters(
      fixture("sanitized-rosters.xml").replace(/<roster\b[^>]*>[\s\S]*?<\/roster>/u, ""),
    );
    test.markLeagueFailure.mockRejectedValueOnce(new Error("private-database-detail"));
    await expect(test.sync()).rejects.toMatchObject({
      code: "PERSISTENCE_FAILED",
      leagueFailure: null,
      message: "Yahoo league failure could not be recorded",
    });
    expect(test.markFailure).toHaveBeenCalledExactlyOnceWith(
      "fixture-user",
      "fixture-connection",
      "persistence_failed",
      NOW,
    );
    expect(test.persistBundle).not.toHaveBeenCalled();
  });

  it.each([
    ["missing roster", (xml: string) => xml.replace(/<roster\b[^>]*>[\s\S]*?<\/roster>/u, "")],
    ["missing player identity", (xml: string) => xml.replace("<player_id>9001</player_id>", "")],
    ["truncated count", (xml: string) => xml.replace('<players count="1">', '<players count="2">')],
    ["wrong coverage week", (xml: string) => xml.replace('<roster week="4">', '<roster week="3">')],
  ] as const)(
    "preserves the accepted roster on %s and records a safe actionable error",
    async (_name, change) => {
      const test = harness();
      await test.sync();
      const original = test.saved();
      expect(original?.teams.map((team) => team.roster.length)).toEqual([1, 1]);
      test.setRosters(change(fixture("sanitized-rosters.xml")));
      await expect(test.sync()).rejects.toMatchObject({
        code: "PROVIDER_READ_FAILED",
        statusCode: 502,
        retryable: true,
        message:
          "Yahoo returned incomplete roster data. This league's stored rosters were left unchanged.",
      });
      expect(test.persistBundle).toHaveBeenCalledTimes(1);
      expect(test.saved()).toBe(original);
      expect(test.markFailure).not.toHaveBeenCalled();
      expect(test.markLeagueFailure).toHaveBeenCalledExactlyOnceWith(
        "fixture-user",
        "fixture-connection",
        {
          externalLeagueKey: "449.l.12345",
          season: null,
          code: "INCOMPLETE_ROSTER",
          message:
            "Yahoo returned incomplete roster data. This league's stored rosters were left unchanged.",
          failedAt: NOW.toISOString(),
        },
      );
    },
  );

  it("persists the real predraft empty shape and provider draft status", async () => {
    const test = harness();
    test.setSettings(
      fixture("sanitized-settings.xml").replace(
        "<current_week>4</current_week>",
        "<current_week>2</current_week><draft_status>predraft</draft_status>",
      ),
    );
    test.setRosters(
      fixture("sanitized-rosters.xml").replaceAll(
        /<roster\b[^>]*>[\s\S]*?<\/roster>/gu,
        "<roster><coverage_type>week</coverage_type><week>2</week><players/></roster>",
      ),
    );
    await expect(test.sync()).resolves.toMatchObject({ state: "accepted" });
    expect(test.saved()?.league.settings.draftStatus).toBe("predraft");
    expect(test.saved()?.teams.map((team) => team.roster)).toEqual([[], []]);
    expect(test.markFailure).not.toHaveBeenCalled();
    expect(test.persistBundle).toHaveBeenCalledTimes(1);
  });
});
