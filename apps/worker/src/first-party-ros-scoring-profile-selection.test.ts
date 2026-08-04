import { rosAvailableProjectionStatIds, rosScoringProfileCatalog } from "@fantasy/projections";
import { describe, expect, it } from "vitest";

import { firstPartyAvailableProjectionComponents } from "./first-party-projections.js";
import { HISTORICAL_ROS_SUPPORTED_POSITIONS } from "./first-party-ros-backtest.js";

describe("rosAvailableProjectionStatIds", () => {
  it("matches the worker's own available-component list exactly", () => {
    // `apps/api` cannot import the worker, so the API resolves league scoring against the shared
    // package helper. If the two ever disagreed, the API would withhold leagues the worker would
    // happily publish, or the reverse.
    expect([...rosAvailableProjectionStatIds()]).toEqual([
      ...firstPartyAvailableProjectionComponents(),
    ]);
  });

  it("exposes the nine yards-allowed tier components through the worker's availability union", () => {
    // The unions spread `firstPartyTeamDefenseProjectionComponents()`, so the yards-allowed
    // components must appear here without edits — otherwise COMPONENT_UNAVAILABLE could fire on a
    // rule the run does emit.
    const available = new Set(firstPartyAvailableProjectionComponents());
    for (const component of [
      "yards_allowed_0_99_probability",
      "yards_allowed_100_199_probability",
      "yards_allowed_200_299_probability",
      "yards_allowed_300_349_probability",
      "yards_allowed_350_399_probability",
      "yards_allowed_400_449_probability",
      "yards_allowed_450_499_probability",
      "yards_allowed_500_549_probability",
      "yards_allowed_550_plus_probability",
    ]) {
      expect(available.has(component), component).toBe(true);
    }
  });

  it("covers every stat the admitted scoring profiles score", () => {
    const available = new Set(rosAvailableProjectionStatIds());
    for (const entry of rosScoringProfileCatalog()) {
      for (const rule of entry.profile.rules) {
        expect(available.has(rule.statId)).toBe(true);
      }
    }
  });

  it("models the same positions the historical backtest supports", () => {
    expect([...HISTORICAL_ROS_SUPPORTED_POSITIONS]).toEqual(["QB", "RB", "WR", "TE", "K", "DST"]);
  });
});
