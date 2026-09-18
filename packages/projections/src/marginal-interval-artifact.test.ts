import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyMarginalIntervalArtifact,
  createMarginalIntervalArtifact,
  marginalIntervalArtifactIsValid,
  marginalIntervalArtifactSeriesKey,
  type MarginalIntervalArtifactContext,
} from "./marginal-interval-artifact.js";
import {
  assertMarginalIntervalCalibrationParameters,
  type MarginalIntervalCalibrationParameters,
  type MarginalIntervalHistoryRow,
} from "./marginal-interval-calibration.js";
import { projectionScoringProfileKey } from "./scoring.js";
import { sha256Hex } from "./sha256.js";

const context: MarginalIntervalArtifactContext = {
  position: "TE",
  bucket: "nine-plus",
  strategy: "contextual",
  evidenceIdentity: {
    contextualModelVersion: "test-v13:contextual",
    recencyModelVersion: "test-v13:recency",
    scoringProfileKey: projectionScoringProfileKey({
      id: "test",
      version: "1",
      rules: [{ statId: "receptions", points: 1 }],
    }),
    intervalMethodVersion: "simulation-p15-p50-p85-cqr-v1",
  },
};
const seriesKey = marginalIntervalArtifactSeriesKey(context);
function rows(): MarginalIntervalHistoryRow[] {
  return Array.from({ length: 18 }, (_, i) => {
    const asOfWeek = Math.floor(i / 6) + 1;
    return {
      seriesKey,
      identity: `r${i}`,
      playerId: `p${i}`,
      forecastSeason: 2022,
      asOfWeek,
      windowStartWeek: asOfWeek + 1,
      windowEndWeek: 18,
      scheduledGames: 10,
      actualPoints: i * 10 - 30,
      p15Points: 0,
      p50Points: 20,
      p85Points: 40,
    };
  });
}
function create(history = rows()) {
  return createMarginalIntervalArtifact({
    context,
    forecastSeason: 2023,
    completedSeasons: [2022],
    rows: history,
  });
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

describe("compact marginal interval artifacts", () => {
  it("binds executable parameters and exact context without storing historical rows", () => {
    const artifact = create();
    expect(marginalIntervalArtifactIsValid(artifact)).toBe(true);
    expect(artifact.fit.state).toBe("fitted");
    expect(artifact.fit).not.toHaveProperty("rows");
    expect(artifact).not.toHaveProperty("qualified");
    const forecast = { ...rows()[0]!, forecastSeason: 2023 };
    const result = applyMarginalIntervalArtifact(forecast, context, artifact);
    expect(result).toMatchObject({
      p15Points: -10,
      p50Points: 50,
      p85Points: 120,
      calibrationArtifactChecksum: artifact.artifactChecksum,
    });
    expect(result).not.toHaveProperty("meanPoints");
  });

  it("survives JSONB key reordering and deterministic input row ordering", () => {
    const artifact = create();
    const roundtrip = reverseKeys(JSON.parse(JSON.stringify(artifact)));
    expect(marginalIntervalArtifactIsValid(roundtrip)).toBe(true);
    expect(create([...rows()].reverse())).toEqual(artifact);
  });

  it("keeps prior corrections and evidence independent of unused future outcomes", () => {
    const future = rows().map((row) => ({
      ...row,
      forecastSeason: 2024,
      identity: `future-${row.identity}`,
      actualPoints: 99_999,
    }));
    expect(create([...rows(), ...future])).toEqual(create());
  });

  it("binds raw values even if all endpoint residuals are identical after a common shift", () => {
    const original = create();
    const shifted = create(
      rows().map((r) => ({
        ...r,
        actualPoints: r.actualPoints + 10,
        p15Points: r.p15Points + 10,
        p50Points: r.p50Points + 10,
        p85Points: r.p85Points + 10,
      })),
    );
    expect(shifted.fit).toEqual(original.fit);
    expect(shifted.evidenceChecksum).not.toBe(original.evidenceChecksum);
    expect(shifted.artifactChecksum).not.toBe(original.artifactChecksum);
  });

  it("represents insufficient support explicitly and refuses raw fallback", () => {
    const artifact = create([]);
    expect(marginalIntervalArtifactIsValid(artifact)).toBe(true);
    expect(artifact.fit.state).toBe("insufficient-evidence");
    expect(() =>
      applyMarginalIntervalArtifact({ ...rows()[0]!, forecastSeason: 2023 }, context, artifact),
    ).toThrow("not fitted");
  });

  it("validates compact support and dense correction triples independently of a checksum", () => {
    const fit = create().fit;
    const invalid: unknown[] = [
      { ...fit, blocks: 10, distinctCutoffs: 3 },
      { ...fit, samples: 0 },
      { ...fit, priorSeasons: [2023] },
      { ...fit, corrections: new Array(3) },
      { ...fit, corrections: [0, Infinity, 0] },
      { ...fit, state: "insufficient-evidence", corrections: null, reasons: [] },
      { ...create([]).fit, reasons: new Array(4) },
    ];
    for (const value of invalid)
      expect(() =>
        assertMarginalIntervalCalibrationParameters(value as MarginalIntervalCalibrationParameters),
      ).toThrow();
    expect(() => assertMarginalIntervalCalibrationParameters(fit)).not.toThrow();
    expect(() => assertMarginalIntervalCalibrationParameters(create([]).fit)).not.toThrow();
  });

  it("rejects changes to version, fit, context, prior evidence or unknown fields", () => {
    const original = create();
    if (original.fit.state !== "fitted") throw new Error("Fixture requires a fitted artifact");
    const mutations: unknown[] = [
      { ...original, schemaVersion: 2 },
      { ...original, calibrationVersion: "other" },
      {
        ...original,
        fit: {
          ...original.fit,
          corrections: [original.fit.corrections[0] + 0.1, ...original.fit.corrections.slice(1)],
        },
      },
      { ...original, fit: { ...original.fit, forecastSeason: 2024 } },
      { ...original, fit: { ...original.fit, priorSeasons: [2023] } },
      { ...original, context: { ...original.context, position: "WR" } },
      { ...original, evidenceChecksum: "f".repeat(64) },
      { ...original, extra: true },
      { ...original, fit: { ...original.fit, extra: true } },
      { ...original, fit: { ...original.fit, quantiles: new Array(3) } },
    ];
    for (const raw of mutations) {
      const artifact = raw as typeof original;
      expect(marginalIntervalArtifactIsValid(artifact)).toBe(false);
      expect(() =>
        applyMarginalIntervalArtifact({ ...rows()[0]!, forecastSeason: 2023 }, context, artifact),
      ).toThrow("artifact is invalid");
    }
  });

  it("fails closed on missing or malformed serialized objects", () => {
    for (const value of [
      null,
      undefined,
      [],
      {},
      5,
      "artifact",
      { ...create(), fit: null },
      { ...create(), context: null },
    ])
      expect(marginalIntervalArtifactIsValid(value)).toBe(false);
  });

  it("requires the exact season, scoring, strategy and remaining-week bucket at use", () => {
    const artifact = create();
    const forecast = { ...rows()[0]!, forecastSeason: 2023 };
    expect(() =>
      applyMarginalIntervalArtifact({ ...forecast, forecastSeason: 2024 }, context, artifact),
    ).toThrow("forecast season");
    expect(() =>
      applyMarginalIntervalArtifact(
        forecast,
        { ...context, strategy: "availability-aware-recency" },
        artifact,
      ),
    ).toThrow("scope mismatch");
    expect(() =>
      applyMarginalIntervalArtifact(
        { ...forecast, asOfWeek: 14, windowStartWeek: 15, scheduledGames: 4 },
        context,
        artifact,
      ),
    ).toThrow("bucket disagree");
    expect(() =>
      create(
        rows().map((row) => ({
          ...row,
          asOfWeek: row.asOfWeek + 12,
          windowStartWeek: row.windowStartWeek + 12,
          scheduledGames: 1,
        })),
      ),
    ).toThrow("bucket disagree");
  });
});

describe("shared browser-safe SHA-256", () => {
  it.each([
    "",
    "abc",
    "🏈é日本語",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(64),
    "x".repeat(129),
    JSON.stringify(context),
  ])("retains standard bytes for %s", (value) => {
    expect(sha256Hex(value)).toBe(createHash("sha256").update(value).digest("hex"));
  });
});
