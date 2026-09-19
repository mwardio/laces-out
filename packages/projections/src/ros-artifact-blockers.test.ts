import { describe, expect, it } from "vitest";
import { deriveRosArtifactBlockers } from "./ros-artifact-blockers.js";
import { FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION } from "./marginal-ros-policy.js";
import { FIRST_PARTY_ROS_POLICY_VERSION } from "./rest-of-season.js";

const cell = { position: "DST", bucket: "five-to-eight" };
const replaced = "calibration_DST_five-to-eight_coverage_shortfall_above_maximum";
const mixed = `${replaced},mean_rmse_above_maximum`;
const mean = "champion_DST_five-to-eight_mean_rmse_above_maximum";
function diagnostics(
  blockers: string[],
  policyVersion = FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
  state = "qualified",
) {
  // Interpretation fixture only: callers separately authenticate the full admitted proof.
  return deriveRosArtifactBlockers({
    policyVersion,
    releaseGate: { blockers, marginalIntervals: { qualifications: [{ cell, state }] } },
  });
}

describe("effective diagnostics for an already validated ROS admission", () => {
  it("separates exact replaced legacy interval diagnostics from current blockers", () => {
    const result = diagnostics([replaced, mixed, mean]);
    expect(result.rawBlockers).toEqual([replaced, mixed, mean]);
    expect(result.effectiveBlockers).toEqual([mixed, mean]);
    expect(result.supersededIntervalDiagnostics).toEqual([replaced]);
    expect([...result.blockedCells]).toEqual(["DST:five-to-eight"]);
  });

  it("never exempts an unqualified cell or legacy rail", () => {
    expect(
      diagnostics([replaced], FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION, "rejected")
        .effectiveBlockers,
    ).toEqual([replaced]);
    expect(diagnostics([replaced], FIRST_PARTY_ROS_POLICY_VERSION).effectiveBlockers).toEqual([
      replaced,
    ]);
    expect(
      diagnostics(["calibration_WR_five-to-eight_coverage_shortfall_above_maximum"])
        .effectiveBlockers,
    ).toHaveLength(1);
  });

  it("withholds every v8 cell on global or unknown diagnostic families", () => {
    const result = diagnostics(["future_unknown_failure", "numerical_distribution_changed"]);
    expect(result.blockedCells.size).toBe(18);
    expect(result.effectiveBlockers).toHaveLength(2);
  });

  it.each([
    "cell_DST_five-to-eight_coverage_shortfall_above_maximum",
    "calibration_DST_five-to-eight_unknown",
    "calibration_DST_five-to-eight_coverage_shortfall_above_maximum_extra",
    "cell_K_one-to-four_count_family_failed",
    "champion_DST_five-to-eight_availability_failed",
    "cell_DST_five-to-eight_convergence_failed",
  ])("retains %s", (blocker) => {
    expect(diagnostics([blocker]).effectiveBlockers).toEqual([blocker]);
  });
});
