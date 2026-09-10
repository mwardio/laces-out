import { describe, expect, it } from "vitest";

import { resolveInitialLeagueId } from "./league-selection";

const leagues = [{ id: "home" }, { id: "dynasty" }];

describe("resolveInitialLeagueId", () => {
  it("prefers a valid league from the URL", () => {
    expect(resolveInitialLeagueId(leagues, "dynasty", "home")).toBe("dynasty");
  });

  it("falls back from a stale URL league to the stored default", () => {
    expect(resolveInitialLeagueId(leagues, "former-league", "dynasty")).toBe("dynasty");
  });

  it("uses the first accessible league when neither preference is valid", () => {
    expect(resolveInitialLeagueId(leagues, null, "former-league")).toBe("home");
  });

  it("returns an empty selection when there are no leagues", () => {
    expect(resolveInitialLeagueId([], "dynasty", "home")).toBe("");
  });
});
