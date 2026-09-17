import { describe, expect, it } from "vitest";

import {
  ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
  ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
  hasCurrentRosHistoricalCoverageThresholds,
  hasRosHistoricalCorpusReleaseThresholds,
  isCurrentRosHistoricalCorpusBuildProtocol,
} from "./ros-historical-corpus-protocol.js";

describe("immutable historical corpus build protocol", () => {
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
