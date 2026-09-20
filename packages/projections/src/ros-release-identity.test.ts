import { describe, expect, it } from "vitest";
import { firstPartyRosReleaseIdentity } from "./ros-release-identity.js";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
} from "./rest-of-season.js";
import { FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION } from "./marginal-ros-policy.js";
import { MARGINAL_INTERVAL_CALIBRATION_VERSION } from "./marginal-interval-calibration.js";

describe("explicit ROS outer release identity", () => {
  it("preserves the legacy default and frozen mean selector", () => {
    expect(firstPartyRosReleaseIdentity()).toEqual({
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
      calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    });
    expect(firstPartyRosReleaseIdentity("marginal-v8")).toEqual({
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
      calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
    });
    expect(firstPartyRosReleaseIdentity("point-v1")).toEqual({
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      policyVersion: "season-walk-forward-mean-only-v1",
      calibrationVersion: "unavailable-point-only-v1",
    });
    expect(FIRST_PARTY_ROS_POLICY_VERSION).toBe("season-walk-forward-mean-rmse-block-wis-cqr-v7");
  });

  it("rejects unknown deployment selection instead of falling back", () => {
    expect(() => firstPartyRosReleaseIdentity("v9" as "legacy-v7")).toThrow(/Unknown/);
  });
});
