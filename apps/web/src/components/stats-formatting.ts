import type {
  StatsCenterAdditiveMetric,
  StatsCenterBoomBust,
  StatsCenterRatioMetric,
  StatsCenterTrend,
  StatsCenterTrendMetric,
} from "@fantasy/contracts";

/**
 * Formatters and empty-metric builders shared by the Stats Center leaderboard and the player
 * profile. Both surfaces render the same contract, so a dash means the same thing in each.
 */

export function dateTime(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function dateOnly(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function timeOnly(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

export function number(value: number | null, digits = 0): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
}

export function rate(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Trend deltas read as movement, so the sign is always shown. */
export function signed(value: number | null, digits = 1): string {
  if (value === null) return "—";
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
    signDisplay: "exceptZero",
  }).format(value);
  return formatted;
}

/** "1–5" for a contiguous run, "1–3, 5" when weeks are missing. */
export function weekCoverage(weeks: readonly number[]): string {
  const sorted = [...weeks].sort((left, right) => left - right);
  const first = sorted[0];
  if (first === undefined) return "None";
  const runs: string[] = [];
  let start = first;
  let previous = first;
  for (const week of sorted.slice(1)) {
    if (week === previous + 1) {
      previous = week;
      continue;
    }
    runs.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = week;
    previous = week;
  }
  runs.push(start === previous ? `${start}` : `${start}–${previous}`);
  return runs.join(", ");
}

const ADDITIVE_METRIC_IDS: readonly StatsCenterAdditiveMetric[] = [
  "passCompletions",
  "passAttempts",
  "passYards",
  "passTouchdowns",
  "passInterceptions",
  "rushYards",
  "rushTouchdowns",
  "receptions",
  "recYards",
  "recTouchdowns",
  "fumblesLost",
  "pointsStandard",
  "pointsPpr",
  "passAirYards",
  "passYardsAfterCatch",
  "passEpa",
  "rushEpa",
  "recAirYards",
  "recYardsAfterCatch",
  "recEpa",
];

const TREND_METRIC_IDS: readonly StatsCenterTrendMetric[] = [
  "targetsPerGame",
  "carriesPerGame",
  "opportunitiesPerGame",
  "targetShare",
  "offensiveSnapShare",
  "fantasyPoints",
];

/** The contract requires every metric key, so sample rows fill the rest with nulls. */
export function statsAdditiveValues(
  values: Partial<Record<StatsCenterAdditiveMetric, number>>,
): Record<StatsCenterAdditiveMetric, number | null> {
  const record = {} as Record<StatsCenterAdditiveMetric, number | null>;
  for (const id of ADDITIVE_METRIC_IDS) record[id] = values[id] ?? null;
  return record;
}

export const emptyRatioValues: Record<StatsCenterRatioMetric, number | null> = {
  passAirConversionRatio: null,
  airYardsShare: null,
  weightedOpportunityRating: null,
  completionPercentageOverExpected: null,
};

const WITHHELD_TREND: StatsCenterTrend = {
  status: "unavailable",
  seasonAverage: null,
  recentWeightedAverage: null,
  absoluteChange: null,
  sampleSize: 0,
  recentSampleSize: 0,
  reason: "No trend is computed for this sample row.",
};

export function emptyTrendRecord(
  values: Partial<Record<StatsCenterTrendMetric, StatsCenterTrend>> = {},
): Record<StatsCenterTrendMetric, StatsCenterTrend> {
  const record = {} as Record<StatsCenterTrendMetric, StatsCenterTrend>;
  for (const id of TREND_METRIC_IDS) record[id] = values[id] ?? WITHHELD_TREND;
  return record;
}

export const emptyBoomBust: StatsCenterBoomBust = {
  status: "unavailable",
  games: 0,
  missingGames: 0,
  booms: null,
  busts: null,
  neutral: null,
  boomRate: null,
  bustRate: null,
  averagePoints: null,
  standardDeviation: null,
  threshold: null,
  reason: "Boom and bust are not computed for this sample row.",
};
