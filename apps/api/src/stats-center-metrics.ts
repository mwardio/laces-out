import type { DerivedNumericMetric } from "@fantasy/league-analytics";

/**
 * Stats Center reads the same admitted weekly artifact the projection engine does, so the
 * aggregation kind has to be declared per metric rather than inferred. Summing a stored
 * per-game rate (CPOE, air-yards share, WOPR) would invent a number the source never
 * published, so rates are either recomputed from their own numerator and denominator or
 * reported as an explicit per-game mean.
 */
export type StatsCenterAggregationKind = "additive" | "derivedRatio" | "perGameMean";

export const STATS_CENTER_ADDITIVE_METRIC_IDS = [
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
] as const;
export type StatsCenterAdditiveMetricId = (typeof STATS_CENTER_ADDITIVE_METRIC_IDS)[number];

export const STATS_CENTER_RATIO_METRIC_IDS = [
  "passAirConversionRatio",
  "airYardsShare",
  "weightedOpportunityRating",
  "completionPercentageOverExpected",
] as const;
export type StatsCenterRatioMetricId = (typeof STATS_CENTER_RATIO_METRIC_IDS)[number];

export type StatsCenterMetricFamily = "production" | "efficiency";

export interface StatsCenterMetricDescriptor {
  readonly id: StatsCenterAdditiveMetricId | StatsCenterRatioMetricId;
  readonly label: string;
  readonly family: StatsCenterMetricFamily;
  readonly kind: StatsCenterAggregationKind;
  readonly definition: string;
}

/** One weekly observation, narrowed to the stored payloads this module aggregates. */
export interface StatsCenterMetricRow {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly components: Readonly<Record<string, number>>;
  readonly advanced: Readonly<Record<string, number | null>>;
  readonly sourceFantasyPoints: Readonly<Record<string, number>>;
}

const WOPR_TARGET_SHARE_WEIGHT = 1.5;
const WOPR_AIR_YARDS_SHARE_WEIGHT = 0.7;

/** Stored `components` keys, which are the upstream nflverse snake_case field names. */
const ADDITIVE_COMPONENT_KEYS: Readonly<Record<string, string>> = {
  passCompletions: "passing_completions",
  passAttempts: "passing_attempts",
  passYards: "passing_yards",
  passTouchdowns: "passing_touchdowns",
  passInterceptions: "passing_interceptions",
  rushYards: "rushing_yards",
  rushTouchdowns: "rushing_touchdowns",
  receptions: "receptions",
  recYards: "receiving_yards",
  recTouchdowns: "receiving_touchdowns",
  fumblesLost: "fumbles_lost_total",
};

/** Stored `advanced` keys, which are camelCase because the ingestion spreads the source object. */
const ADDITIVE_ADVANCED_KEYS: Readonly<Record<string, string>> = {
  passAirYards: "passingAirYards",
  passYardsAfterCatch: "passingYardsAfterCatch",
  passEpa: "passingEpa",
  rushEpa: "rushingEpa",
  recAirYards: "receivingAirYards",
  recYardsAfterCatch: "receivingYardsAfterCatch",
  recEpa: "receivingEpa",
};

const ADDITIVE_FANTASY_POINT_KEYS: Readonly<Record<string, string>> = {
  pointsStandard: "standard",
  pointsPpr: "ppr",
};

const TEAM_COVERAGE_REASON =
  "This share is withheld because complete team-game coverage was not established for this source file.";

export const STATS_CENTER_METRIC_DESCRIPTORS: readonly StatsCenterMetricDescriptor[] = [
  {
    id: "passCompletions",
    label: "Completions",
    family: "production",
    kind: "additive",
    definition: "Sum of stored passing completions across the included games.",
  },
  {
    id: "passAttempts",
    label: "Attempts",
    family: "production",
    kind: "additive",
    definition: "Sum of stored passing attempts across the included games.",
  },
  {
    id: "passYards",
    label: "Passing yards",
    family: "production",
    kind: "additive",
    definition: "Sum of stored passing yards across the included games.",
  },
  {
    id: "passTouchdowns",
    label: "Passing TD",
    family: "production",
    kind: "additive",
    definition: "Sum of stored passing touchdowns across the included games.",
  },
  {
    id: "passInterceptions",
    label: "Interceptions",
    family: "production",
    kind: "additive",
    definition: "Sum of stored interceptions thrown across the included games.",
  },
  {
    id: "rushYards",
    label: "Rushing yards",
    family: "production",
    kind: "additive",
    definition: "Sum of stored rushing yards across the included games.",
  },
  {
    id: "rushTouchdowns",
    label: "Rushing TD",
    family: "production",
    kind: "additive",
    definition: "Sum of stored rushing touchdowns across the included games.",
  },
  {
    id: "receptions",
    label: "Receptions",
    family: "production",
    kind: "additive",
    definition: "Sum of stored receptions across the included games.",
  },
  {
    id: "recYards",
    label: "Receiving yards",
    family: "production",
    kind: "additive",
    definition: "Sum of stored receiving yards across the included games.",
  },
  {
    id: "recTouchdowns",
    label: "Receiving TD",
    family: "production",
    kind: "additive",
    definition: "Sum of stored receiving touchdowns across the included games.",
  },
  {
    id: "fumblesLost",
    label: "Fumbles lost",
    family: "production",
    kind: "additive",
    definition:
      "Sum of stored total fumbles lost, which includes sack, rushing, receiving, return, and miscellaneous fumbles.",
  },
  {
    id: "pointsStandard",
    label: "Points (standard)",
    family: "production",
    kind: "additive",
    definition:
      "Sum of the source's standard-scoring fantasy points. This is the upstream dataset's own scoring, not any league's rules.",
  },
  {
    id: "pointsPpr",
    label: "Points (PPR)",
    family: "production",
    kind: "additive",
    definition:
      "Sum of the source's PPR fantasy points. This is the upstream dataset's own scoring, not any league's rules.",
  },
  {
    id: "passAirYards",
    label: "Passing air yards",
    family: "efficiency",
    kind: "additive",
    definition: "Sum of stored passing air yards across the included games.",
  },
  {
    id: "passYardsAfterCatch",
    label: "Passing YAC",
    family: "efficiency",
    kind: "additive",
    definition: "Sum of stored passing yards after catch across the included games.",
  },
  {
    id: "passEpa",
    label: "Passing EPA",
    family: "efficiency",
    kind: "additive",
    definition: "Sum of stored passing expected points added across the included games.",
  },
  {
    id: "rushEpa",
    label: "Rushing EPA",
    family: "efficiency",
    kind: "additive",
    definition: "Sum of stored rushing expected points added across the included games.",
  },
  {
    id: "recAirYards",
    label: "Receiving air yards",
    family: "efficiency",
    kind: "additive",
    definition: "Sum of stored receiving air yards across the included games.",
  },
  {
    id: "recYardsAfterCatch",
    label: "Receiving YAC",
    family: "efficiency",
    kind: "additive",
    definition: "Sum of stored receiving yards after catch across the included games.",
  },
  {
    id: "recEpa",
    label: "Receiving EPA",
    family: "efficiency",
    kind: "additive",
    definition: "Sum of stored receiving expected points added across the included games.",
  },
  {
    id: "passAirConversionRatio",
    label: "PACR",
    family: "efficiency",
    kind: "derivedRatio",
    definition:
      "Passing air conversion ratio, recomputed as summed passing yards divided by summed passing air yards over the included games rather than averaging the stored per-game ratio.",
  },
  {
    id: "airYardsShare",
    label: "Air-yards share",
    family: "efficiency",
    kind: "derivedRatio",
    definition:
      "Player receiving air yards divided by all receiving air yards for the same team and games. It is withheld unless complete team-game coverage is affirmed.",
  },
  {
    id: "weightedOpportunityRating",
    label: "WOPR",
    family: "efficiency",
    kind: "derivedRatio",
    definition:
      "Weighted opportunity rating, recomputed as 1.5 times target share plus 0.7 times air-yards share over the included games. It is withheld unless both shares are available.",
  },
  {
    id: "completionPercentageOverExpected",
    label: "CPOE",
    family: "efficiency",
    kind: "perGameMean",
    definition:
      "Unweighted mean of the stored per-game completion percentage over expected. CPOE is a rate the source publishes per game, so it is averaged rather than summed, and games missing the value are excluded and disclosed.",
  },
];

const DESCRIPTORS_BY_ID = new Map(
  STATS_CENTER_METRIC_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

function descriptorFor(
  id: StatsCenterAdditiveMetricId | StatsCenterRatioMetricId,
): StatsCenterMetricDescriptor {
  const descriptor = DESCRIPTORS_BY_ID.get(id);
  if (!descriptor) throw new Error(`Stats Center metric ${id} has no descriptor`);
  return descriptor;
}

function available(value: number, sampleSize: number, definition: string): DerivedNumericMetric {
  return { status: "available", value, sampleSize, definition };
}

function unavailable(reason: string, definition: string, sampleSize = 0): DerivedNumericMetric {
  return { status: "unavailable", value: null, sampleSize, reason, definition };
}

/** Absent or non-finite payload values mean schema drift, which is disclosed rather than thrown. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function statsCenterTeamGameKey(
  row: Pick<StatsCenterMetricRow, "season" | "gameId" | "team">,
): string {
  return `${row.season}\u0000${row.gameId}\u0000${row.team}`;
}

/**
 * Team receiving air yards per team-game, which is the denominator air-yards share needs.
 * Build it from every player row, exactly as the opportunity derivation builds team targets.
 */
export function buildTeamAirYardsByGame(
  rows: readonly StatsCenterMetricRow[],
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const airYards = finiteOrNull(row.advanced.receivingAirYards);
    if (airYards === null) continue;
    const key = statsCenterTeamGameKey(row);
    totals.set(key, (totals.get(key) ?? 0) + airYards);
  }
  return totals;
}

function additiveSource(id: StatsCenterAdditiveMetricId, row: StatsCenterMetricRow): number | null {
  const componentKey = ADDITIVE_COMPONENT_KEYS[id];
  if (componentKey !== undefined) return finiteOrNull(row.components[componentKey]);
  const advancedKey = ADDITIVE_ADVANCED_KEYS[id];
  if (advancedKey !== undefined) return finiteOrNull(row.advanced[advancedKey]);
  const pointsKey = ADDITIVE_FANTASY_POINT_KEYS[id];
  if (pointsKey !== undefined) return finiteOrNull(row.sourceFantasyPoints[pointsKey]);
  throw new Error(`Stats Center additive metric ${id} has no stored source key`);
}

function sumAdditive(
  id: StatsCenterAdditiveMetricId,
  rows: readonly StatsCenterMetricRow[],
): { readonly total: number; readonly sampleSize: number } | null {
  let total = 0;
  let sampleSize = 0;
  for (const row of rows) {
    const value = additiveSource(id, row);
    if (value === null) continue;
    total += value;
    sampleSize += 1;
  }
  return sampleSize === 0 ? null : { total, sampleSize };
}

export interface AggregateStatsCenterMetricsInput {
  /** The player's own weekly rows, already narrowed to the requested window. */
  readonly rows: readonly StatsCenterMetricRow[];
  readonly teamAirYardsByGame: ReadonlyMap<string, number>;
  /** Affirmed only when every player row for each included team-game is present. */
  readonly teamTotalsComplete: boolean;
  /** Taken from the opportunity derivation so target share keeps a single source of truth. */
  readonly targetShare: number | null;
}

export interface StatsCenterAggregatedMetrics {
  readonly totals: Readonly<Record<StatsCenterAdditiveMetricId, DerivedNumericMetric>>;
  readonly perGame: Readonly<Record<StatsCenterAdditiveMetricId, DerivedNumericMetric>>;
  readonly ratios: Readonly<Record<StatsCenterRatioMetricId, DerivedNumericMetric>>;
}

function additiveMetrics(rows: readonly StatsCenterMetricRow[]): {
  readonly totals: Record<StatsCenterAdditiveMetricId, DerivedNumericMetric>;
  readonly perGame: Record<StatsCenterAdditiveMetricId, DerivedNumericMetric>;
} {
  const totals = {} as Record<StatsCenterAdditiveMetricId, DerivedNumericMetric>;
  const perGame = {} as Record<StatsCenterAdditiveMetricId, DerivedNumericMetric>;
  for (const id of STATS_CENTER_ADDITIVE_METRIC_IDS) {
    const { definition } = descriptorFor(id);
    const summed = sumAdditive(id, rows);
    if (!summed) {
      const reason =
        rows.length === 0
          ? "No weekly observations are available for this window."
          : "The admitted weekly rows do not carry this field.";
      totals[id] = unavailable(reason, definition);
      perGame[id] = unavailable(reason, definition);
      continue;
    }
    totals[id] = available(summed.total, summed.sampleSize, definition);
    // Per-game divides by the games that actually carried the field, so a partially
    // present field cannot be diluted by games it was never stored for.
    perGame[id] = available(summed.total / summed.sampleSize, summed.sampleSize, definition);
  }
  return { totals, perGame };
}

function ratioMetrics(
  input: AggregateStatsCenterMetricsInput,
): Record<StatsCenterRatioMetricId, DerivedNumericMetric> {
  const { rows, teamAirYardsByGame, teamTotalsComplete, targetShare } = input;
  const ratios = {} as Record<StatsCenterRatioMetricId, DerivedNumericMetric>;

  const pacrDefinition = descriptorFor("passAirConversionRatio").definition;
  const passYards = sumAdditive("passYards", rows);
  const passAirYards = sumAdditive("passAirYards", rows);
  ratios.passAirConversionRatio =
    !passYards || !passAirYards
      ? unavailable(
          "Passing yards and passing air yards are not both present in the admitted rows.",
          pacrDefinition,
        )
      : passAirYards.total === 0
        ? unavailable(
            "Passing air yards total zero over this window, so the ratio has no denominator.",
            pacrDefinition,
            passAirYards.sampleSize,
          )
        : available(
            passYards.total / passAirYards.total,
            Math.min(passYards.sampleSize, passAirYards.sampleSize),
            pacrDefinition,
          );

  const shareDefinition = descriptorFor("airYardsShare").definition;
  const playerAirYards = sumAdditive("recAirYards", rows);
  let airYardsShare: number | null = null;
  if (!teamTotalsComplete) {
    ratios.airYardsShare = unavailable(
      TEAM_COVERAGE_REASON,
      shareDefinition,
      playerAirYards?.sampleSize ?? 0,
    );
  } else if (!playerAirYards) {
    ratios.airYardsShare = unavailable(
      "Receiving air yards are not present in the admitted rows.",
      shareDefinition,
    );
  } else {
    let teamTotal = 0;
    for (const key of new Set(rows.map(statsCenterTeamGameKey))) {
      teamTotal += teamAirYardsByGame.get(key) ?? 0;
    }
    if (teamTotal === 0) {
      ratios.airYardsShare = unavailable(
        "Team receiving air yards total zero over this window, so the share has no denominator.",
        shareDefinition,
        playerAirYards.sampleSize,
      );
    } else {
      airYardsShare = playerAirYards.total / teamTotal;
      ratios.airYardsShare = available(airYardsShare, playerAirYards.sampleSize, shareDefinition);
    }
  }

  const woprDefinition = descriptorFor("weightedOpportunityRating").definition;
  ratios.weightedOpportunityRating =
    targetShare === null || airYardsShare === null
      ? unavailable(
          targetShare === null
            ? "WOPR needs target share, which is withheld for this window."
            : TEAM_COVERAGE_REASON,
          woprDefinition,
        )
      : available(
          WOPR_TARGET_SHARE_WEIGHT * targetShare + WOPR_AIR_YARDS_SHARE_WEIGHT * airYardsShare,
          rows.length,
          woprDefinition,
        );

  const cpoeDefinition = descriptorFor("completionPercentageOverExpected").definition;
  const cpoeValues = rows.flatMap((row) => {
    const value = finiteOrNull(row.advanced.passingCpoe);
    return value === null ? [] : [value];
  });
  ratios.completionPercentageOverExpected =
    cpoeValues.length === 0
      ? unavailable(
          "No included game carries a stored completion percentage over expected.",
          cpoeDefinition,
        )
      : available(
          cpoeValues.reduce((sum, value) => sum + value, 0) / cpoeValues.length,
          cpoeValues.length,
          cpoeDefinition,
        );

  return ratios;
}

export function aggregateStatsCenterMetrics(
  input: AggregateStatsCenterMetricsInput,
): StatsCenterAggregatedMetrics {
  const { totals, perGame } = additiveMetrics(input.rows);
  return { totals, perGame, ratios: ratioMetrics(input) };
}

export type StatsCenterMetricId = StatsCenterAdditiveMetricId | StatsCenterRatioMetricId;

export interface StatsCenterMetricAvailability {
  readonly state: "available" | "unavailable" | "no-data";
  readonly reason: string | null;
}

export interface DescribeStatsCenterMetricAvailabilityInput {
  /** Every row in the requested window, across all players, not one player's rows. */
  readonly rows: readonly StatsCenterMetricRow[];
  readonly teamTotalsComplete: boolean;
  readonly targetShareAvailable: boolean;
  /** Set when the underlying weekly dataset itself is withheld, which withholds everything. */
  readonly datasetUnavailableReason: string | null;
}

/**
 * Per-metric availability for the whole window, so a metric the admitted file simply does
 * not carry reads as withheld with a reason rather than as a column of dashes. Player-level
 * nulls under an available metric mean that player has no value, which is a different claim.
 */
export function describeStatsCenterMetricAvailability(
  input: DescribeStatsCenterMetricAvailabilityInput,
): Readonly<Record<StatsCenterMetricId, StatsCenterMetricAvailability>> {
  const { rows, teamTotalsComplete, targetShareAvailable, datasetUnavailableReason } = input;
  const availability = {} as Record<StatsCenterMetricId, StatsCenterMetricAvailability>;
  const withheld = (reason: string): StatsCenterMetricAvailability => ({
    state: "unavailable",
    reason,
  });

  const present = new Set<StatsCenterAdditiveMetricId>();
  if (!datasetUnavailableReason) {
    for (const id of STATS_CENTER_ADDITIVE_METRIC_IDS) {
      if (rows.some((row) => additiveSource(id, row) !== null)) present.add(id);
    }
  }
  const cpoePresent =
    !datasetUnavailableReason &&
    rows.some((row) => finiteOrNull(row.advanced.passingCpoe) !== null);

  for (const id of STATS_CENTER_ADDITIVE_METRIC_IDS) {
    availability[id] = datasetUnavailableReason
      ? withheld(datasetUnavailableReason)
      : rows.length === 0
        ? { state: "no-data", reason: "No regular-season rows match these filters." }
        : present.has(id)
          ? { state: "available", reason: null }
          : withheld("The admitted weekly rows for this window do not carry this field.");
  }

  availability.passAirConversionRatio = datasetUnavailableReason
    ? withheld(datasetUnavailableReason)
    : present.has("passYards") && present.has("passAirYards")
      ? { state: "available", reason: null }
      : withheld("Passing yards and passing air yards are not both present in this window.");

  const shareWithheld = !present.has("recAirYards")
    ? "Receiving air yards are not present in this window."
    : !teamTotalsComplete
      ? TEAM_COVERAGE_REASON
      : null;
  availability.airYardsShare = datasetUnavailableReason
    ? withheld(datasetUnavailableReason)
    : shareWithheld
      ? withheld(shareWithheld)
      : { state: "available", reason: null };

  availability.weightedOpportunityRating = datasetUnavailableReason
    ? withheld(datasetUnavailableReason)
    : shareWithheld
      ? withheld(shareWithheld)
      : targetShareAvailable
        ? { state: "available", reason: null }
        : withheld("WOPR needs target share, which is withheld for this window.");

  availability.completionPercentageOverExpected = datasetUnavailableReason
    ? withheld(datasetUnavailableReason)
    : cpoePresent
      ? { state: "available", reason: null }
      : withheld("No row in this window carries a stored completion percentage over expected.");

  return availability;
}
