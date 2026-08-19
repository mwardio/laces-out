import type { LeagueSyncBundle, NormalizedTeam } from "@laces-out/connectors";
import { describe, expect, it } from "vitest";

import {
  espnServerSessionCurrentTeamExternalKey,
  type EspnSyncAuthority,
} from "./espn-sync-persistence.js";

const serverSessionAuthority: EspnSyncAuthority = {
  mode: "server-session",
  actorUserId: "user-1",
  connectionId: "connection-1",
  leagueSeasonId: "season-1",
};

function team(externalId: string, isCurrentUser: boolean): NormalizedTeam {
  return {
    externalId,
    providerTeamId: externalId.slice(-1),
    name: `Team ${externalId}`,
    abbreviation: null,
    url: null,
    logoUrl: null,
    isCurrentUser,
    managers: [],
    roster: [],
  };
}

function bundle(
  input: {
    readonly mode?: LeagueSyncBundle["provenance"]["mode"];
    readonly currentTeamIds?: readonly string[];
  } = {},
): LeagueSyncBundle {
  const current = new Set(input.currentTeamIds ?? []);
  return {
    schemaVersion: 1,
    provider: "espn",
    league: {
      externalId: "espn:2031:12345",
      providerLeagueId: "12345",
      provider: "espn",
      season: 2031,
      name: "Test League",
      url: null,
      currentWeek: 1,
      settings: {
        teamCount: 2,
        draftType: "snake",
        auctionBudget: null,
        waiverType: "rolling",
        faabBudget: null,
        playoffTeamCount: 2,
        rosterSlots: [],
        scoringRules: [],
      },
    },
    teams: ["espn:2031:12345:team:1", "espn:2031:12345:team:2"].map((externalId) =>
      team(externalId, current.has(externalId)),
    ),
    provenance: {
      mode: input.mode ?? "server-session",
      fetchedAt: "2031-09-16T12:00:00.000Z",
      endpoint: "https://lm-api-reads.fantasy.espn.com/test",
      artifactChecksumSha256: "a".repeat(64),
    },
    warnings: [],
  };
}

describe("ESPN server-session team identity policy", () => {
  it("accepts exactly one connector-verified current team", () => {
    expect(
      espnServerSessionCurrentTeamExternalKey({
        authority: serverSessionAuthority,
        bundle: bundle({ currentTeamIds: ["espn:2031:12345:team:1"] }),
        kind: "espn-session",
      }),
    ).toBe("espn:2031:12345:team:1");
  });

  it("fails closed when active-member context identified no team", () => {
    expect(
      espnServerSessionCurrentTeamExternalKey({
        authority: serverSessionAuthority,
        bundle: bundle(),
        kind: "espn-session",
      }),
    ).toBeNull();
  });

  it("rejects ambiguous identity instead of choosing a team", () => {
    expect(() =>
      espnServerSessionCurrentTeamExternalKey({
        authority: serverSessionAuthority,
        bundle: bundle({
          currentTeamIds: ["espn:2031:12345:team:1", "espn:2031:12345:team:2"],
        }),
        kind: "espn-session",
      }),
    ).toThrow("multiple current-user teams");
  });

  it("ignores team markers outside exact server-session provenance", () => {
    const marked = bundle({ currentTeamIds: ["espn:2031:12345:team:1"] });
    expect(
      espnServerSessionCurrentTeamExternalKey({
        authority: { mode: "server-direct", leagueSeasonId: "season-1" },
        bundle: marked,
        kind: "espn-direct",
      }),
    ).toBeNull();
    expect(
      espnServerSessionCurrentTeamExternalKey({
        authority: serverSessionAuthority,
        bundle: { ...marked, provenance: { ...marked.provenance, mode: "browser-local" } },
        kind: "espn-session",
      }),
    ).toBeNull();
  });
});
