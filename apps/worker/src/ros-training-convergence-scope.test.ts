import { describe, expect, it } from "vitest";
import { scopedRosTrainingConvergenceBlockers } from "./ros-marginal-development.js";

describe("scoped ROS interval-training convergence diagnostics", () => {
  it("excludes only the fifteen known non-DST placeholders from a DST-only source", () => {
    const placeholders = ["QB", "RB", "WR", "TE", "K"].flatMap((position) =>
      ["one-to-four", "five-to-eight", "nine-plus"].map(
        (bucket) => `calibration_${position}_${bucket}_convergence_below_minimum`,
      ),
    );
    const original = [...placeholders];
    expect(scopedRosTrainingConvergenceBlockers(placeholders, ["DST"])).toEqual([]);
    expect(placeholders).toEqual(original);
    expect(
      scopedRosTrainingConvergenceBlockers(placeholders, ["QB", "RB", "WR", "TE", "K", "DST"]),
    ).toEqual(placeholders);
  });

  it("preserves real defense failures and unknown or mixed convergence failures", () => {
    const binding = [
      "calibration_DST_nine-plus_convergence_below_minimum",
      "calibration_QB_one-to-four_artifact_unavailable+convergence_below_minimum",
      "calibration_QB_one-to-four_convergence_unknown_gate",
      "physical-convergence:2024:DST:one-to-four:contextual",
      "unknown_convergence_failure",
    ];
    expect(
      scopedRosTrainingConvergenceBlockers(
        [
          ...binding,
          "calibration_QB_one-to-four_convergence_below_minimum",
          "calibration_DST_nine-plus_coverage_shortfall_above_maximum",
        ],
        ["DST"],
      ),
    ).toEqual(binding);
  });
});
