import { MARGINAL_INTERVAL_CALIBRATION_VERSION } from "./marginal-interval-calibration.js";
import { FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION } from "./marginal-ros-policy.js";
import {
  FIRST_PARTY_ROS_POINT_POLICY_VERSION,
  FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION,
} from "./point-ros-release.js";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
} from "./rest-of-season.js";

/** Outer admission/publication rail. Every rail retains the historical v7 mean selector. */
export type FirstPartyRosReleaseRail = "legacy-v7" | "marginal-v8" | "point-v1";
export interface FirstPartyRosReleaseIdentity {
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
}

/** Explicit selection binds admission and publication to the requested evidence contract. */
export function firstPartyRosReleaseIdentity(
  rail: FirstPartyRosReleaseRail = "legacy-v7",
): FirstPartyRosReleaseIdentity {
  if (rail !== "legacy-v7" && rail !== "marginal-v8" && rail !== "point-v1")
    throw new TypeError("Unknown first-party ROS release rail");
  return {
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion:
      rail === "point-v1"
        ? FIRST_PARTY_ROS_POINT_POLICY_VERSION
        : rail === "marginal-v8"
          ? FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION
          : FIRST_PARTY_ROS_POLICY_VERSION,
    calibrationVersion:
      rail === "point-v1"
        ? FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION
        : rail === "marginal-v8"
          ? MARGINAL_INTERVAL_CALIBRATION_VERSION
          : FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  };
}
