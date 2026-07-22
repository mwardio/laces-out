import { describe, expect, it } from "vitest";

import { currentNflSeason } from "./nfl-season.js";

describe("current NFL season", () => {
  it.each([
    ["2027-01-15T12:00:00.000Z", 2026],
    ["2027-02-28T23:59:59.999Z", 2026],
    ["2027-03-01T00:00:00.000Z", 2027],
    ["2027-09-01T00:00:00.000Z", 2027],
  ])("maps %s to season %i", (instant, season) => {
    expect(currentNflSeason(new Date(instant))).toBe(season);
  });

  it("rejects an invalid date", () => {
    expect(() => currentNflSeason(new Date(Number.NaN))).toThrow("must be valid");
  });
});
