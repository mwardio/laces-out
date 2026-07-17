import { describe, expect, it } from "vitest";

import {
  ESPN_SELF_ASSERTED_PLAYER_SOURCE,
  canReplaceExistingEspnSeason,
  espnSelfAssertedPlayerIdentity,
  espnSelfAssertedPlayerKey,
  trustedEspnPlayerId,
} from "./espn-sync-persistence.js";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ID = "10000000-0000-4000-8000-000000000002";

describe("ESPN persistence security policy", () => {
  it("requires established owner or commissioner authority for an existing season", () => {
    expect(
      canReplaceExistingEspnSeason(ACTOR_ID, {
        ownerUserId: ACTOR_ID,
        membershipRole: null,
      }),
    ).toBe(true);
    expect(
      canReplaceExistingEspnSeason(ACTOR_ID, {
        ownerUserId: OTHER_ID,
        membershipRole: "owner",
      }),
    ).toBe(true);
    expect(
      canReplaceExistingEspnSeason(ACTOR_ID, {
        ownerUserId: OTHER_ID,
        membershipRole: "commissioner",
      }),
    ).toBe(true);
  });

  it("does not turn a bridge league-ID allowlist into replacement authority", () => {
    expect(canReplaceExistingEspnSeason(ACTOR_ID, undefined)).toBe(false);
    expect(
      canReplaceExistingEspnSeason(ACTOR_ID, {
        ownerUserId: OTHER_ID,
        membershipRole: "manager",
      }),
    ).toBe(false);
    expect(
      canReplaceExistingEspnSeason(ACTOR_ID, {
        ownerUserId: OTHER_ID,
        membershipRole: "viewer",
      }),
    ).toBe(false);
  });

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
