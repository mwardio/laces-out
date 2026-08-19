import type { LeagueSyncBundle, NormalizedTeam } from "@laces-out/connectors";
import { describe, expect, it } from "vitest";

import {
  espnRefreshPolicy,
  espnServerSessionCurrentIdentity,
  espnServerSessionCurrentTeamExternalKey,
  type EspnSyncAuthority,
} from "./espn-sync-persistence.js";

const serverSessionAuthority: EspnSyncAuthority = {
  mode: "server-session",
  actorUserId: "user-1",
  connectionId: "connection-1",
  leagueSeasonId: "season-1",
};

function team(
  externalId: string,
  isCurrentUser: boolean,
  currentUserIsCommissioner: boolean | null,
): NormalizedTeam {
  return {
    externalId,
    providerTeamId: externalId.slice(-1),
    name: `Team ${externalId}`,
    abbreviation: null,
    url: null,
    logoUrl: null,
    isCurrentUser,
    currentUserIsCommissioner: isCurrentUser ? currentUserIsCommissioner : null,
    managers: [],
    roster: [],
  };
}

function bundle(
  input: {
    readonly mode?: LeagueSyncBundle["provenance"]["mode"];
    readonly currentTeamIds?: readonly string[];
    readonly currentUserIsCommissioner?: boolean | null;
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
      team(externalId, current.has(externalId), input.currentUserIsCommissioner ?? null),
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
    expect(
      espnServerSessionCurrentIdentity({
        authority: serverSessionAuthority,
        bundle: bundle({
          currentTeamIds: ["espn:2031:12345:team:1"],
          currentUserIsCommissioner: true,
        }),
        kind: "espn-session",
      }),
    ).toEqual({
      teamExternalKey: "espn:2031:12345:team:1",
      isCommissioner: true,
    });
  });

  it.each([
    [false, false],
    [null, null],
  ] as const)("preserves an exact %s commissioner signal", (signal, expected) => {
    expect(
      espnServerSessionCurrentIdentity({
        authority: serverSessionAuthority,
        bundle: bundle({
          currentTeamIds: ["espn:2031:12345:team:1"],
          currentUserIsCommissioner: signal,
        }),
        kind: "espn-session",
      }),
    ).toEqual({
      teamExternalKey: "espn:2031:12345:team:1",
      isCommissioner: expected,
    });
  });

  it("fails closed when active-member context identified no team", () => {
    expect(
      espnServerSessionCurrentTeamExternalKey({
        authority: serverSessionAuthority,
        bundle: bundle(),
        kind: "espn-session",
      }),
    ).toBeNull();
    expect(
      espnServerSessionCurrentIdentity({
        authority: serverSessionAuthority,
        bundle: bundle({ currentUserIsCommissioner: true }),
        kind: "espn-session",
      }),
    ).toEqual({ teamExternalKey: null, isCommissioner: null });
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
    expect(
      espnServerSessionCurrentIdentity({
        authority: serverSessionAuthority,
        bundle: {
          ...marked,
          teams: marked.teams.map((candidate) => ({
            ...candidate,
            currentUserIsCommissioner: candidate.isCurrentUser ? true : null,
          })),
          provenance: { ...marked.provenance, mode: "browser-local" },
        },
        kind: "espn-session",
      }),
    ).toEqual({ teamExternalKey: null, isCommissioner: null });
  });
});

describe("ESPN refresh membership policy", () => {
  it("grants new joiners the canonical member role", () => {
    expect(
      espnRefreshPolicy({
        createdLeague: false,
        actorIsAnchoredOwner: false,
        existingMembershipRole: null,
      }),
    ).toEqual({ membershipGrant: "member" });
  });

  it("preserves an existing role and the canonical owner", () => {
    expect(
      espnRefreshPolicy({
        createdLeague: false,
        actorIsAnchoredOwner: false,
        existingMembershipRole: "commissioner",
      }),
    ).toEqual({ membershipGrant: null });
    expect(
      espnRefreshPolicy({
        createdLeague: false,
        actorIsAnchoredOwner: true,
        existingMembershipRole: "member",
      }),
    ).toEqual({ membershipGrant: "owner" });
  });
});
