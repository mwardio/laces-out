import {
  CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
  prepareConditionalIntervalCalibration,
  type ConditionalIntervalCalibrationFit,
  type ConditionalIntervalForecast,
} from "./conditional-interval-calibration.js";
import {
  marginalIntervalArtifactSeriesKey,
  type MarginalIntervalArtifactContext,
} from "./marginal-interval-artifact.js";
import {
  conditionalContractCanonical as canonical,
  conditionalContractDigest as digest,
  conditionalContractObject as object,
} from "./conditional-interval-contract.js";
import { sha256Hex } from "./sha256.js";

export const CONDITIONAL_INTERVAL_RELEASE_ARTIFACT_VERSION = "ros-conditional-interval-artifact-v1";
export type ConditionalIntervalArtifactContext = MarginalIntervalArtifactContext;
export interface ConditionalIntervalArtifactProvenance {
  readonly protocolChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly physicalCorpusChecksum: string;
  readonly reportChecksum: string;
  readonly trainingRowsChecksum: string;
}
/** Certified arithmetic plus exact context/provenance pins, not an admission or signed source. */
export interface ConditionalIntervalArtifact {
  readonly schemaVersion: 1;
  readonly artifactVersion: typeof CONDITIONAL_INTERVAL_RELEASE_ARTIFACT_VERSION;
  readonly calibrationVersion: typeof CONDITIONAL_INTERVAL_CALIBRATION_VERSION;
  readonly canAuthorizeRelease: false;
  readonly context: ConditionalIntervalArtifactContext;
  readonly provenance: ConditionalIntervalArtifactProvenance;
  readonly fit: ConditionalIntervalCalibrationFit & { readonly state: "fitted" };
  readonly artifactChecksum: string;
}

/** Exact same context namespace as the frozen chronological conditional adapter. */
export function conditionalIntervalArtifactSeriesKey(
  context: ConditionalIntervalArtifactContext,
): string {
  return `ros-conditional:${sha256Hex(
    JSON.stringify([
      CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
      marginalIntervalArtifactSeriesKey(context),
    ]),
  )}`;
}
function windowMatches(
  forecast: ConditionalIntervalForecast,
  context: ConditionalIntervalArtifactContext,
) {
  const weeks = forecast.windowEndWeek - forecast.windowStartWeek + 1;
  const bucket = weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
  if (bucket !== context.bucket) throw new Error("Conditional artifact horizon mismatch");
}
function prepare(input: {
  readonly context: ConditionalIntervalArtifactContext;
  readonly provenance: ConditionalIntervalArtifactProvenance;
  readonly fit: ConditionalIntervalCalibrationFit;
}) {
  object(input, ["context", "provenance", "fit"]);
  object(input.provenance, [
    "protocolChecksum",
    "sourceManifestChecksum",
    "physicalCorpusChecksum",
    "reportChecksum",
    "trainingRowsChecksum",
  ]);
  for (const pin of Object.values(input.provenance)) digest(pin);
  const series = conditionalIntervalArtifactSeriesKey(input.context);
  // Bound arbitrary supplied trees before the existing certifier reconstructs all known fields.
  canonical(input);
  const snapshot = structuredClone(input);
  if (snapshot.fit.state !== "fitted" || snapshot.fit.seriesKey !== series)
    throw new Error("Conditional artifact needs a fitted, context-bound solution");
  for (const { row } of snapshot.fit.history) windowMatches(row, snapshot.context);
  const apply = prepareConditionalIntervalCalibration(snapshot.fit);
  const body = {
    schemaVersion: 1 as const,
    artifactVersion: CONDITIONAL_INTERVAL_RELEASE_ARTIFACT_VERSION,
    calibrationVersion: CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
    canAuthorizeRelease: false as const,
    context: snapshot.context,
    provenance: snapshot.provenance,
    fit: snapshot.fit,
  };
  return { body, apply };
}

/** Reconstructs preprocessing and all three independent dual certificates, not just hashes. */
export function createConditionalIntervalArtifact(input: {
  readonly context: ConditionalIntervalArtifactContext;
  readonly provenance: ConditionalIntervalArtifactProvenance;
  readonly fit: ConditionalIntervalCalibrationFit;
}): ConditionalIntervalArtifact {
  const { body } = prepare(input);
  return { ...body, artifactChecksum: sha256Hex(canonical(body)) };
}

/** Prepare once per admitted cell; the closure owns its detached certified fit and context. */
export function prepareConditionalIntervalArtifact(
  supplied: ConditionalIntervalArtifact,
  expected: {
    readonly context: ConditionalIntervalArtifactContext;
    readonly forecastSeason: number;
    readonly artifactChecksum: string;
  },
) {
  object(supplied, [
    "schemaVersion",
    "artifactVersion",
    "calibrationVersion",
    "canAuthorizeRelease",
    "context",
    "provenance",
    "fit",
    "artifactChecksum",
  ]);
  object(expected, ["context", "forecastSeason", "artifactChecksum"]);
  digest(supplied.artifactChecksum);
  digest(expected.artifactChecksum);
  if (
    supplied.schemaVersion !== 1 ||
    supplied.artifactVersion !== CONDITIONAL_INTERVAL_RELEASE_ARTIFACT_VERSION ||
    supplied.calibrationVersion !== CONDITIONAL_INTERVAL_CALIBRATION_VERSION ||
    supplied.canAuthorizeRelease !== false
  )
    throw new Error("Conditional artifact method mismatch");
  const { body, apply } = prepare({
    context: supplied.context,
    provenance: supplied.provenance,
    fit: supplied.fit,
  });
  const checksum = sha256Hex(canonical(body));
  if (
    checksum !== supplied.artifactChecksum ||
    checksum !== expected.artifactChecksum ||
    body.fit.forecastSeason !== expected.forecastSeason ||
    conditionalIntervalArtifactSeriesKey(expected.context) !== body.fit.seriesKey
  )
    throw new Error("Conditional artifact binding mismatch");
  return (forecast: ConditionalIntervalForecast) => {
    windowMatches(forecast, body.context);
    const correction = apply(forecast);
    if (correction.meanPoints !== forecast.meanPoints)
      throw new Error("Conditional artifact changed the raw mean");
    return { ...correction, calibrationArtifactChecksum: checksum };
  };
}
export function conditionalIntervalArtifactIsValid(
  value: unknown,
): value is ConditionalIntervalArtifact {
  try {
    const artifact = value as ConditionalIntervalArtifact;
    prepareConditionalIntervalArtifact(artifact, {
      context: artifact.context,
      forecastSeason: artifact.fit.forecastSeason,
      artifactChecksum: artifact.artifactChecksum,
    });
    return true;
  } catch {
    return false;
  }
}
