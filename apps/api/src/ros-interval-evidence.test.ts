import { beforeAll, describe, expect, it } from "vitest";
import {
  buildRosMarginalIntervalStorage,
  projectionScoringProfileKey,
  type RosMarginalIntervalStorage,
} from "@laces-out/projections";
import { buildRosMarginalIntervalQualificationFixture } from "../../../packages/projections/src/ros-marginal-interval-test-fixtures.js";
import {
  parseLinkedRosIntervalEvidence,
  parseLinkedRosForecastKind,
  storedRosPointEvidenceIsValid,
  parseStoredRosIntervalCalibration,
} from "./ros-interval-evidence.js";

const legacy = {
  schemaVersion: 1,
  state: "calibrated",
  method: "season-blocked-split-conformal-cqr-v1",
  evidenceChecksum: "a".repeat(64),
  heldOutSeasons: 3,
  batches: 30,
  samples: 300,
  nominalCoverage: 0.7,
  empiricalCoverage: 0.7,
  maximumAllowedCoverageError: 0.1,
};
let marginal: RosMarginalIntervalStorage;
beforeAll(() => {
  marginal = buildRosMarginalIntervalStorage({
    qualifications: buildRosMarginalIntervalQualificationFixture(),
    championArtifactChecksum: "a".repeat(64),
    releasedCells: [{ position: "DST", bucket: "one-to-four" }],
  });
}, 15_000);

describe("immutable ROS interval evidence interpretation", () => {
  it("describes schema-2 player quantiles only from a valid reconstructed storage envelope", () => {
    expect(parseStoredRosIntervalCalibration(JSON.parse(JSON.stringify(marginal)))).toEqual({
      kind: "player-marginal",
      method: "season-prior-weighted-quantile-residuals-v1",
      target: "individual-player-marginal-quantiles",
      quantiles: [0.15, 0.5, 0.85],
      nominalCoverage: 0.7,
      qualificationMethod: "ros-marginal-interval-qualification-v1",
      evidenceInterpretation: "historical-descriptive",
      evidenceChecksum: marginal.evidenceChecksum,
    });
  });

  it("does not interpret a method label, copied checksum or altered cell scope as qualification", () => {
    for (const value of [
      { ...legacy, schemaVersion: 2, method: marginal.method },
      { ...marginal, evidenceChecksum: "b".repeat(64) },
      { ...marginal, releasedCells: [] },
      { ...marginal, cells: [] },
      { ...marginal, nominalCoverage: 0.8 },
      { ...marginal, interpretation: "individual-coverage-guarantee" },
      { ...marginal, extra: true },
      { ...marginal, schemaVersion: 3 },
    ])
      expect(parseStoredRosIntervalCalibration(value)).toBeNull();
  });

  it("requires every declared marginal storage field", () => {
    for (const key of Object.keys(marginal)) {
      const missing = { ...marginal } as Record<string, unknown>;
      delete missing[key];
      expect(parseStoredRosIntervalCalibration(missing), key).toBeNull();
    }
  });

  it("requires schema-2 artifact, season and scoring scope to match the uniquely linked run", () => {
    const linked = {
      projectionSetId: "set",
      linkedRunCount: 1,
      matchesScope: true,
      distributionScopeMatches: true,
      marginalScopeMatches: true,
      rosIntervals: marginal,
    };
    expect(parseLinkedRosIntervalEvidence(linked)?.kind).toBe("player-marginal");
    for (const marginalScopeMatches of [undefined, false, "true", 1])
      expect(parseLinkedRosIntervalEvidence({ ...linked, marginalScopeMatches })).toBeNull();
    expect(parseLinkedRosIntervalEvidence({ ...linked, linkedRunCount: 2 })).toBeNull();
    expect(parseLinkedRosIntervalEvidence({ ...linked, matchesScope: false })).toBeNull();
  });

  it("recognizes exact retained schema-1 evidence without adding an individual coverage target", () => {
    expect(parseStoredRosIntervalCalibration(JSON.parse(JSON.stringify(legacy)))).toEqual({
      kind: "legacy-block-cqr",
      method: legacy.method,
      quantiles: [0.15, 0.5, 0.85],
      evidenceInterpretation: "historical-descriptive",
      evidenceChecksum: legacy.evidenceChecksum,
    });
    expect(
      parseStoredRosIntervalCalibration({
        ...legacy,
        nominalCoverage: 0.8,
        empiricalCoverage: 0.8,
      }),
    ).not.toHaveProperty("nominalCoverage");
  });

  it.each([0.6, 0.8])(
    "preserves PostgreSQL decimal coverage boundary %s without epsilon",
    (empiricalCoverage) => {
      expect(parseStoredRosIntervalCalibration({ ...legacy, empiricalCoverage })).not.toBeNull();
    },
  );

  it.each([0.5999999999999999, 0.8000000000000002])(
    "rejects a decimal beyond the coverage boundary %s",
    (empiricalCoverage) => {
      expect(parseStoredRosIntervalCalibration({ ...legacy, empiricalCoverage })).toBeNull();
    },
  );

  it("handles scientific-notation probabilities using the same exact decimal comparison", () => {
    expect(
      parseStoredRosIntervalCalibration({
        ...legacy,
        nominalCoverage: 1e-7,
        empiricalCoverage: 2e-7,
        maximumAllowedCoverageError: 1e-7,
      }),
    ).not.toBeNull();
    expect(
      parseStoredRosIntervalCalibration({
        ...legacy,
        nominalCoverage: 1e-7,
        empiricalCoverage: 2.0000000000000002e-7,
        maximumAllowedCoverageError: 1e-7,
      }),
    ).toBeNull();
    expect(
      parseStoredRosIntervalCalibration({
        ...legacy,
        nominalCoverage: 0,
        empiricalCoverage: Number.MIN_VALUE,
        maximumAllowedCoverageError: 0,
      }),
    ).toBeNull();
  });

  it.each([
    undefined,
    null,
    [],
    {},
    "legacy",
    { ...legacy, schemaVersion: 2 },
    { ...legacy, state: "qualified" },
    { ...legacy, method: "season-prior-weighted-quantile-residuals-v1" },
    { ...legacy, method: "unknown" },
    { ...legacy, evidenceChecksum: "A".repeat(64) },
    { ...legacy, evidenceChecksum: "short" },
    { ...legacy, heldOutSeasons: 2 },
    { ...legacy, heldOutSeasons: 3.5 },
    { ...legacy, heldOutSeasons: "3" },
    { ...legacy, batches: 29 },
    { ...legacy, samples: 299 },
    { ...legacy, samples: 2_147_483_648 },
    { ...legacy, nominalCoverage: NaN },
    { ...legacy, nominalCoverage: -0.1 },
    { ...legacy, empiricalCoverage: Infinity },
    { ...legacy, empiricalCoverage: 1.1 },
    { ...legacy, maximumAllowedCoverageError: -0.1 },
    { ...legacy, maximumAllowedCoverageError: 1.1 },
    { ...legacy, maximumAllowedCoverageError: "0.1" },
    { ...legacy, extra: true },
    { ...legacy, target: "individual-player-marginal-quantiles" },
  ])("returns unavailable for unknown or malformed stored evidence %#", (value) => {
    expect(parseStoredRosIntervalCalibration(value)).toBeNull();
  });

  it("requires every declared legacy field", () => {
    for (const key of Object.keys(legacy)) {
      const missing = { ...legacy } as Record<string, unknown>;
      delete missing[key];
      expect(parseStoredRosIntervalCalibration(missing), key).toBeNull();
    }
  });

  it("requires one linked matching run, even when an ambiguous candidate has a valid contract", () => {
    const linked = {
      projectionSetId: "set",
      linkedRunCount: 1,
      matchesScope: true,
      distributionScopeMatches: true,
      rosIntervals: legacy,
    };
    expect(parseLinkedRosIntervalEvidence(linked)).not.toBeNull();
    for (const linkedRunCount of [0, 2, 1.5, Infinity, NaN])
      expect(parseLinkedRosIntervalEvidence({ ...linked, linkedRunCount })).toBeNull();
    expect(parseLinkedRosIntervalEvidence({ ...linked, matchesScope: false })).toBeNull();
    for (const malformed of [
      null,
      undefined,
      [],
      {},
      { ...linked, linkedRunCount: "1" },
      { ...linked, matchesScope: "true" },
    ])
      expect(parseLinkedRosIntervalEvidence(malformed)).toBeNull();
  });
});

const point = {
  schemaVersion: 1,
  method: "point-ros-release-v1",
  state: "validated",
  championArtifactChecksum: "a".repeat(64),
  scoringProfileKey: projectionScoringProfileKey({
    id: "point-test",
    rules: [{ statId: "receiving_yards", points: 0.1 }],
  }),
  intervalAvailable: false,
  cells: [
    {
      position: "WR",
      bucket: "nine-plus",
      strategy: "contextual",
      qualificationChecksum: "b".repeat(64),
      releaseEvidenceChecksum: "c".repeat(64),
    },
  ],
};

describe("immutable point-only ROS evidence", () => {
  it("requires the complete closed storage envelope and unique supported cells", () => {
    expect(storedRosPointEvidenceIsValid(point)).toBe(true);
    for (const key of Object.keys(point)) {
      const missing = { ...point } as Record<string, unknown>;
      delete missing[key];
      expect(storedRosPointEvidenceIsValid(missing), key).toBe(false);
    }
    for (const value of [
      null,
      {},
      { ...point, extra: true },
      { ...point, schemaVersion: 2 },
      { ...point, state: "calibrated" },
      { ...point, intervalAvailable: true },
      { ...point, method: "unrecognized" },
      { ...point, scoringProfileKey: "invalid" },
      { ...point, championArtifactChecksum: "A".repeat(64) },
      { ...point, cells: [] },
      { ...point, cells: [...point.cells, ...point.cells] },
      ...[
        { position: "IDP" },
        { bucket: "weekly" },
        { strategy: "unknown" },
        { qualificationChecksum: "invalid" },
        { releaseEvidenceChecksum: "invalid" },
        { extra: true },
      ].map((cell) => ({ ...point, cells: [{ ...point.cells[0], ...cell }] })),
    ])
      expect(storedRosPointEvidenceIsValid(value)).toBe(false);
  });

  it("exposes point kind only for uniquely linked, scoped, stamped point proof without intervals", () => {
    const linked = {
      projectionSetId: "set",
      linkedRunCount: 1,
      matchesScope: true,
      distributionScopeMatches: false,
      pointScopeMatches: true,
      rosPoints: point,
      rosIntervals: null,
    };
    expect(parseLinkedRosForecastKind(linked)).toBe("point-only");
    expect(parseLinkedRosIntervalEvidence(linked)).toBeNull();
    for (const mutation of [
      { linkedRunCount: 0 },
      { linkedRunCount: 2 },
      { matchesScope: false },
      { pointScopeMatches: undefined },
      { pointScopeMatches: false },
      { pointScopeMatches: "true" },
      { distributionScopeMatches: true },
      { distributionScopeMatches: undefined },
      { rosIntervals: legacy },
      { rosPoints: null },
      { rosPoints: { ...point, intervalAvailable: true } },
    ])
      expect(parseLinkedRosForecastKind({ ...linked, ...mutation })).toBeNull();
  });

  it("does not relabel mixed point and distribution proof as a historical interval", () => {
    const linked = {
      linkedRunCount: 1,
      matchesScope: true,
      distributionScopeMatches: true,
      rosIntervals: legacy,
    };
    expect(parseLinkedRosForecastKind(linked)).toBe("calibrated-distribution");
    for (const mutation of [
      { rosPoints: point },
      { rosPoints: {} },
      { pointScopeMatches: true },
      { distributionScopeMatches: false },
    ]) {
      expect(parseLinkedRosIntervalEvidence({ ...linked, ...mutation })).toBeNull();
      expect(parseLinkedRosForecastKind({ ...linked, ...mutation })).toBeNull();
    }
  });
});
