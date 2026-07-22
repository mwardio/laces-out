import { describe, expect, it } from "vitest";

import {
  ESPN_SELF_ASSERTED_PLAYER_SOURCE,
  espnRefreshMembershipGrant,
  espnSelfAssertedPlayerIdentity,
  espnSelfAssertedPlayerKey,
  trustedEspnPlayerId,
} from "./espn-sync-persistence.js";

describe("ESPN refresh membership policy", () => {
  it("makes the first importer of a brand-new league its owner", () => {
    expect(
      espnRefreshMembershipGrant({
        createdLeague: true,
        actorIsAnchoredOwner: false,
        existingMembershipRole: null,
      }),
    ).toBe("owner");
  });

  it("grants a manager membership to a non-owner refreshing an existing shared league", () => {
    // The second legitimate member of a shared league can refresh without an owner-lock 404 and
    // is auto-enrolled as a manager so they can subsequently claim their own team.
    expect(
      espnRefreshMembershipGrant({
        createdLeague: false,
        actorIsAnchoredOwner: false,
        existingMembershipRole: null,
      }),
    ).toBe("manager");
  });

  it("never downgrades a user who already holds a membership", () => {
    for (const existingMembershipRole of ["owner", "commissioner", "manager", "viewer"] as const) {
      expect(
        espnRefreshMembershipGrant({
          createdLeague: false,
          actorIsAnchoredOwner: false,
          existingMembershipRole,
        }),
      ).toBeNull();
    }
  });

  it("keeps the anchored owner an owner even when a membership row is missing", () => {
    expect(
      espnRefreshMembershipGrant({
        createdLeague: false,
        actorIsAnchoredOwner: true,
        existingMembershipRole: null,
      }),
    ).toBe("owner");
  });
});

describe("ESPN persistence identity isolation", () => {
  it("uses only verified global ESPN crosswalks as canonical player identity", () => {
    expect(
      trustedEspnPlayerId({
        playerId: "canonical-player",
        verified: true,
        gsisId: "00-0039999",
      }),
    ).toBe("canonical-player");
    expect(
      trustedEspnPlayerId({
        playerId: "self-asserted-player",
        verified: false,
        gsisId: null,
      }),
    ).toBeUndefined();
    expect(
      trustedEspnPlayerId({
        playerId: "legacy-user-import",
        verified: true,
        gsisId: null,
      }),
    ).toBeUndefined();
    expect(trustedEspnPlayerId(undefined)).toBeUndefined();
  });

  it("isolates fallback observations while retaining league-local roster fields", () => {
    expect(ESPN_SELF_ASSERTED_PLAYER_SOURCE).toBe("espn-self-asserted");
    expect(espnSelfAssertedPlayerKey("season-a", "12345")).toBe("season-a:12345");
    expect(espnSelfAssertedPlayerKey("season-b", "12345")).not.toBe(
      espnSelfAssertedPlayerKey("season-a", "12345"),
    );
    expect(
      espnSelfAssertedPlayerIdentity({
        externalId: "espn:2026:player:12345",
        providerPlayerId: "12345",
        fullName: "Observed Quarterback",
        primaryPosition: "QB",
        eligiblePositions: ["QB", "OP", "QB"],
        lineupSlot: "QB",
        proTeamAbbreviation: "CHI",
        status: "QUESTIONABLE",
      }),
    ).toEqual({
      fullName: "Observed Quarterback",
      nflTeam: "CHI",
      primaryPosition: "QB",
      eligiblePositions: ["QB", "OP"],
      status: "QUESTIONABLE",
    });
  });
});
