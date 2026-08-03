import { describe, expect, it } from "vitest";

import {
  ESPN_SELF_ASSERTED_PLAYER_SOURCE,
  espnArtifactChecksumNeedsCanonicalization,
  espnArtifactReceiptState,
  espnRefreshPolicy,
  espnSelfAssertedPlayerIdentity,
  espnSelfAssertedPlayerKey,
  trustedEspnPlayerId,
} from "./espn-sync-persistence.js";

describe("ESPN refresh membership policy", () => {
  it("makes the first importer of a brand-new league its owner", () => {
    expect(
      espnRefreshPolicy({
        createdLeague: true,
        actorIsAnchoredOwner: false,
        existingMembershipRole: null,
      }),
    ).toEqual({ membershipGrant: "owner" });
  });

  it("adds a successful new connector to an existing shared league as a manager", () => {
    expect(
      espnRefreshPolicy({
        createdLeague: false,
        actorIsAnchoredOwner: false,
        existingMembershipRole: null,
      }),
    ).toEqual({ membershipGrant: "manager" });
  });

  it("lets every existing member refresh without changing their role", () => {
    for (const existingMembershipRole of ["owner", "commissioner", "manager", "viewer"] as const) {
      expect(
        espnRefreshPolicy({
          createdLeague: false,
          actorIsAnchoredOwner: false,
          existingMembershipRole,
        }),
      ).toEqual({ membershipGrant: null });
    }
  });

  it("keeps the anchored owner an owner even when a membership row is missing", () => {
    expect(
      espnRefreshPolicy({
        createdLeague: false,
        actorIsAnchoredOwner: true,
        existingMembershipRole: null,
      }),
    ).toEqual({ membershipGrant: "owner" });
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

describe("ESPN canonical checksum transitions", () => {
  it("deduplicates only the current artifact and preserves a valid A-B-A reversion", () => {
    expect(espnArtifactReceiptState({ currentChecksum: "a", incomingChecksum: "a" })).toBe(
      "unchanged",
    );
    expect(espnArtifactReceiptState({ currentChecksum: "b", incomingChecksum: "a" })).toBe(
      "accepted",
    );
    expect(
      espnArtifactReceiptState({
        currentChecksum: "legacy-a",
        incomingChecksum: "canonical-a",
        incomingChecksumAliases: ["legacy-a"],
      }),
    ).toBe("unchanged");
    expect(
      espnArtifactChecksumNeedsCanonicalization({
        currentChecksum: "legacy-a",
        incomingChecksum: "canonical-a",
        incomingChecksumAliases: ["legacy-a"],
      }),
    ).toBe(true);
    expect(
      espnArtifactChecksumNeedsCanonicalization({
        currentChecksum: "canonical-a",
        incomingChecksum: "canonical-a",
        incomingChecksumAliases: ["legacy-a"],
      }),
    ).toBe(false);
  });
});
