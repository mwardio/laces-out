import { describe, expect, it } from "vitest";

import {
  ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL,
  ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
  ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
  hasCurrentRosHistoricalCoverageThresholds,
  hasRosHistoricalCorpusReleaseThresholds,
  isCurrentRosHistoricalCorpusBuildProtocol,
  isCompatibleRosHistoricalCorpusBuildProtocol,
} from "./ros-historical-corpus-protocol.js";

describe("immutable historical corpus build protocol", () => {
  it("requires explicit defense history, sampler, and calibration lineage even under the current model", () => {
    const defenseFields = [
      "defenseHistoryVersion",
      "defenseGameVersion",
      "defenseCalibrationVersion",
      "defenseAllowedDistributionVersion",
    ];
    const withoutDefenseLineage = Object.fromEntries(
      Object.entries(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL).filter(
        ([name]) => !defenseFields.includes(name),
      ),
    );
    expect(isCurrentRosHistoricalCorpusBuildProtocol(withoutDefenseLineage)).toBe(false);
    expect(isCompatibleRosHistoricalCorpusBuildProtocol(withoutDefenseLineage)).toBe(false);
  });

  it.each(["season-walk-forward-block-wis-cqr-v5", "season-walk-forward-block-wis-cqr-v6"])(
    "reuses identical physical inputs from %s without claiming current evaluation",
    (policyVersion) => {
      const original = {
        ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
        policyVersion,
        calibrationVersion: "season-blocked-split-conformal-cqr-v1",
      };
      expect(isCompatibleRosHistoricalCorpusBuildProtocol(original)).toBe(true);
      expect(isCurrentRosHistoricalCorpusBuildProtocol(original)).toBe(false);
      expect(
        isCompatibleRosHistoricalCorpusBuildProtocol(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL),
      ).toBe(true);
      expect(ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL).not.toHaveProperty("policyVersion");
      expect(ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL).not.toHaveProperty("calibrationVersion");
      expect(Object.isFrozen(ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL)).toBe(true);
    },
  );

  it("rejects v11/v14 football outcomes even when their evaluator provenance is recognized", () => {
    const priorPhysicalModel = {
      ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
      modelVersion: "laces-ros-distribution-v11",
      weeklyComponentModelVersion: "laces-weekly-components-v14",
      weeklyModelVersion: "laces-weekly-components-v14:contextual-vs-recency-v1",
    };
    for (const policyVersion of [
      "season-walk-forward-block-wis-cqr-v5",
      "season-walk-forward-block-wis-cqr-v6",
    ])
      expect(
        isCompatibleRosHistoricalCorpusBuildProtocol({ ...priorPhysicalModel, policyVersion }),
      ).toBe(false);
  });

  it("rejects v12 physical outcomes under every recognized evaluator after the D/ST model change", () => {
    for (const policyVersion of [
      "season-walk-forward-block-wis-cqr-v5",
      "season-walk-forward-block-wis-cqr-v6",
      ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.policyVersion,
    ]) {
      const priorPhysicalModel = {
        ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
        modelVersion: "laces-ros-distribution-v12",
        policyVersion,
      };
      expect(isCompatibleRosHistoricalCorpusBuildProtocol(priorPhysicalModel)).toBe(false);
      expect(isCurrentRosHistoricalCorpusBuildProtocol(priorPhysicalModel)).toBe(false);
    }
  });

  it.each(Object.keys(ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL))(
    "rejects a missing or changed physical %s even for original evaluation provenance",
    (name) => {
      for (const policyVersion of [
        "season-walk-forward-block-wis-cqr-v5",
        "season-walk-forward-block-wis-cqr-v6",
      ]) {
        const original = {
          ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
          policyVersion,
          calibrationVersion: "season-blocked-split-conformal-cqr-v1",
        };
        const missing = Object.fromEntries(
          Object.entries(original).filter(([key]) => key !== name),
        );
        expect(isCompatibleRosHistoricalCorpusBuildProtocol(missing)).toBe(false);
        expect(isCompatibleRosHistoricalCorpusBuildProtocol({ ...original, [name]: "stale" })).toBe(
          false,
        );
      }
    },
  );

  it("rejects unknown evaluation pairs and malformed provenance without weakening physical reuse", () => {
    for (const patch of [
      { policyVersion: "season-walk-forward-block-wis-cqr-v4" },
      { policyVersion: "season-walk-forward-block-wis-cqr-v999" },
      { calibrationVersion: "season-blocked-split-conformal-cqr-v999" },
      { policyVersion: "season-walk-forward-block-wis-cqr-v5", calibrationVersion: "unknown" },
      { policyVersion: "season-walk-forward-block-wis-cqr-v6", calibrationVersion: "unknown" },
      { policyVersion: null },
      { policyVersion: 5 },
      { calibrationVersion: undefined },
      { unknownFutureProtocol: 1 },
    ])
      expect(
        isCompatibleRosHistoricalCorpusBuildProtocol({
          ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
          ...patch,
        }),
      ).toBe(false);
    for (const value of [null, [], {}, Object.create(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL)])
      expect(isCompatibleRosHistoricalCorpusBuildProtocol(value)).toBe(false);
  });

  it("accepts current values independently of property order and freezes shared contracts", () => {
    expect(
      isCurrentRosHistoricalCorpusBuildProtocol(
        Object.fromEntries(Object.entries(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL).reverse()),
      ),
    ).toBe(true);
    expect(
      hasRosHistoricalCorpusReleaseThresholds({
        ...ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
        playersPerPosition: 8,
      }),
    ).toBe(true);
    expect(
      hasCurrentRosHistoricalCoverageThresholds(ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS),
    ).toBe(true);
    expect(Object.isFrozen(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS)).toBe(true);
  });

  it.each(Object.keys(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL))(
    "rejects a missing or stale %s even when every other version is current",
    (name) => {
      const missing = Object.fromEntries(
        Object.entries(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL).filter(([key]) => key !== name),
      );
      expect(isCurrentRosHistoricalCorpusBuildProtocol(missing)).toBe(false);
      expect(
        isCurrentRosHistoricalCorpusBuildProtocol({
          ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
          [name]: "stale",
        }),
      ).toBe(false);
    },
  );

  it.each(Object.entries(ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS))(
    "requires the exact release value for %s",
    (name, value) => {
      for (const changed of [value - 1, value + 1, String(value), undefined]) {
        expect(
          hasRosHistoricalCorpusReleaseThresholds({
            ...ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
            [name]: changed,
          }),
        ).toBe(false);
      }
    },
  );

  it.each(Object.entries(ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS))(
    "rejects altered coverage threshold %s",
    (name, value) => {
      expect(
        hasCurrentRosHistoricalCoverageThresholds({
          ...ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
          [name]: value / 2,
        }),
      ).toBe(false);
    },
  );

  it("rejects unreadable, inherited or additional protocol fields", () => {
    for (const value of [
      null,
      [],
      {},
      Object.create(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL),
      {
        ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
        unknownFutureProtocol: 1,
      },
    ])
      expect(isCurrentRosHistoricalCorpusBuildProtocol(value)).toBe(false);
  });
});
