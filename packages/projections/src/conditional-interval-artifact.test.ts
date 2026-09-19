import { beforeAll, describe, expect, it } from "vitest";
import {
  conditionalIntervalArtifactIsValid,
  conditionalIntervalArtifactSeriesKey,
  createConditionalIntervalArtifact,
  prepareConditionalIntervalArtifact,
  type ConditionalIntervalArtifact,
  type ConditionalIntervalArtifactContext,
} from "./conditional-interval-artifact.js";
import {
  fitConditionalIntervalCalibration,
  type ConditionalIntervalHistoryRow,
} from "./conditional-interval-calibration.js";
import { conditionalContractCanonical } from "./conditional-interval-contract.js";
import { marginalIntervalArtifactIsValid } from "./marginal-interval-artifact.js";
import { rosScoringProfile } from "./ros-scoring-profiles.js";
import { sha256Hex } from "./sha256.js";

const context: ConditionalIntervalArtifactContext = {
  position: "WR",
  bucket: "one-to-four",
  strategy: "contextual",
  evidenceIdentity: {
    contextualModelVersion: "model:contextual:v1",
    recencyModelVersion: "model:recency:v1",
    intervalMethodVersion: "raw-v1",
    scoringProfileKey: rosScoringProfile("full-ppr").scoringProfileKey,
  },
};
const provenance = {
  protocolChecksum: sha256Hex("protocol"),
  sourceManifestChecksum: sha256Hex("sources"),
  physicalCorpusChecksum: sha256Hex("corpus"),
  reportChecksum: sha256Hex("report"),
  trainingRowsChecksum: sha256Hex("training"),
};
function history(): ConditionalIntervalHistoryRow[] {
  return [14, 15, 16].flatMap((asOfWeek) =>
    Array.from({ length: 6 }, (_, player) => {
      const games = 18 - asOfWeek,
        mean = 10 * games + player;
      return {
        seriesKey: conditionalIntervalArtifactSeriesKey(context),
        identity: `${asOfWeek}:${player}`,
        playerId: `player-${player}`,
        forecastSeason: 2025,
        asOfWeek,
        windowStartWeek: asOfWeek + 1,
        windowEndWeek: 18,
        scheduledGames: games,
        meanPoints: mean,
        p15Points: mean - games,
        p50Points: mean,
        p85Points: mean + games,
        actualPoints: mean,
      };
    }),
  );
}
let artifact: ConditionalIntervalArtifact;
beforeAll(() => {
  artifact = createConditionalIntervalArtifact({
    context,
    provenance,
    fit: fitConditionalIntervalCalibration({
      seriesKey: conditionalIntervalArtifactSeriesKey(context),
      forecastSeason: 2026,
      completedSeasons: [2025],
      rows: history(),
    }),
  });
});
const expected = () => ({
  context,
  forecastSeason: 2026,
  artifactChecksum: artifact.artifactChecksum,
});
const forecast = () => ({ ...history()[0]!, forecastSeason: 2026 });
function reseal(value: ConditionalIntervalArtifact) {
  const { artifactChecksum: _discard, ...body } = value;
  void _discard;
  return { ...body, artifactChecksum: sha256Hex(conditionalContractCanonical(body)) };
}

describe("certified conditional release artifacts without admission authority", () => {
  it("certifies the fit, preserves mean and exposes exact corrected endpoints", () => {
    expect(conditionalIntervalArtifactIsValid(artifact)).toBe(true);
    expect(artifact.canAuthorizeRelease).toBe(false);
    const result = prepareConditionalIntervalArtifact(artifact, expected())(forecast());
    expect(result.meanPoints).toBe(forecast().meanPoints);
    expect(result.p15Points).toBeCloseTo(forecast().meanPoints, 9);
    expect(result.p50Points).toBeCloseTo(forecast().meanPoints, 9);
    expect(result.p85Points).toBeCloseTo(forecast().meanPoints, 9);
    expect(result.calibrationArtifactChecksum).toBe(artifact.artifactChecksum);
  });
  it("does not accept a development fit or unconditional artifact as this contract", () => {
    expect(conditionalIntervalArtifactIsValid(artifact.fit)).toBe(false);
    expect(marginalIntervalArtifactIsValid(artifact)).toBe(false);
    expect(
      conditionalIntervalArtifactIsValid({
        ...artifact,
        artifactVersion: "ros-marginal-interval-artifact-v1",
      }),
    ).toBe(false);
    expect(conditionalIntervalArtifactIsValid({ ...artifact, extra: true })).toBe(false);
  });
  it("rejects rehashed coefficients because dual certification independently fails", () => {
    const forged = structuredClone(artifact);
    const solution = forged.fit.solutions[1];
    Object.assign(solution, { intercept: solution.intercept + 1 });
    const { checksum: _discard, ...fitBody } = forged.fit;
    void _discard;
    // The outer hash alone can be forged; changing both cannot supply a valid certificate.
    Object.assign(forged.fit, { checksum: sha256Hex(conditionalContractCanonical(fitBody)) });
    expect(conditionalIntervalArtifactIsValid(reseal(forged))).toBe(false);
  });
  it("requires exact profile, strategy, season and expected external artifact pin", () => {
    const alternate = {
      ...context,
      evidenceIdentity: {
        ...context.evidenceIdentity,
        scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey,
      },
    };
    expect(() =>
      prepareConditionalIntervalArtifact(artifact, { ...expected(), context: alternate }),
    ).toThrow(/binding/);
    expect(() =>
      prepareConditionalIntervalArtifact(artifact, {
        ...expected(),
        context: { ...context, strategy: "availability-aware-recency" },
      }),
    ).toThrow(/binding/);
    expect(() =>
      prepareConditionalIntervalArtifact(artifact, { ...expected(), forecastSeason: 2027 }),
    ).toThrow(/binding/);
    expect(() =>
      prepareConditionalIntervalArtifact(artifact, {
        ...expected(),
        artifactChecksum: sha256Hex("other"),
      }),
    ).toThrow(/binding/);
    const forged = reseal({
      ...artifact,
      provenance: { ...provenance, reportChecksum: sha256Hex("different-report") },
    });
    expect(() => prepareConditionalIntervalArtifact(forged, expected())).toThrow(/binding/);
  });
  it("owns a detached runtime snapshot and permits JSON key reordering", () => {
    const copy = structuredClone(artifact);
    const apply = prepareConditionalIntervalArtifact(copy, expected());
    Object.assign(copy.fit.preprocessing, { scale: 999 });
    expect(apply(forecast())).toEqual(
      prepareConditionalIntervalArtifact(artifact, expected())(forecast()),
    );
    const reordered = Object.fromEntries(Object.entries(artifact).reverse());
    expect(conditionalIntervalArtifactIsValid(reordered)).toBe(true);
  });
  it("rejects wrong horizon, year, nonfinite input and unavailable fits without raw fallback", () => {
    const apply = prepareConditionalIntervalArtifact(artifact, expected());
    expect(() => apply({ ...forecast(), asOfWeek: 9, windowStartWeek: 10 })).toThrow(/horizon/);
    expect(() => apply({ ...forecast(), forecastSeason: 2027 })).toThrow();
    expect(() => apply({ ...forecast(), meanPoints: Infinity })).toThrow();
    const fit = fitConditionalIntervalCalibration({
      seriesKey: conditionalIntervalArtifactSeriesKey(context),
      forecastSeason: 2026,
      completedSeasons: [2025],
      rows: [],
    });
    expect(() => createConditionalIntervalArtifact({ context, provenance, fit })).toThrow(/fitted/);
  });
  it("enforces constant-game applicability rather than extrapolating an unidentified feature", () => {
    const rows = history().map((row) => ({ ...row, scheduledGames: 2 }));
    const fixed = createConditionalIntervalArtifact({
      context,
      provenance,
      fit: fitConditionalIntervalCalibration({
        seriesKey: conditionalIntervalArtifactSeriesKey(context),
        forecastSeason: 2026,
        completedSeasons: [2025],
        rows,
      }),
    });
    const apply = prepareConditionalIntervalArtifact(fixed, {
      ...expected(),
      artifactChecksum: fixed.artifactChecksum,
    });
    expect(() => apply({ ...forecast(), scheduledGames: 3 })).toThrow(/constant|volume|game/i);
  });
  it("validates future observations but excludes their targets from the fitted artifact", () => {
    const rows = [
      ...history(),
      { ...history()[0]!, identity: "future", forecastSeason: 2026, actualPoints: 1e9 },
    ];
    const withFuture = createConditionalIntervalArtifact({
      context,
      provenance,
      fit: fitConditionalIntervalCalibration({
        seriesKey: conditionalIntervalArtifactSeriesKey(context),
        forecastSeason: 2026,
        completedSeasons: [2025],
        rows,
      }),
    });
    expect(withFuture).toEqual(artifact);
    expect(() =>
      createConditionalIntervalArtifact({
        context,
        provenance,
        fit: fitConditionalIntervalCalibration({
          seriesKey: conditionalIntervalArtifactSeriesKey(context),
          forecastSeason: 2026,
          completedSeasons: [2025],
          rows: [...history(), { ...rows.at(-1)!, meanPoints: NaN }],
        }),
      }),
    ).toThrow();
  });
});
