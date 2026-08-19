import { describe, expect, it } from "vitest";

import {
  FRIEND_INVITATION_LEAGUE_ROLES,
  friendInvitationRequest,
  leagueAccessLabel,
} from "./invitation-access.js";

describe("friend invitation access", () => {
  it("offers only member and commissioner league access", () => {
    expect(FRIEND_INVITATION_LEAGUE_ROLES.map(({ value }) => value)).toEqual([
      "member",
      "commissioner",
    ]);
    expect(leagueAccessLabel("member")).toBe("Member");
    expect(leagueAccessLabel("commissioner")).toBe("Commissioner");
  });

  it("always creates an ordinary member account", () => {
    expect(
      friendInvitationRequest({
        email: " friend@example.com ",
        leagueId: "league-1",
        leagueRole: "commissioner",
        expiresInDays: 7,
      }),
    ).toEqual({
      email: "friend@example.com",
      role: "member",
      leagueId: "league-1",
      leagueRole: "commissioner",
      expiresInDays: 7,
    });
  });
});
