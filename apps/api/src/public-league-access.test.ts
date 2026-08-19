import { describe, expect, it } from "vitest";

import { publicLeagueAccessRole } from "./public-league-access.js";

describe("publicLeagueAccessRole", () => {
  it.each([
    ["owner", "commissioner"],
    ["commissioner", "commissioner"],
    ["member", "member"],
    ["manager", "member"],
    ["viewer", "member"],
  ] as const)("maps %s to %s", (stored, expected) => {
    expect(publicLeagueAccessRole(stored)).toBe(expected);
  });
});
