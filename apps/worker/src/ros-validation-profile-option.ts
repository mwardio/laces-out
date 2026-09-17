import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

import {
  ROS_PROFILE_KEY_MAXIMUM_BYTES,
  ROS_SCORING_PROFILE_KEYS,
  isRosScoringProfileKey,
  rosProfileDefinitionFromKey,
  rosScoringProfile,
  type RosProfileDefinition,
} from "@laces-out/projections";

/** Resolve the CLI identity before any HTTP requests or expensive historical validation. */
export function rosValidationScoringProfileOption(argv: readonly string[]): RosProfileDefinition {
  const named = argv.filter((argument) => argument.startsWith("--scoring-profile="));
  const files = argv.filter((argument) => argument.startsWith("--scoring-profile-key-file="));
  if (named.length > 1 || files.length > 1 || (named.length > 0 && files.length > 0)) {
    throw new Error("Supply exactly one scoring profile name or scoring profile key file");
  }
  if (files[0]) {
    const path = files[0].slice("--scoring-profile-key-file=".length);
    if (!path) throw new Error("--scoring-profile-key-file requires a path");
    const descriptor = openSync(path, "r");
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > ROS_PROFILE_KEY_MAXIMUM_BYTES + 1) {
        throw new Error("Scoring profile key file must be a bounded regular file");
      }
      return rosProfileDefinitionFromKey(readFileSync(descriptor, "utf8").trim());
    } finally {
      closeSync(descriptor);
    }
  }
  const name = named[0]?.slice("--scoring-profile=".length) ?? "full-ppr";
  if (!isRosScoringProfileKey(name)) {
    throw new Error(`--scoring-profile must be one of ${ROS_SCORING_PROFILE_KEYS.join(", ")}`);
  }
  return rosScoringProfile(name);
}
