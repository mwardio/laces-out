import type {
  MarginalIntervalForecast,
  MarginalIntervalHistoryRow,
  MarginalIntervalTriple,
} from "./marginal-interval-calibration.js";
import {
  groupLocalResiduals,
  localEffectiveSupport,
  localMidpointResidualQuantile,
  localWeightMasses,
} from "./local-weighted-quantile.js";
import { sha256Hex } from "./sha256.js";

/** Inactive development estimator. Its computation never authorizes publication. */
export const LOCAL_ROS_INTERVAL_VERSION =
  "prior-local-reference-rank-exposure-strength-residual-quantiles-v2";
export const LOCAL_ROS_INTERVAL_ARTIFACT_VERSION = "ros-local-residual-development-v2";
const MAX_ROWS = 20_000;
const ENDPOINTS = ["p15Points", "p50Points", "p85Points"] as const;
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
export type LocalRosPosition = (typeof POSITIONS)[number];

export interface LocalRosIntervalForecast extends MarginalIntervalForecast {
  readonly meanPoints: number;
  /** Full32 fixed-reference production rank, never a fantasy roster or league-points rank. */
  readonly referenceProductionRank: number | null;
}
export interface LocalRosIntervalHistoryRow
  extends MarginalIntervalHistoryRow, LocalRosIntervalForecast {}
export interface LocalRosIntervalFitInput {
  /** Exact model/profile/position/strategy scope. Horizons are deliberately pooled. */
  readonly seriesKey: string;
  readonly position: LocalRosPosition;
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly rows: readonly LocalRosIntervalHistoryRow[];
}
interface WeightedHistory {
  readonly row: LocalRosIntervalHistoryRow;
  readonly weightDenominator: number;
}
interface FeatureSummary {
  readonly name: "meanPerScheduledGame" | "logScheduledGames" | "referenceProductionRankFraction";
  readonly center: number;
  readonly scale: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly constant: boolean;
}
interface FitBase {
  readonly version: typeof LOCAL_ROS_INTERVAL_VERSION;
  readonly artifactVersion: typeof LOCAL_ROS_INTERVAL_ARTIFACT_VERSION;
  readonly canAuthorizeRelease: false;
  readonly seriesKey: string;
  readonly position: LocalRosPosition;
  readonly forecastSeason: number;
  readonly priorSeasons: readonly number[];
  readonly samples: number;
  readonly distinctCutoffs: number;
  readonly blocks: number;
  readonly history: readonly WeightedHistory[];
  readonly inputChecksum: string;
}
type FitPayload = FitBase &
  (
    | { readonly state: "unavailable"; readonly reasons: readonly string[] }
    | { readonly state: "fitted"; readonly features: readonly FeatureSummary[] }
  );
export type LocalRosIntervalCalibrationFit = FitPayload & { readonly checksum: string };

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Local ROS ${label} is nonfinite`);
  return value === 0 ? 0 : value;
}
function integer(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Local ROS ${label} is outside ${minimum}..${maximum}`);
}
function text(value: string, limit: number, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new TypeError(`Local ROS ${label} is invalid`);
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length)
    throw new RangeError("Local ROS array is invalid or exceeds its bound");
}
function sum(values: readonly number[]): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    finite(value, "sum term");
    const next = finite(total + value, "sum");
    compensation = finite(
      compensation +
        (Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total),
      "sum compensation",
    );
    total = next;
  }
  return finite(total + compensation, "compensated sum");
}
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 10) throw new RangeError("Local ROS evidence nesting exceeds its bound");
  if (Array.isArray(value)) {
    array(value, MAX_ROWS);
    return `[${value.map((item: unknown) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length > 32) throw new RangeError("Local ROS evidence object exceeds its bound");
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`).join(",")}}`;
  }
  if (typeof value === "number") finite(value, "evidence number");
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 16_384)
    throw new TypeError("Local ROS evidence field is invalid");
  return encoded;
}
function forecast(
  row: LocalRosIntervalForecast,
  position: LocalRosPosition,
): LocalRosIntervalForecast {
  text(row.seriesKey, 8192, "series identity");
  integer(row.forecastSeason, 2000, 2200, "season");
  integer(row.asOfWeek, 0, 17, "cutoff");
  integer(row.windowStartWeek, row.asOfWeek + 1, 18, "window start");
  integer(row.windowEndWeek, row.windowStartWeek, 18, "window end");
  integer(
    row.scheduledGames,
    1,
    Math.min(17, row.windowEndWeek - row.windowStartWeek + 1),
    "scheduled games",
  );
  if (position === "DST")
    integer(row.referenceProductionRank!, 1, 32, "full-universe defense rank");
  else if (row.referenceProductionRank !== null)
    throw new Error("Local ROS non-defense rank must be absent");
  const endpoints = ENDPOINTS.map((key) => finite(row[key], key));
  if (endpoints[0]! > endpoints[1]! || endpoints[1]! > endpoints[2]!)
    throw new RangeError("Local ROS raw endpoints must be ordered");
  return {
    seriesKey: row.seriesKey,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.scheduledGames,
    meanPoints: finite(row.meanPoints, "mean"),
    p15Points: endpoints[0]!,
    p50Points: endpoints[1]!,
    p85Points: endpoints[2]!,
    referenceProductionRank: row.referenceProductionRank,
  };
}
function featureValues(row: LocalRosIntervalForecast): readonly number[] {
  return [
    finite(row.meanPoints / row.scheduledGames, "mean per game"),
    finite(Math.log(row.scheduledGames), "log games"),
    ...(row.referenceProductionRank === null ? [] : [(row.referenceProductionRank - 1) / 31]),
  ];
}
function build(input: LocalRosIntervalFitInput): FitPayload {
  text(input.seriesKey, 8192, "series identity");
  integer(input.forecastSeason, 2000, 2200, "fit season");
  if (!POSITIONS.includes(input.position)) throw new TypeError("Local ROS position is invalid");
  array(input.rows, MAX_ROWS);
  array(input.completedSeasons, 201);
  const completed = new Set<number>();
  for (const year of input.completedSeasons) {
    integer(year, 2000, 2200, "completed season");
    if (completed.has(year)) throw new Error("Duplicate local ROS completed season");
    completed.add(year);
  }
  const identities = new Set<string>();
  const forecasts = new Set<string>();
  const prior: LocalRosIntervalHistoryRow[] = [];
  for (const row of input.rows) {
    const validated = forecast(row, input.position);
    text(row.identity, 512, "history identity");
    text(row.playerId, 256, "player identity");
    if (row.seriesKey !== input.seriesKey) throw new Error("Local ROS series identity mismatch");
    const key = JSON.stringify([row.forecastSeason, row.asOfWeek, row.playerId]);
    if (identities.has(row.identity) || forecasts.has(key))
      throw new Error("Duplicate local ROS forecast");
    identities.add(row.identity);
    forecasts.add(key);
    if (row.forecastSeason >= input.forecastSeason) continue;
    if (!completed.has(row.forecastSeason)) throw new Error("Local ROS prior season is incomplete");
    prior.push({
      ...validated,
      identity: row.identity,
      playerId: row.playerId,
      actualPoints: finite(row.actualPoints, "actual"),
    });
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  prior.sort(
    (a, b) =>
      a.forecastSeason - b.forecastSeason ||
      a.asOfWeek - b.asOfWeek ||
      compare(a.playerId, b.playerId) ||
      compare(a.identity, b.identity),
  );
  const seasons = new Map<number, Map<number, number>>();
  for (const row of prior) {
    const cutoffs = seasons.get(row.forecastSeason) ?? new Map<number, number>();
    cutoffs.set(row.asOfWeek, (cutoffs.get(row.asOfWeek) ?? 0) + 1);
    seasons.set(row.forecastSeason, cutoffs);
  }
  const history = prior.map((row): WeightedHistory => ({
    row,
    weightDenominator:
      seasons.size *
      seasons.get(row.forecastSeason)!.size *
      seasons.get(row.forecastSeason)!.get(row.asOfWeek)!,
  }));
  const base: FitBase = {
    version: LOCAL_ROS_INTERVAL_VERSION,
    artifactVersion: LOCAL_ROS_INTERVAL_ARTIFACT_VERSION,
    canAuthorizeRelease: false,
    seriesKey: input.seriesKey,
    position: input.position,
    forecastSeason: input.forecastSeason,
    priorSeasons: [...seasons.keys()],
    samples: history.length,
    blocks: [...seasons.values()].reduce((n, cutoffs) => n + cutoffs.size, 0),
    distinctCutoffs: new Set(prior.map((row) => row.asOfWeek)).size,
    history,
    inputChecksum: sha256Hex(
      canonicalJson({
        version: LOCAL_ROS_INTERVAL_VERSION,
        seriesKey: input.seriesKey,
        position: input.position,
        forecastSeason: input.forecastSeason,
        history,
      }),
    ),
  };
  const reasons = [
    ...(base.priorSeasons.length < 1 ? ["prior-season-unavailable"] : []),
    ...(base.samples < 18 ? ["fewer-than-18-rows"] : []),
    ...(base.distinctCutoffs < 3 ? ["fewer-than-3-cutoffs"] : []),
    ...(base.blocks < 3 ? ["fewer-than-3-blocks"] : []),
  ];
  if (reasons.length) return { ...base, state: "unavailable", reasons };
  try {
    const values = prior.map(featureValues);
    const weights = history.map((row) => 1 / row.weightDenominator);
    const total = sum(weights);
    const names = [
      "meanPerScheduledGame",
      "logScheduledGames",
      ...(input.position === "DST" ? ["referenceProductionRankFraction"] : []),
    ] as FeatureSummary["name"][];
    const features = names.map((name, index): FeatureSummary => {
      const column = values.map((row) => row[index]!);
      const minimum = Math.min(...column),
        maximum = Math.max(...column);
      const constant = minimum === maximum;
      const center =
        sum(column.map((value, i) => finite(weights[i]! * value, "weighted feature"))) / total;
      const scale = constant
        ? 0
        : Math.sqrt(
            sum(
              column.map((value, i) =>
                finite(weights[i]! * (value - center) ** 2, "feature variance"),
              ),
            ) / total,
          );
      if (!constant && !(finite(scale, "feature SD") > 0))
        throw new RangeError("Local ROS nonconstant feature has unresolved scale");
      return { name, center: finite(center, "feature center"), scale, minimum, maximum, constant };
    });
    // Validate every prior residual before publishing fit evidence; no rows may be omitted.
    for (const row of prior)
      for (const endpoint of ENDPOINTS)
        finite((row.actualPoints - row[endpoint]) / row.scheduledGames, "per-game residual");
    return { ...base, state: "fitted", features };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { ...base, state: "unavailable", reasons: [error.message] };
  }
}
function seal(payload: FitPayload): LocalRosIntervalCalibrationFit {
  return { ...payload, checksum: sha256Hex(canonicalJson(payload)) };
}

export function fitLocalRosIntervalCalibration(
  input: LocalRosIntervalFitInput,
): LocalRosIntervalCalibrationFit {
  return seal(build(input));
}

export interface LocalRosIntervalCorrection {
  readonly method: typeof LOCAL_ROS_INTERVAL_VERSION;
  readonly meanPoints: number;
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
  readonly residualQuantiles: MarginalIntervalTriple;
  readonly support: {
    readonly effectiveRows: number;
    readonly effectiveCutoffs: number;
    readonly effectiveBlocks: number;
    readonly effectiveSeasons: number;
    readonly minimumStandardizedDistance: number;
    readonly extrapolated: boolean;
    readonly features: readonly (FeatureSummary & {
      readonly query: number;
      readonly distanceOutsideRange: number;
    })[];
  };
  readonly rearrangement: {
    readonly crossed: boolean;
    readonly unsorted: MarginalIntervalTriple;
    readonly permutation: readonly [number, number, number];
    readonly maximumMovement: number;
  };
}
export type LocalRosIntervalApplication =
  | { readonly state: "corrected"; readonly correction: LocalRosIntervalCorrection }
  | {
      readonly state: "unavailable";
      readonly reasons: readonly string[];
      readonly support: LocalRosIntervalCorrection["support"] | null;
    };

/** Reconstruct once, then retain a detached prepared history and pre-sorted residual groups. */
export function prepareLocalRosIntervalCalibration(
  fit: LocalRosIntervalCalibrationFit,
): (query: LocalRosIntervalForecast) => LocalRosIntervalApplication {
  if (fit.state !== "fitted") throw new Error("Local ROS fit is unavailable");
  array(fit.history, MAX_ROWS);
  const submitted = Object.fromEntries(Object.entries(fit).filter(([key]) => key !== "checksum"));
  if (sha256Hex(canonicalJson(submitted)) !== fit.checksum)
    throw new Error("Local ROS fit checksum mismatch");
  const restored = build({
    seriesKey: fit.seriesKey,
    position: fit.position,
    forecastSeason: fit.forecastSeason,
    completedSeasons: fit.priorSeasons,
    rows: fit.history.map((item) => item.row),
  });
  if (restored.state !== "fitted" || seal(restored).checksum !== fit.checksum)
    throw new Error("Local ROS fit reconstruction mismatch");
  const history = restored.history;
  const values = history.map(({ row }) => featureValues(row));
  const groups = ENDPOINTS.map((endpoint) =>
    groupLocalResiduals(
      history.map(({ row }) => (row.actualPoints - row[endpoint]) / row.scheduledGames),
    ),
  );
  const aggregate = (
    masses: readonly bigint[],
    key: (row: LocalRosIntervalHistoryRow) => string,
  ) => {
    const grouped = new Map<string, bigint>();
    for (let i = 0; i < history.length; i += 1) {
      const name = key(history[i]!.row);
      grouped.set(name, (grouped.get(name) ?? 0n) + masses[i]!);
    }
    return [...grouped.values()];
  };
  return (query) => {
    const row = forecast(query, restored.position);
    if (row.seriesKey !== restored.seriesKey || row.forecastSeason !== restored.forecastSeason)
      throw new Error("Local ROS query scope mismatch");
    let support: LocalRosIntervalCorrection["support"] | null = null;
    try {
      const x = featureValues(row);
      const features = restored.features.map((feature, index) => {
        const value = x[index]!;
        if (feature.constant && value !== feature.minimum)
          throw new RangeError(`Local ROS constant feature mismatch: ${feature.name}`);
        return {
          ...feature,
          query: value,
          distanceOutsideRange: feature.constant
            ? 0
            : finite(
                Math.max(feature.minimum - value, value - feature.maximum, 0) / feature.scale,
                "extrapolation distance",
              ),
        };
      });
      let minimumDistanceSquared = Infinity;
      const weights = history.map((entry, index) => {
        let kernel = 1,
          squared = 0;
        for (let j = 0; j < features.length; j += 1) {
          if (features[j]!.constant) continue;
          const distance = finite(
            (values[index]![j]! - x[j]!) / features[j]!.scale,
            "standardized distance",
          );
          const square = finite(distance * distance, "squared distance");
          squared = finite(squared + square, "joint distance");
          kernel = finite(kernel * (1 / finite(1 + square, "kernel denominator")), "kernel");
        }
        minimumDistanceSquared = Math.min(minimumDistanceSquared, squared);
        const weight = finite((1 / entry.weightDenominator) * kernel, "local weight");
        if (!(weight > 0)) throw new RangeError("Local ROS weight underflow");
        return weight;
      });
      const masses = localWeightMasses(weights);
      const rows = localEffectiveSupport(masses, 18);
      const cutoffs = localEffectiveSupport(
        aggregate(masses, (r) => String(r.asOfWeek)),
        3,
      );
      const blocks = localEffectiveSupport(
        aggregate(masses, (r) => `${r.forecastSeason}/${r.asOfWeek}`),
        3,
      );
      const seasons = localEffectiveSupport(
        aggregate(masses, (r) => String(r.forecastSeason)),
        1,
      );
      support = {
        effectiveRows: rows.effective,
        effectiveCutoffs: cutoffs.effective,
        effectiveBlocks: blocks.effective,
        effectiveSeasons: seasons.effective,
        minimumStandardizedDistance: finite(
          Math.sqrt(minimumDistanceSquared),
          "nearest prior distance",
        ),
        extrapolated: features.some((f) => f.query < f.minimum || f.query > f.maximum),
        features,
      };
      const reasons = [
        ...(!rows.sufficient ? ["fewer-than-18-effective-rows"] : []),
        ...(!cutoffs.sufficient ? ["fewer-than-3-effective-cutoffs"] : []),
        ...(!blocks.sufficient ? ["fewer-than-3-effective-blocks"] : []),
      ];
      if (reasons.length) return { state: "unavailable", reasons, support };
      const residuals = groups.map((group, i) =>
        localMidpointResidualQuantile(group, masses, ([3, 10, 17] as const)[i]!),
      ) as unknown as MarginalIntervalTriple;
      const unsorted = ENDPOINTS.map((endpoint, i) =>
        finite(
          row[endpoint] + finite(row.scheduledGames * residuals[i]!, "scaled correction"),
          "corrected endpoint",
        ),
      ) as unknown as MarginalIntervalTriple;
      const order = ([0, 1, 2] as const)
        .slice()
        .sort((a, b) => (unsorted[a] < unsorted[b] ? -1 : unsorted[a] > unsorted[b] ? 1 : a - b));
      const corrected = order.map((i) => unsorted[i]) as unknown as MarginalIntervalTriple;
      const movement = Math.max(
        ...corrected.map((value, i) =>
          finite(Math.abs(value - unsorted[i]!), "rearrangement movement"),
        ),
      );
      return {
        state: "corrected",
        correction: {
          method: LOCAL_ROS_INTERVAL_VERSION,
          meanPoints: row.meanPoints,
          p15Points: corrected[0],
          p50Points: corrected[1],
          p85Points: corrected[2],
          residualQuantiles: residuals,
          support,
          rearrangement: {
            crossed: order.some((i, j) => i !== j),
            unsorted,
            permutation: order as [number, number, number],
            maximumMovement: movement,
          },
        },
      };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { state: "unavailable", reasons: [error.message], support };
    }
  };
}
