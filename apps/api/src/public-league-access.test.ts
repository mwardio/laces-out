import { describe, expect, it } from "vitest";

import { publicLeagueAccessRole } from "./public-league-access.js";

describe("publicLeagueAccessRole", () => {
  it.each([
    ["owner", "member"],
    ["commissioner", "commissioner"],
    ["member", "member"],
    ["manager", "member"],
    ["viewer", "member"],
  ] as const)("maps %s to %s", (stored, expected) => {
    expect(publicLeagueAccessRole({ role: stored })).toBe(expected);
  });

  it("returns commissioner for either explicit or exact provider authority", () => {
    expect(publicLeagueAccessRole({ role: "owner", explicitCommissioner: true })).toBe(
      "commissioner",
    );
    expect(publicLeagueAccessRole({ role: "member", providerCommissioner: true })).toBe(
      "commissioner",
    );
  });

  it("fails closed for unknown and exact false provider evidence without stripping an explicit grant", () => {
    expect(publicLeagueAccessRole({ role: "owner", providerCommissioner: null })).toBe("member");
    expect(publicLeagueAccessRole({ role: "owner", providerCommissioner: false })).toBe("member");
    expect(
      publicLeagueAccessRole({
        role: "owner",
        explicitCommissioner: true,
        providerCommissioner: false,
      }),
    ).toBe("commissioner");
  });
});
