import { MARGINAL_INTERVAL_CALIBRATION_VERSION } from "./marginal-interval-calibration.js";
import { FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION } from "./marginal-ros-policy.js";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
} from "./rest-of-season.js";

/** Outer admission/publication rail. The historical mean selector remains v7 on both rails. */
export type FirstPartyRosReleaseRail = "legacy-v7" | "marginal-v8";
export interface FirstPartyRosReleaseIdentity {
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
}

/** Explicit selection prevents a later legacy admission from displacing marginal evidence. */
export function firstPartyRosReleaseIdentity(
  rail: FirstPartyRosReleaseRail = "legacy-v7",
): FirstPartyRosReleaseIdentity {
  if (rail !== "legacy-v7" && rail !== "marginal-v8")
    throw new TypeError("Unknown first-party ROS release rail");
  return {
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion:
      rail === "marginal-v8"
        ? FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION
        : FIRST_PARTY_ROS_POLICY_VERSION,
    calibrationVersion:
      rail === "marginal-v8"
        ? MARGINAL_INTERVAL_CALIBRATION_VERSION
        : FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  };
}
