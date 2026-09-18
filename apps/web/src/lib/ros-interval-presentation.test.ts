import type { RosIntervalDescriptor } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";
import { rosIntervalPresentation } from "./ros-interval-presentation.js";

const legacy: RosIntervalDescriptor = {
  kind: "legacy-block-cqr",
  method: "season-blocked-split-conformal-cqr-v1",
  quantiles: [0.15, 0.5, 0.85],
  evidenceInterpretation: "historical-descriptive",
  evidenceChecksum: "a".repeat(64),
};
const marginal: RosIntervalDescriptor = {
  kind: "player-marginal",
  method: "season-prior-weighted-quantile-residuals-v1",
  target: "individual-player-marginal-quantiles",
  nominalCoverage: 0.7,
  qualificationMethod: "ros-marginal-interval-qualification-v1",
  quantiles: [0.15, 0.5, 0.85],
  evidenceInterpretation: "historical-descriptive",
  evidenceChecksum: "b".repeat(64),
};

describe("ROS interval method presentation", () => {
  it("preserves the meaning of retained legacy CQR ranges", () => {
    const copy = rosIntervalPresentation(legacy);
    expect(copy).toContain("widened using historical forecast errors");
    expect(copy).toContain("remain provisional");
    expect(copy).toContain("do not establish a 70% chance for an individual player");
    expect(copy).not.toContain("targets 70% coverage");
  });

  it("describes the marginal target and corrected median without promising individual coverage", () => {
    const copy = rosIntervalPresentation(marginal);
    expect(copy).toContain("each player's estimated 15th, 50th, and 85th percentiles");
    expect(copy).toContain("central range targets 70% coverage");
    expect(copy).toContain("remain provisional");
    expect(copy).toContain("do not establish a 70% chance for an individual player");
    expect(copy).not.toContain("widened");
  });

  it.each([
    undefined,
    null,
    {},
    [],
    { ...legacy, method: "unrecognized" },
    { ...marginal, evidenceChecksum: "invalid" },
    { ...marginal, qualificationMethod: "unrecognized" },
    { ...marginal, nominalCoverage: 0.8 },
    { ...marginal, admitted: true },
    { kind: "player-marginal" },
    {
      modelVersion: marginal.method,
      horizon: "rest-of-season",
      metadata: { rosInterval: marginal },
    },
  ])("uses honest unknown-method copy for absent or invalid evidence %#", (value) => {
    const copy = rosIntervalPresentation(value);
    expect(copy).toBe(
      "These ranges are provisional estimates. The method used to produce them and its supporting evidence are unavailable.",
    );
    expect(copy).not.toContain("widened");
    expect(copy).not.toContain("70%");
  });
});
