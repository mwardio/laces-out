import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rosScoringProfile } from "@laces-out/projections";
import { afterEach, describe, expect, it } from "vitest";

import { rosValidationScoringProfileOption } from "./ros-validation-profile-option.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ROS validation scoring CLI", () => {
  it("retains named profiles and the existing default", () => {
    expect(rosValidationScoringProfileOption([]).key).toBe("full-ppr");
    expect(rosValidationScoringProfileOption(["--scoring-profile=yahoo-half-ppr"]).key).toBe(
      "yahoo-half-ppr",
    );
  });
  it("reads a bounded exact-key file without falling back to a catalog profile", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ros-key-test-"));
    directories.push(directory);
    const file = path.join(directory, "key.json");
    const known = rosScoringProfile("espn-ppr-4pt-pass");
    writeFileSync(file, known.scoringProfileKey + "\n");
    expect(rosValidationScoringProfileOption([`--scoring-profile-key-file=${file}`])).toMatchObject(
      { scoringProfileKey: known.scoringProfileKey, digest: known.digest },
    );
    writeFileSync(file, "x".repeat(8_194));
    expect(() => rosValidationScoringProfileOption([`--scoring-profile-key-file=${file}`])).toThrow(
      /bounded/,
    );
  });
  it.each([
    ["--scoring-profile=missing"],
    ["--scoring-profile=standard", "--scoring-profile=half-ppr"],
    ["--scoring-profile=standard", "--scoring-profile-key-file=anything"],
    ["--scoring-profile-key-file="],
  ])("rejects invalid or ambiguous options %j", (...args) => {
    expect(() => rosValidationScoringProfileOption(args)).toThrow();
  });
});
