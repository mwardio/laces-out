import {
  MARGINAL_INTERVAL_CALIBRATION_VERSION,
  applyMarginalIntervalCalibration,
  assertMarginalIntervalCalibrationParameters,
  fitMarginalIntervalCalibration,
  type MarginalIntervalCalibrationParameters,
  type MarginalIntervalCorrection,
  type MarginalIntervalForecast,
  type MarginalIntervalHistoryRow,
} from "./marginal-interval-calibration.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { sha256Hex } from "./sha256.js";
import type {
  FirstPartyRosEvidenceIdentity,
  FirstPartyRosPosition,
  FirstPartyRosRemainingWeeksBucket,
  FirstPartyRosStrategy,
} from "./rest-of-season.js";

export const MARGINAL_INTERVAL_ARTIFACT_VERSION = "ros-marginal-interval-artifact-v1";

export interface MarginalIntervalArtifactContext {
  readonly strategy: FirstPartyRosStrategy;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly evidenceIdentity: FirstPartyRosEvidenceIdentity;
}

/** A compact authenticated fit. Qualification must come from separate chronological evidence. */
export interface MarginalIntervalArtifact {
  readonly schemaVersion: 1;
  readonly artifactVersion: typeof MARGINAL_INTERVAL_ARTIFACT_VERSION;
  readonly calibrationVersion: typeof MARGINAL_INTERVAL_CALIBRATION_VERSION;
  readonly context: MarginalIntervalArtifactContext;
  readonly fit: MarginalIntervalCalibrationParameters;
  /** Binds the ordered prior rows and their executable residuals, schedule, identity and weights. */
  readonly evidenceChecksum: string;
  readonly artifactChecksum: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (!record(value)) throw new TypeError("Marginal artifact field must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || [...expected].sort().some((key, i) => keys[i] !== key))
    throw new Error("Marginal artifact has unknown or missing fields");
}

function string(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum)
    throw new Error("Marginal artifact identity must be a bounded nonempty string");
}

function canonicalContext(
  context: MarginalIntervalArtifactContext,
): MarginalIntervalArtifactContext {
  exactKeys(context, ["strategy", "position", "bucket", "evidenceIdentity"]);
  if (
    !["contextual", "availability-aware-recency"].includes(context.strategy) ||
    !["QB", "RB", "WR", "TE", "K", "DST"].includes(context.position) ||
    !["one-to-four", "five-to-eight", "nine-plus"].includes(context.bucket)
  )
    throw new Error("Marginal artifact scope is invalid");
  const identity = context.evidenceIdentity;
  exactKeys(identity, [
    "contextualModelVersion",
    "recencyModelVersion",
    "scoringProfileKey",
    "intervalMethodVersion",
  ]);
  string(identity.contextualModelVersion, 256);
  string(identity.recencyModelVersion, 256);
  string(identity.intervalMethodVersion, 256);
  string(identity.scoringProfileKey, 65_536);
  projectionScoringRulesFromProfileKey(identity.scoringProfileKey);
  return {
    strategy: context.strategy,
    position: context.position,
    bucket: context.bucket,
    evidenceIdentity: {
      contextualModelVersion: identity.contextualModelVersion,
      recencyModelVersion: identity.recencyModelVersion,
      scoringProfileKey: identity.scoringProfileKey,
      intervalMethodVersion: identity.intervalMethodVersion,
    },
  };
}

export function marginalIntervalArtifactSeriesKey(
  context: MarginalIntervalArtifactContext,
): string {
  return `ros-marginal:${sha256Hex(JSON.stringify(canonicalContext(context)))}`;
}

function canonicalFit(
  fit: MarginalIntervalCalibrationParameters,
): MarginalIntervalCalibrationParameters {
  assertMarginalIntervalCalibrationParameters(fit);
  exactKeys(fit, [
    "version",
    "target",
    "nominalCoverage",
    "quantiles",
    "weighting",
    "scale",
    "seriesKey",
    "forecastSeason",
    "priorSeasons",
    "samples",
    "blocks",
    "distinctCutoffs",
    "state",
    "corrections",
    ...(fit.state === "insufficient-evidence" ? ["reasons"] : []),
  ]);
  const common = {
    version: fit.version,
    target: fit.target,
    nominalCoverage: fit.nominalCoverage,
    quantiles: [...fit.quantiles] as [0.15, 0.5, 0.85],
    weighting: fit.weighting,
    scale: fit.scale,
    seriesKey: fit.seriesKey,
    forecastSeason: fit.forecastSeason,
    priorSeasons: [...fit.priorSeasons],
    samples: fit.samples,
    blocks: fit.blocks,
    distinctCutoffs: fit.distinctCutoffs,
  };
  return fit.state === "fitted"
    ? { ...common, state: "fitted", corrections: [...fit.corrections] as [number, number, number] }
    : { ...common, state: "insufficient-evidence", corrections: null, reasons: [...fit.reasons] };
}

function payload(
  artifact: Omit<MarginalIntervalArtifact, "artifactChecksum">,
): Omit<MarginalIntervalArtifact, "artifactChecksum"> {
  if (
    artifact.schemaVersion !== 1 ||
    artifact.artifactVersion !== MARGINAL_INTERVAL_ARTIFACT_VERSION ||
    artifact.calibrationVersion !== MARGINAL_INTERVAL_CALIBRATION_VERSION
  )
    throw new Error("Marginal artifact version is invalid");
  if (
    typeof artifact.evidenceChecksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.evidenceChecksum)
  )
    throw new Error("Marginal artifact evidence checksum is invalid");
  const context = canonicalContext(artifact.context);
  const fit = canonicalFit(artifact.fit);
  if (fit.seriesKey !== marginalIntervalArtifactSeriesKey(context))
    throw new Error("Marginal artifact fit and context disagree");
  return {
    schemaVersion: 1,
    artifactVersion: MARGINAL_INTERVAL_ARTIFACT_VERSION,
    calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
    context,
    fit,
    evidenceChecksum: artifact.evidenceChecksum,
  };
}

function assertWindowBucket(
  forecast: MarginalIntervalForecast,
  context: MarginalIntervalArtifactContext,
): void {
  const weeks = forecast.windowEndWeek - forecast.windowStartWeek + 1;
  const bucket = weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
  if (bucket !== context.bucket)
    throw new Error("Marginal interval window and artifact bucket disagree");
}

/** Canonical reconstruction makes JSONB key ordering irrelevant; checksums are not signatures. */
export function marginalIntervalArtifactIsValid(value: unknown): value is MarginalIntervalArtifact {
  try {
    exactKeys(value, [
      "schemaVersion",
      "artifactVersion",
      "calibrationVersion",
      "context",
      "fit",
      "evidenceChecksum",
      "artifactChecksum",
    ]);
    const artifact = value as MarginalIntervalArtifact;
    return (
      typeof artifact.artifactChecksum === "string" &&
      /^[a-f0-9]{64}$/u.test(artifact.artifactChecksum) &&
      sha256Hex(JSON.stringify(payload(artifact))) === artifact.artifactChecksum
    );
  } catch {
    return false;
  }
}

/** Keep complete row evidence in the historical report; the live policy stores its bound fit. */
export function createMarginalIntervalArtifact(input: {
  readonly context: MarginalIntervalArtifactContext;
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly rows: readonly MarginalIntervalHistoryRow[];
}): MarginalIntervalArtifact {
  const context = canonicalContext(input.context);
  const result = fitMarginalIntervalCalibration({
    seriesKey: marginalIntervalArtifactSeriesKey(context),
    forecastSeason: input.forecastSeason,
    completedSeasons: input.completedSeasons,
    rows: input.rows,
  });
  const { rows, ...parameters } = result;
  for (const row of input.rows) assertWindowBucket(row, context);
  const byIdentity = new Map(input.rows.map((row) => [row.identity, row]));
  const rawRows = rows.map(({ identity }) => {
    const row = byIdentity.get(identity)!;
    return {
      identity: row.identity,
      playerId: row.playerId,
      seriesKey: row.seriesKey,
      forecastSeason: row.forecastSeason,
      asOfWeek: row.asOfWeek,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      scheduledGames: row.scheduledGames,
      actualPoints: row.actualPoints,
      p15Points: row.p15Points,
      p50Points: row.p50Points,
      p85Points: row.p85Points,
    };
  });
  const body = payload({
    schemaVersion: 1,
    artifactVersion: MARGINAL_INTERVAL_ARTIFACT_VERSION,
    calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
    context,
    fit: parameters,
    evidenceChecksum: sha256Hex(JSON.stringify({ context, rawRows, weightedRows: rows })),
  });
  return { ...body, artifactChecksum: sha256Hex(JSON.stringify(body)) };
}

/** No raw fallback for malformed or insufficient artifacts. Publication must withhold instead. */
export function applyMarginalIntervalArtifact(
  forecast: MarginalIntervalForecast,
  context: MarginalIntervalArtifactContext,
  artifact: MarginalIntervalArtifact,
): MarginalIntervalCorrection & { readonly calibrationArtifactChecksum: string } {
  if (!marginalIntervalArtifactIsValid(artifact))
    throw new Error("Marginal interval artifact is invalid");
  if (marginalIntervalArtifactSeriesKey(context) !== artifact.fit.seriesKey)
    throw new Error("Marginal interval artifact scope mismatch");
  const result = applyMarginalIntervalCalibration(forecast, artifact.fit);
  assertWindowBucket(forecast, context);
  return { ...result, calibrationArtifactChecksum: artifact.artifactChecksum };
}
