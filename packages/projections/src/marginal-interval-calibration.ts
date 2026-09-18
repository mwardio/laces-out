/** Isolated candidate mathematics. A fitted correction is not evidence of release eligibility. */
export const MARGINAL_INTERVAL_CALIBRATION_VERSION = "season-prior-weighted-quantile-residuals-v1";
export const MARGINAL_INTERVAL_CALIBRATION_MAX_ROWS = 20_000;
const ENDPOINTS = ["p15Points", "p50Points", "p85Points"] as const;
type Endpoint = (typeof ENDPOINTS)[number];
export type MarginalIntervalQuantiles = Readonly<Record<Endpoint, number>>;
export type MarginalIntervalTriple = readonly [number, number, number];

export interface MarginalIntervalForecast extends MarginalIntervalQuantiles {
  /** Caller-owned exact model/profile/position/horizon/strategy identity, never a display name. */
  readonly seriesKey: string;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scheduledGames: number;
}

export interface MarginalIntervalHistoryRow extends MarginalIntervalForecast {
  readonly identity: string;
  readonly playerId: string;
  readonly actualPoints: number;
}

export interface MarginalIntervalWeightedEvidence {
  readonly identity: string;
  readonly playerId: string;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scheduledGames: number;
  /** Exact normalized row weight. Strings keep this evidence portable through JSON. */
  readonly weight: { readonly numerator: "1"; readonly denominator: string };
  readonly residuals: MarginalIntervalTriple;
}

interface MarginalIntervalFitEvidence {
  readonly version: typeof MARGINAL_INTERVAL_CALIBRATION_VERSION;
  readonly target: "individual-player-marginal-quantiles";
  readonly nominalCoverage: 0.7;
  readonly quantiles: readonly [0.15, 0.5, 0.85];
  readonly weighting: "equal-season-equal-cutoff-equal-player";
  readonly scale: "scheduled-games";
  readonly seriesKey: string;
  /** One locked fit is applicable only to this season, never to its own training seasons. */
  readonly forecastSeason: number;
  readonly priorSeasons: readonly number[];
  readonly samples: number;
  readonly blocks: number;
  readonly distinctCutoffs: number;
  readonly rows: readonly MarginalIntervalWeightedEvidence[];
}

export type MarginalIntervalCalibrationFit = MarginalIntervalFitEvidence &
  (
    | { readonly state: "fitted"; readonly corrections: MarginalIntervalTriple }
    | {
        readonly state: "insufficient-evidence";
        readonly corrections: null;
        readonly reasons: readonly (
          | "prior-season-unavailable"
          | "fewer-than-18-rows"
          | "fewer-than-3-cutoffs"
          | "fewer-than-3-blocks"
        )[];
      }
  );

function integer(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Marginal interval ${label} must be an integer in ${minimum}..${maximum}`);
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Marginal interval ${label} must be finite`);
  // JSON has one representation of zero; keep executable numeric evidence stable across it.
  return value === 0 ? 0 : value;
}

function boundedArray(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new RangeError(`Marginal interval ${label} is missing or outside its array bound`);
}

function text(value: string, maximum: number, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum)
    throw new TypeError(`Marginal interval ${label} must be a bounded nonempty string`);
}

function validateForecast(row: MarginalIntervalForecast): void {
  text(row.seriesKey, 8_192, "series identity");
  integer(row.forecastSeason, 2000, 2200, "forecast season");
  integer(row.asOfWeek, 0, 17, "cutoff");
  integer(row.windowStartWeek, row.asOfWeek + 1, 18, "window start");
  integer(row.windowEndWeek, row.windowStartWeek, 18, "window end");
  integer(
    row.scheduledGames,
    1,
    Math.min(17, row.windowEndWeek - row.windowStartWeek + 1),
    "scheduled games",
  );
  for (const endpoint of ENDPOINTS) finite(row[endpoint], endpoint);
  if (row.p15Points > row.p50Points || row.p50Points > row.p85Points)
    throw new RangeError("Marginal interval raw quantiles must be ordered");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRows(left: MarginalIntervalHistoryRow, right: MarginalIntervalHistoryRow): number {
  return (
    left.forecastSeason - right.forecastSeason ||
    left.asOfWeek - right.asOfWeek ||
    compareText(left.playerId, right.playerId) ||
    compareText(left.identity, right.identity)
  );
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function residualQuantile(
  rows: readonly MarginalIntervalWeightedEvidence[],
  endpoint: 0 | 1 | 2,
  targetNumerator: bigint,
): number {
  // Integer cumulative masses avoid 0.15/0.50/0.85 floating-point boundary ambiguity.
  const denominators = rows.map((row) => BigInt(row.weight.denominator));
  const common = denominators.reduce((a, b) => (a / gcd(a, b)) * b, 1n);
  const atoms = rows
    .map((row, index) => ({
      value: row.residuals[endpoint],
      weight: common / denominators[index]!,
      order: index,
    }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.order - b.order));
  if (atoms.reduce((sum, atom) => sum + atom.weight, 0n) !== common)
    throw new Error("Marginal interval row weights must sum exactly to one");
  let cumulative = 0n;
  for (const atom of atoms) {
    cumulative += atom.weight;
    if (cumulative * 100n >= targetNumerator * common) return atom.value;
  }
  throw new Error("Marginal interval quantile has no supporting observation");
}

/**
 * Fits the frozen candidate independently of champion selection or release qualification.
 * Supplied rows are validated, including unused future rows; only completed earlier seasons
 * contribute corrections or evidence. A missing completion assertion fails instead of silently
 * dropping a partial prior season. Callers must authenticate the series and resulting evidence.
 */
export function fitMarginalIntervalCalibration(input: {
  readonly seriesKey: string;
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly rows: readonly MarginalIntervalHistoryRow[];
}): MarginalIntervalCalibrationFit {
  text(input.seriesKey, 8_192, "series identity");
  integer(input.forecastSeason, 2000, 2200, "forecast season");
  boundedArray(input.rows, 0, MARGINAL_INTERVAL_CALIBRATION_MAX_ROWS, "history row bound");
  boundedArray(input.completedSeasons, 0, 201, "completed seasons");
  const completed = new Set<number>();
  for (const season of input.completedSeasons) {
    integer(season, 2000, 2200, "completed season");
    if (completed.has(season)) throw new Error("Duplicate marginal interval completed season");
    completed.add(season);
  }
  const identities = new Set<string>();
  const forecasts = new Set<string>();
  const prior: MarginalIntervalHistoryRow[] = [];
  for (const row of input.rows) {
    validateForecast(row);
    text(row.identity, 512, "row identity");
    text(row.playerId, 256, "player identity");
    finite(row.actualPoints, "actual points");
    if (row.seriesKey !== input.seriesKey)
      throw new Error("Marginal interval series identity mismatch");
    const forecastKey = JSON.stringify([row.forecastSeason, row.asOfWeek, row.playerId]);
    if (identities.has(row.identity) || forecasts.has(forecastKey))
      throw new Error("Duplicate marginal interval forecast");
    identities.add(row.identity);
    forecasts.add(forecastKey);
    if (row.forecastSeason >= input.forecastSeason) continue;
    if (!completed.has(row.forecastSeason))
      throw new Error("Marginal interval prior season is not complete");
    prior.push(row);
  }
  prior.sort(compareRows);
  const seasons = new Map<number, Map<number, number>>();
  for (const row of prior) {
    const cutoffs = seasons.get(row.forecastSeason) ?? new Map<number, number>();
    cutoffs.set(row.asOfWeek, (cutoffs.get(row.asOfWeek) ?? 0) + 1);
    seasons.set(row.forecastSeason, cutoffs);
  }
  const rows = prior.map((row): MarginalIntervalWeightedEvidence => {
    const cutoffs = seasons.get(row.forecastSeason)!;
    return {
      identity: row.identity,
      playerId: row.playerId,
      forecastSeason: row.forecastSeason,
      asOfWeek: row.asOfWeek,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      scheduledGames: row.scheduledGames,
      weight: {
        numerator: "1",
        denominator: String(seasons.size * cutoffs.size * cutoffs.get(row.asOfWeek)!),
      },
      residuals: ENDPOINTS.map((endpoint) =>
        finite((row.actualPoints - row[endpoint]) / row.scheduledGames, "signed residual"),
      ) as unknown as MarginalIntervalTriple,
    };
  });
  const common = {
    version: MARGINAL_INTERVAL_CALIBRATION_VERSION,
    target: "individual-player-marginal-quantiles",
    nominalCoverage: 0.7,
    quantiles: [0.15, 0.5, 0.85],
    weighting: "equal-season-equal-cutoff-equal-player",
    scale: "scheduled-games",
    seriesKey: input.seriesKey,
    forecastSeason: input.forecastSeason,
    priorSeasons: [...seasons.keys()],
    samples: rows.length,
    blocks: [...seasons.values()].reduce((sum, cutoffs) => sum + cutoffs.size, 0),
    distinctCutoffs: new Set(prior.map((row) => row.asOfWeek)).size,
    rows,
  } as const;
  const reasons: Extract<
    MarginalIntervalCalibrationFit,
    { state: "insufficient-evidence" }
  >["reasons"][number][] = [];
  if (seasons.size < 1) reasons.push("prior-season-unavailable");
  if (rows.length < 18) reasons.push("fewer-than-18-rows");
  if (common.distinctCutoffs < 3) reasons.push("fewer-than-3-cutoffs");
  if (common.blocks < 3) reasons.push("fewer-than-3-blocks");
  if (reasons.length > 0)
    return { ...common, state: "insufficient-evidence", corrections: null, reasons };
  return {
    ...common,
    state: "fitted",
    corrections: [
      residualQuantile(rows, 0, 15n),
      residualQuantile(rows, 1, 50n),
      residualQuantile(rows, 2, 85n),
    ],
  };
}

export interface MarginalIntervalCorrection extends MarginalIntervalQuantiles {
  readonly method: typeof MARGINAL_INTERVAL_CALIBRATION_VERSION;
  readonly rearrangement: {
    readonly crossed: boolean;
    readonly unsorted: MarginalIntervalTriple;
    /** Source endpoint index for each ascending output: 0=P15, 1=P50, 2=P85. */
    readonly permutation: readonly [number, number, number];
    readonly maximumMovement: number;
  };
}

/**
 * Apply an authenticated fitted candidate, not an admission artifact. This validates the
 * executable fields, not the authenticity of serialized historical evidence; the integrating
 * policy must bind/check that evidence separately and qualify its held-out performance.
 */
export function applyMarginalIntervalCalibration(
  forecast: MarginalIntervalForecast,
  fit: MarginalIntervalCalibrationFit,
): MarginalIntervalCorrection {
  validateForecast(forecast);
  if (fit.state !== "fitted") throw new Error("Marginal interval correction is not fitted");
  if (
    fit.version !== MARGINAL_INTERVAL_CALIBRATION_VERSION ||
    fit.target !== "individual-player-marginal-quantiles" ||
    fit.nominalCoverage !== 0.7 ||
    fit.weighting !== "equal-season-equal-cutoff-equal-player" ||
    fit.scale !== "scheduled-games" ||
    !Array.isArray(fit.quantiles) ||
    fit.quantiles.length !== 3 ||
    [0.15, 0.5, 0.85].some((expected, i) => fit.quantiles[i] !== expected)
  )
    throw new Error("Marginal interval fit method is invalid");
  if (fit.seriesKey !== forecast.seriesKey || fit.forecastSeason !== forecast.forecastSeason)
    throw new Error("Marginal interval fit scope or forecast season mismatch");
  boundedArray(fit.priorSeasons, 1, 201, "fit prior seasons");
  let previous = 1999;
  for (const season of fit.priorSeasons) {
    integer(season, previous + 1, fit.forecastSeason - 1, "strictly prior season");
    previous = season;
  }
  integer(fit.samples, 18, MARGINAL_INTERVAL_CALIBRATION_MAX_ROWS, "fit samples");
  integer(fit.blocks, 3, Math.min(fit.samples, fit.priorSeasons.length * 18), "fit blocks");
  integer(fit.distinctCutoffs, 3, Math.min(18, fit.blocks), "fit cutoffs");
  if (!Array.isArray(fit.corrections) || fit.corrections.length !== 3)
    throw new Error("Marginal interval correction triple is missing");
  const unsorted = ENDPOINTS.map((endpoint, i) =>
    finite(
      forecast[endpoint] + forecast.scheduledGames * finite(fit.corrections[i]!, "correction"),
      "corrected quantile",
    ),
  ) as unknown as MarginalIntervalTriple;
  const permutation = [0, 1, 2].sort((a, b) =>
    unsorted[a]! < unsorted[b]! ? -1 : unsorted[a]! > unsorted[b]! ? 1 : a - b,
  ) as [number, number, number];
  const sorted = permutation.map((index) => unsorted[index]!) as unknown as MarginalIntervalTriple;
  return {
    p15Points: sorted[0],
    p50Points: sorted[1],
    p85Points: sorted[2],
    method: MARGINAL_INTERVAL_CALIBRATION_VERSION,
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
}
