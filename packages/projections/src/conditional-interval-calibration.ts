import {
  CONDITIONAL_QUANTILE_NUMERICS,
  CONDITIONAL_QUANTILE_SOLVER_VERSION,
  certifyConditionalQuantile,
  solveConditionalQuantile,
  type ConditionalQuantileInput,
  type ConditionalQuantileSolution,
} from "./conditional-quantile-solver.js";
import {
  fitMarginalIntervalCalibration,
  type MarginalIntervalForecast,
  type MarginalIntervalHistoryRow,
  type MarginalIntervalTriple,
} from "./marginal-interval-calibration.js";
import { sha256Hex } from "./sha256.js";

/** Development candidate. This contract cannot replace a qualified v1 publication artifact. */
export const CONDITIONAL_INTERVAL_CALIBRATION_VERSION =
  "prior-regularized-strength-conditional-quantile-residuals-v1";
export const CONDITIONAL_INTERVAL_ARTIFACT_VERSION = "ros-conditional-interval-development-v1";
const QUANTILES = [0.15, 0.5, 0.85] as const;
const ENDPOINTS = ["p15Points", "p50Points", "p85Points"] as const;
type CertifiedSolution = Extract<ConditionalQuantileSolution, { status: "certified" }>;

export interface ConditionalIntervalForecast extends MarginalIntervalForecast {
  readonly meanPoints: number;
}
export interface ConditionalIntervalHistoryRow
  extends MarginalIntervalHistoryRow, ConditionalIntervalForecast {}
export interface ConditionalIntervalFitInput {
  readonly seriesKey: string;
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly rows: readonly ConditionalIntervalHistoryRow[];
}
export interface ConditionalIntervalPreprocessing {
  readonly scale: number;
  readonly meanPerGame: number;
  readonly inverseGamesMean: number;
  readonly volumeCoefficient: number;
  /** A constant-volume fit may only be applied at that same volume. */
  readonly constantScheduledGames: number | null;
}
interface WeightedRow {
  readonly row: ConditionalIntervalHistoryRow;
  readonly weightDenominator: number;
}
interface FitBase {
  readonly artifactVersion: typeof CONDITIONAL_INTERVAL_ARTIFACT_VERSION;
  readonly version: typeof CONDITIONAL_INTERVAL_CALIBRATION_VERSION;
  readonly solverVersion: typeof CONDITIONAL_QUANTILE_SOLVER_VERSION;
  readonly canAuthorizeRelease: false;
  readonly seriesKey: string;
  readonly forecastSeason: number;
  readonly priorSeasons: readonly number[];
  readonly samples: number;
  readonly blocks: number;
  readonly distinctCutoffs: number;
  readonly history: readonly WeightedRow[];
  /** Binds raw means, quantiles, targets, schedule, identities and exact rational weights. */
  readonly inputChecksum: string;
}
interface ReadyFit extends FitBase {
  readonly preprocessing: ConditionalIntervalPreprocessing;
  readonly rows: readonly {
    readonly identity: string;
    readonly weightDenominator: number;
    readonly feature: number;
    readonly unclippedFeature: number;
    readonly residuals: MarginalIntervalTriple;
  }[];
}
type UnavailableFit = FitBase & {
  readonly state: "unavailable";
  readonly reasons: readonly string[];
};
type FitPayload =
  | UnavailableFit
  | (ReadyFit & {
      readonly state: "fitted";
      readonly solutions: readonly [CertifiedSolution, CertifiedSolution, CertifiedSolution];
    });
export type ConditionalIntervalCalibrationFit = FitPayload & { readonly checksum: string };

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Conditional interval ${label} is nonfinite`);
  return value === 0 ? 0 : value;
}
function sum(values: readonly number[]): number {
  let total = 0;
  let error = 0;
  for (const value of values) {
    finite(value, "weighted term");
    const next = finite(total + value, "weighted sum");
    error = finite(
      error + (Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total),
      "summation compensation",
    );
    total = next;
  }
  return finite(total + error, "compensated sum");
}
function canonicalRow(row: ConditionalIntervalHistoryRow): ConditionalIntervalHistoryRow {
  for (const endpoint of ENDPOINTS) finite(row[endpoint], endpoint);
  if (row.p15Points > row.p50Points || row.p50Points > row.p85Points)
    throw new RangeError("Conditional interval raw quantiles must be ordered");
  return {
    seriesKey: row.seriesKey,
    identity: row.identity,
    playerId: row.playerId,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.scheduledGames,
    meanPoints: finite(row.meanPoints, "raw mean"),
    p15Points: row.p15Points,
    p50Points: row.p50Points,
    p85Points: row.p85Points,
    actualPoints: finite(row.actualPoints, "actual points"),
  };
}

function feature(
  forecast: ConditionalIntervalForecast,
  preprocessing: ConditionalIntervalPreprocessing,
): { readonly unclippedFeature: number; readonly feature: number } {
  if (
    preprocessing.constantScheduledGames !== null &&
    forecast.scheduledGames !== preprocessing.constantScheduledGames
  )
    throw new Error(
      "Conditional interval constant-games fit cannot extrapolate to different games",
    );
  const h = finite(forecast.meanPoints / forecast.scheduledGames, "mean per game");
  const volumeOffset = finite(
    preprocessing.volumeCoefficient *
      (1 / forecast.scheduledGames - preprocessing.inverseGamesMean),
    "volume offset",
  );
  // Check before clipping: clipping Infinity would conceal an unsupported computation.
  const unclippedFeature = finite(
    finite(finite(h - preprocessing.meanPerGame, "centered strength") - volumeOffset, "strength") /
      preprocessing.scale,
    "standardized feature",
  );
  return { unclippedFeature, feature: Math.max(-2, Math.min(2, unclippedFeature)) };
}

function prepareFit(input: ConditionalIntervalFitInput): ReadyFit | UnavailableFit {
  if (!Array.isArray(input.rows) || input.rows.length > CONDITIONAL_QUANTILE_NUMERICS.maximumRows)
    throw new RangeError("Conditional interval history exceeds the solver row bound");
  const canonical = input.rows.map(canonicalRow);
  // Reuse only the established scope, chronology, support and exact weighting contract.
  // Raw values were validated above. Neutral endpoints avoid running the unused v1 residual
  // arithmetic, whose overflow would bypass this candidate's explicit unavailable receipt.
  const support = fitMarginalIntervalCalibration({
    ...input,
    rows: canonical.map((row) => ({
      ...row,
      p15Points: 0,
      p50Points: 0,
      p85Points: 0,
      actualPoints: 0,
    })),
  });
  const byIdentity = new Map(canonical.map((row) => [row.identity, row]));
  const history = support.rows.map((row) => ({
    row: byIdentity.get(row.identity)!,
    weightDenominator: Number(row.weight.denominator),
  }));
  const base: FitBase = {
    artifactVersion: CONDITIONAL_INTERVAL_ARTIFACT_VERSION,
    version: CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
    solverVersion: CONDITIONAL_QUANTILE_SOLVER_VERSION,
    canAuthorizeRelease: false,
    seriesKey: input.seriesKey,
    forecastSeason: input.forecastSeason,
    priorSeasons: support.priorSeasons,
    samples: support.samples,
    blocks: support.blocks,
    distinctCutoffs: support.distinctCutoffs,
    history,
    inputChecksum: sha256Hex(
      JSON.stringify({
        version: CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
        seriesKey: input.seriesKey,
        forecastSeason: input.forecastSeason,
        priorSeasons: support.priorSeasons,
        history,
      }),
    ),
  };
  if (support.state !== "fitted")
    return { ...base, state: "unavailable", reasons: support.reasons };
  try {
    const weighted = (fn: (row: ConditionalIntervalHistoryRow) => number) =>
      sum(
        history.map(
          ({ row, weightDenominator }) => finite(fn(row), "weighted value") / weightDenominator,
        ),
      );
    const scale = weighted(
      (row) => finite(row.p85Points - row.p15Points, "raw width") / row.scheduledGames,
    );
    if (!(scale > 0)) return { ...base, state: "unavailable", reasons: ["zero-forecast-scale"] };
    const meanPerGame = weighted((row) => row.meanPoints / row.scheduledGames);
    const inverseGamesMean = weighted((row) => 1 / row.scheduledGames);
    const games = new Set(history.map(({ row }) => row.scheduledGames));
    const variance = weighted((row) => (1 / row.scheduledGames - inverseGamesMean) ** 2);
    if (games.size > 1 && !(variance > 0))
      return { ...base, state: "unavailable", reasons: ["unresolved-volume-variance"] };
    const volumeCoefficient =
      games.size === 1
        ? 0
        : finite(
            weighted(
              (row) =>
                finite(row.meanPoints / row.scheduledGames - meanPerGame, "centered mean") *
                (1 / row.scheduledGames - inverseGamesMean),
            ) / variance,
            "volume coefficient",
          );
    const preprocessing: ConditionalIntervalPreprocessing = {
      scale,
      meanPerGame,
      inverseGamesMean,
      volumeCoefficient,
      constantScheduledGames: games.size === 1 ? history[0]!.row.scheduledGames : null,
    };
    const rows = history.map(({ row, weightDenominator }) => ({
      identity: row.identity,
      weightDenominator,
      ...feature(row, preprocessing),
      residuals: ENDPOINTS.map((endpoint) =>
        finite(
          finite(row.actualPoints - row[endpoint], "raw residual") /
            finite(row.scheduledGames * scale, "residual scale"),
          "standardized residual",
        ),
      ) as unknown as MarginalIntervalTriple,
    }));
    return { ...base, preprocessing, rows };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { ...base, state: "unavailable", reasons: [error.message] };
  }
}
function solverInput(fit: ReadyFit, endpoint: 0 | 1 | 2): ConditionalQuantileInput {
  return {
    quantile: QUANTILES[endpoint],
    rows: fit.rows.map((row) => ({
      residual: row.residuals[endpoint],
      feature: row.feature,
      weight: 1 / row.weightDenominator,
      weightDenominator: row.weightDenominator,
    })),
  };
}
/** Array order is evidence; JSON object property order is not. */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 12) throw new Error("Conditional interval evidence nesting exceeds its bound");
  if (Array.isArray(value)) {
    if (
      value.length > CONDITIONAL_QUANTILE_NUMERICS.maximumRows ||
      Object.keys(value).length !== value.length
    )
      throw new Error("Conditional interval evidence array is invalid");
    return `[${value.map((item: unknown) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length > 24)
      throw new Error("Conditional interval evidence object exceeds its bound");
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`).join(",")}}`;
  }
  if (typeof value === "number") finite(value, "serialized number");
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 16_384)
    throw new Error("Conditional interval evidence field is invalid");
  return encoded;
}
function seal(payload: FitPayload): ConditionalIntervalCalibrationFit {
  return { ...payload, checksum: sha256Hex(canonicalJson(payload)) };
}

/** Fits only completed prior seasons; no caller option changes feature, penalty or tolerances. */
export function fitConditionalIntervalCalibration(
  input: ConditionalIntervalFitInput,
): ConditionalIntervalCalibrationFit {
  const prepared = prepareFit(input);
  if ("state" in prepared) return seal(prepared);
  const solutions = ([0, 1, 2] as const).map((endpoint) =>
    solveConditionalQuantile(solverInput(prepared, endpoint)),
  );
  const failures = solutions.flatMap((solution, i) =>
    solution.status === "unavailable" ? [`quantile-${QUANTILES[i]}:${solution.reason}`] : [],
  );
  if (failures.length > 0) {
    // Retain the computed features even when the numerical solver cannot certify a fit.
    return seal({ ...prepared, state: "unavailable", reasons: failures });
  }
  return seal({
    ...prepared,
    state: "fitted",
    solutions: solutions as [CertifiedSolution, CertifiedSolution, CertifiedSolution],
  });
}

export interface ConditionalIntervalCorrection {
  readonly method: typeof CONDITIONAL_INTERVAL_CALIBRATION_VERSION;
  readonly meanPoints: number;
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
  readonly feature: number;
  readonly unclippedFeature: number;
  readonly featureClipped: boolean;
  readonly rearrangement: {
    readonly crossed: boolean;
    readonly unsorted: MarginalIntervalTriple;
    readonly permutation: readonly [number, number, number];
    readonly maximumMovement: number;
  };
}

/**
 * Independently reconstruct preprocessing and all three optimality certificates once per fit.
 * The checksum detects corruption, not provenance: an external report must authenticate history.
 * The returned closure owns a detached snapshot and never re-fits while applying player rows.
 */
export function prepareConditionalIntervalCalibration(
  fit: ConditionalIntervalCalibrationFit,
): (forecast: ConditionalIntervalForecast) => ConditionalIntervalCorrection {
  if (fit.state !== "fitted") throw new Error("Conditional interval fit is unavailable");
  if (!Array.isArray(fit.history) || fit.history.length > CONDITIONAL_QUANTILE_NUMERICS.maximumRows)
    throw new Error("Conditional interval fit history is invalid");
  const history: readonly WeightedRow[] = fit.history;
  const submitted = Object.fromEntries(Object.entries(fit).filter(([key]) => key !== "checksum"));
  if (sha256Hex(canonicalJson(submitted)) !== fit.checksum)
    throw new Error("Conditional interval submitted evidence checksum mismatch");
  const prepared = prepareFit({
    seriesKey: fit.seriesKey,
    forecastSeason: fit.forecastSeason,
    completedSeasons: fit.priorSeasons,
    rows: history.map(({ row }) => row),
  });
  if ("state" in prepared || !Array.isArray(fit.solutions) || fit.solutions.length !== 3)
    throw new Error("Conditional interval fit evidence is invalid");
  const solutions = ([0, 1, 2] as const).map((endpoint): CertifiedSolution => {
    const solution = fit.solutions[endpoint];
    const certificate = certifyConditionalQuantile(solverInput(prepared, endpoint), solution);
    if (
      !certificate.certified ||
      !Number.isSafeInteger(solution.iterations) ||
      solution.iterations < 1 ||
      solution.iterations > CONDITIONAL_QUANTILE_NUMERICS.maximumIterations
    )
      throw new Error("Conditional interval solution is uncertified");
    return {
      status: "certified",
      quantile: QUANTILES[endpoint],
      intercept: solution.intercept,
      slope: solution.slope,
      dualWeights: [...solution.dualWeights],
      iterations: solution.iterations,
      certificate,
    };
  }) as [CertifiedSolution, CertifiedSolution, CertifiedSolution];
  const canonical = seal({ ...prepared, state: "fitted", solutions });
  if (canonical.checksum !== fit.checksum)
    throw new Error("Conditional interval fit checksum or evidence mismatch");
  return (forecast) => {
    // Empty-history validation checks the raw forecast contract without fitting any corrections.
    fitMarginalIntervalCalibration({
      seriesKey: prepared.seriesKey,
      forecastSeason: prepared.forecastSeason,
      completedSeasons: [],
      rows: [{ ...forecast, identity: "application", playerId: "application", actualPoints: 0 }],
    });
    finite(forecast.meanPoints, "application mean");
    if (forecast.forecastSeason !== prepared.forecastSeason)
      throw new Error("Conditional interval application season mismatch");
    const values = feature(forecast, prepared.preprocessing);
    const multiplier = finite(
      forecast.scheduledGames * prepared.preprocessing.scale,
      "application scale",
    );
    const unsorted = ENDPOINTS.map((endpoint, i) =>
      finite(
        forecast[endpoint] +
          finite(
            multiplier *
              finite(
                solutions[i]!.intercept + solutions[i]!.slope * values.feature,
                "conditional correction",
              ),
            "scaled correction",
          ),
        "corrected endpoint",
      ),
    ) as unknown as MarginalIntervalTriple;
    const permutation = ([0, 1, 2] as [number, number, number]).sort((a, b) =>
      unsorted[a]! < unsorted[b]! ? -1 : unsorted[a]! > unsorted[b]! ? 1 : a - b,
    );
    const sorted = permutation.map((index) => unsorted[index]!);
    return {
      method: CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
      meanPoints: forecast.meanPoints,
      p15Points: sorted[0]!,
      p50Points: sorted[1]!,
      p85Points: sorted[2]!,
      ...values,
      featureClipped: values.feature !== values.unclippedFeature,
      rearrangement: {
        crossed: unsorted[0] > unsorted[1] || unsorted[1] > unsorted[2],
        unsorted,
        permutation,
        maximumMovement: finite(
          Math.max(...sorted.map((value, i) => Math.abs(value - unsorted[i]!))),
          "rearrangement movement",
        ),
      },
    };
  };
}
