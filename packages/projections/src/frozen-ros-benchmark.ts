import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import {
  evaluateRetainedV12FirstPartyRosChampionPolicy,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosHeldOutForecast,
} from "./rest-of-season.js";
import type { RosMarginalQualificationDataset } from "./ros-marginal-interval-qualification.js";
import { sha256Hex } from "./sha256.js";
import { isDefensePointsAllowedStatId } from "./scoring.js";

export const FROZEN_ROS_BENCHMARK_VERSION = "original-forecasts-corrected-observations-v1";

export interface FrozenRosBenchmarkInput {
  /** Original report data, including the original observations used to fit its policies. */
  readonly original: RosMarginalQualificationDataset;
  /** Higher-level authenticated lineage binds the original and corrected observed sources. */
  readonly comparisonManifestChecksum: string;
}

function fail(reason: string): never {
  throw new Error(`Frozen ROS benchmark: ${reason}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value)))
    fail("invalid evidence value");
  return encoded;
}

function digest(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("invalid source checksum");
}

/** Definition annotations may clarify old PA labels; numerical rules must remain identical. */
function numericalScoringKey(key: string): string {
  if (typeof key !== "string" || key.length > 65_536) fail("invalid scoring identity");
  const rules: unknown = JSON.parse(key);
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 512)
    fail("invalid scoring rules");
  return canonical(
    rules.map((rule: unknown) => {
      if (rule === null || typeof rule !== "object" || Array.isArray(rule))
        fail("invalid scoring rule");
      const { statDefinition, ...numeric } = rule as Record<string, unknown>;
      if (
        statDefinition !== undefined &&
        (!isDefensePointsAllowedStatId(String(numeric.statId)) ||
          (statDefinition !== "yahoo-2022-v1" && statDefinition !== "espn-2019-v1"))
      )
        fail("unknown scoring definition annotation");
      return numeric;
    }),
  );
}

function prediction(row: FirstPartyRosHeldOutForecast) {
  // Every other field, including physical input/seed-linked checksums and availability evidence,
  // must match. Correcting labels never permits changing the comparator's forecasts.
  return {
    playerId: row.playerId,
    position: row.position,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    trainedThroughSeason: row.trainedThroughSeason,
    inputChecksum: row.inputChecksum,
    contextualModelVersion: row.contextualModelVersion,
    recencyModelVersion: row.recencyModelVersion,
    intervalMethodVersion: row.intervalMethodVersion,
    contextual: row.contextual,
    recency: row.recency,
    evidence: row.evidence,
  };
}

function checked(input: RosMarginalQualificationDataset) {
  for (const value of [
    input.rowsChecksum,
    input.sourceManifestChecksum,
    input.source.reportChecksum,
    input.source.physicalCorpusChecksum,
  ])
    digest(value);
  if (
    input.source.modelVersion !== "laces-ros-distribution-v12" ||
    input.source.policyVersion !== "season-walk-forward-mean-rmse-block-wis-cqr-v7"
  )
    fail("unsupported previous model or evaluator");
  const result = validateMarginalRosTrainingCohort(input.heldOutSeasons, input.heldOutSeasons);
  if (result.provenance.evaluationRowsChecksum !== input.rowsChecksum)
    fail("original/corrected rows do not match their source pin");
  const rows = result.ordered.flatMap((year) => year.forecasts);
  if (
    rows.some(
      (row) =>
        row.scoringProfileKey !== input.source.scoringProfileKey ||
        !row.contextualModelVersion.startsWith(`${input.source.modelVersion}:contextual:`) ||
        !row.recencyModelVersion.startsWith(
          `${input.source.modelVersion}:availability-aware-recency:`,
        ),
    )
  )
    fail("previous row/source identity mismatch");
  return { ...result, rows };
}

/**
 * Preserve the previous forecast by fitting its policy to its ORIGINAL observations. Corrected
 * observations are used only to score that forecast. These pins provide integrity, not source
 * authentication; the derived-evidence boundary must authenticate the comparison manifest.
 */
export function buildFrozenRosBenchmark(
  input: FrozenRosBenchmarkInput,
  corrected: RosMarginalQualificationDataset,
  options: FirstPartyRosChampionOptions,
) {
  digest(input.comparisonManifestChecksum);
  const original = checked(input.original);
  const evaluated = checked(corrected);
  if (
    numericalScoringKey(input.original.source.scoringProfileKey) !==
    numericalScoringKey(corrected.source.scoringProfileKey)
  )
    fail("original/corrected numerical scoring rules differ");
  if (
    canonical(original.provenance.seasons) !== canonical(evaluated.provenance.seasons) ||
    original.rows.length !== evaluated.rows.length
  )
    fail("original/corrected cohort differs");
  for (let index = 0; index < original.rows.length; index++)
    if (
      canonical(prediction(original.rows[index]!)) !== canonical(prediction(evaluated.rows[index]!))
    )
      fail("corrected observations changed an original forecast");
  const binding = {
    version: FROZEN_ROS_BENCHMARK_VERSION,
    comparisonManifestChecksum: input.comparisonManifestChecksum,
    original: {
      source: input.original.source,
      sourceManifestChecksum: input.original.sourceManifestChecksum,
      rowsChecksum: input.original.rowsChecksum,
    },
    correctedObservations: {
      source: corrected.source,
      sourceManifestChecksum: corrected.sourceManifestChecksum,
      rowsChecksum: corrected.rowsChecksum,
    },
  } as const;
  return {
    evaluation: evaluateRetainedV12FirstPartyRosChampionPolicy(original.ordered, options),
    binding: { ...binding, checksum: sha256Hex(canonical(binding)) },
  };
}

export type FrozenRosBenchmarkBinding = ReturnType<typeof buildFrozenRosBenchmark>["binding"];

/** Storage integrity only: admission must separately authenticate the original report bytes. */
export function frozenRosBenchmarkBindingIsValid(
  value: unknown,
  corrected: FrozenRosBenchmarkBinding["correctedObservations"],
): value is FrozenRosBenchmarkBinding {
  try {
    const object = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(input, key))
      )
        fail("invalid stored binding shape");
      return input as Record<string, unknown>;
    };
    const binding = object(value, [
      "version",
      "comparisonManifestChecksum",
      "original",
      "correctedObservations",
      "checksum",
    ]);
    if (binding.version !== FROZEN_ROS_BENCHMARK_VERSION) fail("invalid stored binding version");
    digest(binding.comparisonManifestChecksum as string);
    digest(binding.checksum as string);
    for (const role of ["original", "correctedObservations"] as const) {
      const evidence = object(binding[role], ["source", "sourceManifestChecksum", "rowsChecksum"]);
      const source = object(evidence.source, [
        "modelVersion",
        "policyVersion",
        "scoringProfileKey",
        "physicalCorpusChecksum",
        "reportChecksum",
      ]);
      for (const pin of [
        evidence.sourceManifestChecksum,
        evidence.rowsChecksum,
        source.physicalCorpusChecksum,
        source.reportChecksum,
      ])
        digest(pin as string);
      if (
        source.modelVersion !== "laces-ros-distribution-v12" ||
        source.policyVersion !== "season-walk-forward-mean-rmse-block-wis-cqr-v7"
      )
        fail("invalid stored benchmark model");
      numericalScoringKey(source.scoringProfileKey as string);
    }
    const stored = value as FrozenRosBenchmarkBinding;
    if (
      numericalScoringKey(stored.original.source.scoringProfileKey) !==
      numericalScoringKey(stored.correctedObservations.source.scoringProfileKey)
    )
      fail("stored numerical scoring differs");
    if (canonical(stored.correctedObservations) !== canonical(corrected))
      fail("stored corrected observations differ");
    const { checksum, ...body } = stored;
    return checksum === sha256Hex(canonical(body));
  } catch {
    return false;
  }
}
