import { describe, expect, it } from "vitest";

import {
  providerForSelectedLeague,
  shouldShowYahooAttribution,
} from "./fantasy-provider-attribution";

const leagues = [
  { id: "espn-league", season: { provider: "espn" as const } },
  { id: "yahoo-league", season: { provider: "yahoo" as const } },
  { id: "archived-league", season: null },
];

describe("Yahoo Fantasy attribution", () => {
  it("follows the selected league provider", () => {
    expect(providerForSelectedLeague(leagues, "yahoo-league")).toBe("yahoo");
    expect(providerForSelectedLeague(leagues, "espn-league")).toBe("espn");
  });

  it("stays hidden without an active provider-backed league", () => {
    expect(providerForSelectedLeague(leagues, "")).toBeNull();
    expect(providerForSelectedLeague(leagues, "missing-league")).toBeNull();
    expect(providerForSelectedLeague(leagues, "archived-league")).toBeNull();
  });

  it("renders only for Yahoo", () => {
    expect(shouldShowYahooAttribution("yahoo")).toBe(true);
    expect(shouldShowYahooAttribution("espn")).toBe(false);
    expect(shouldShowYahooAttribution("manual")).toBe(false);
    expect(shouldShowYahooAttribution(null)).toBe(false);
  });
});
