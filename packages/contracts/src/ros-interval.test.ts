import { describe, expect, it } from "vitest";
import { projectionSetSummarySchema } from "./index.js";
import {
  parseRosIntervalDescriptor,
  rosIntervalDescriptorSchema,
  type RosIntervalDescriptor,
} from "./ros-interval.js";

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

function projectionSet(rosInterval?: unknown) {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    leagueSeasonId: "70000000-0000-4000-8000-000000000003",
    creatorUserId: null,
    creatorDisplayName: null,
    origin: "laces-out",
    managed: {
      ...(rosInterval === undefined ? {} : { rosInterval }),
      modelVersion: "previous-model",
      computedAt: "2026-09-18T12:00:00.000Z",
      inputCheckedAt: "2026-09-18T11:59:00.000Z",
      trainingCutoff: null,
      statsThrough: null,
      qualityState: "publishable",
      championByPosition: [],
      coverage: null,
      warnings: [],
      backtest: null,
    },
    visibility: "league",
    sourceLabel: "Saved ROS projections",
    sourceFileName: null,
    season: 2026,
    week: null,
    horizon: "rest-of-season",
    playerCount: 213,
    inputChecksum: `sha256:${"c".repeat(64)}`,
    sourceChecksum: `sha256:${"d".repeat(64)}`,
    sourceObservedAt: "2026-09-18T11:00:00.000Z",
    sourceObservedAtStatus: "verified",
    importedAt: "2026-09-18T12:00:00.000Z",
    isOwnedByCurrentUser: false,
  };
}

describe("published ROS interval presentation descriptors", () => {
  it.each([legacy, marginal])("preserves the exact $kind contract through JSON", (descriptor) => {
    expect(parseRosIntervalDescriptor(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor);
    expect(rosIntervalDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    const set = projectionSetSummarySchema.parse(projectionSet(descriptor));
    expect(set.managed?.rosInterval).toEqual(descriptor);
  });

  it("keeps old cached payloads without a descriptor valid and does not invent one", () => {
    const parsed = projectionSetSummarySchema.parse(projectionSet());
    expect(parsed.managed).not.toHaveProperty("rosInterval");
    expect(parseRosIntervalDescriptor(parsed.managed?.rosInterval)).toBeNull();
  });

  it("allows explicitly unavailable evidence independently of the set's quality state", () => {
    const parsed = projectionSetSummarySchema.parse(projectionSet(null));
    expect(parsed.managed?.rosInterval).toBeNull();
    expect(parsed.managed?.qualityState).toBe("publishable");
  });

  it("does not equate a presentation descriptor with release authorization", () => {
    const fixture = projectionSet(marginal);
    fixture.managed.qualityState = "rejected";
    expect(projectionSetSummarySchema.parse(fixture).managed?.qualityState).toBe("rejected");
    expect(rosIntervalDescriptorSchema.safeParse({ ...marginal, admitted: true }).success).toBe(
      false,
    );
  });

  it.each([
    undefined,
    null,
    [],
    {},
    false,
    1,
    "season-prior-weighted-quantile-residuals-v1",
    { ...legacy, kind: "future-method" },
    { ...legacy, method: marginal.method },
    { ...legacy, nominalCoverage: 0.7 },
    { ...legacy, target: marginal.target },
    { ...marginal, method: legacy.method },
    { ...marginal, target: "simultaneous-block-coverage" },
    { ...marginal, nominalCoverage: 0.8 },
    { ...marginal, qualificationMethod: "development-screen" },
    { ...marginal, evidenceInterpretation: "individual-guarantee" },
    { ...marginal, evidenceChecksum: "B".repeat(64) },
    { ...marginal, evidenceChecksum: `sha256:${"b".repeat(64)}` },
    { ...marginal, evidenceChecksum: "b".repeat(63) },
    { ...marginal, evidenceChecksum: null },
    { ...marginal, quantiles: [0.15, 0.85] },
    { ...marginal, quantiles: [0.15, 0.85, 0.5] },
    { ...marginal, quantiles: [0.15, 0.5, 0.85, 1] },
    { ...marginal, quantiles: [0.15, NaN, 0.85] },
    { ...marginal, quantiles: new Array(3) },
    { ...marginal, extra: true },
  ])("treats malformed, absent or unknown evidence as unavailable %#", (value) => {
    expect(parseRosIntervalDescriptor(value)).toBeNull();
    expect(rosIntervalDescriptorSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a descriptor with any required field missing", () => {
    for (const descriptor of [legacy, marginal])
      for (const key of Object.keys(descriptor)) {
        const incomplete = { ...descriptor } as Record<string, unknown>;
        delete incomplete[key];
        expect(parseRosIntervalDescriptor(incomplete), key).toBeNull();
      }
  });

  it("rejects an invalid descriptor inside the outer managed-set contract", () => {
    expect(
      projectionSetSummarySchema.safeParse(projectionSet({ ...marginal, method: "unknown" }))
        .success,
    ).toBe(false);
  });

  it("does not infer a method from model names, horizons or unrelated metadata", () => {
    expect(
      parseRosIntervalDescriptor({
        modelVersion: "season-prior-weighted-quantile-residuals-v1",
        horizon: "rest-of-season",
        metadata: { rosInterval: marginal },
      }),
    ).toBeNull();
    const fixture = projectionSet();
    fixture.managed.modelVersion = marginal.method;
    expect(projectionSetSummarySchema.parse(fixture).managed).not.toHaveProperty("rosInterval");
  });
});
