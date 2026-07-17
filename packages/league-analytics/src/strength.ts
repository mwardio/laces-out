import {
  ANALYTICS_EPSILON,
  assertFinite,
  assertUniqueStrings,
  mean,
  populationStandardDeviation,
  strengthPercentile,
  type MetricDefinition,
} from "./shared.js";

export interface PositionalValueBasis {
  readonly id: string;
  readonly label: string;
  /** Describe exactly what was summed or projected (for example, ROS starter VORP). */
  readonly definition: string;
  readonly higherIsBetter?: boolean;
}

export interface TeamPositionalValueInput {
  readonly teamId: string;
  readonly position: string;
  readonly value: number;
}

export interface AnalyzePositionalStrengthInput {
  readonly teamIds: readonly string[];
  /** Supplying positions creates explicit missing rows; otherwise positions are inferred. */
  readonly positions?: readonly string[];
  readonly values: readonly TeamPositionalValueInput[];
  readonly basis: PositionalValueBasis;
}

export interface PositionalStrengthEntry {
  readonly teamId: string;
  readonly position: string;
  readonly status: "available" | "missing";
  readonly value: number | null;
  readonly leagueMean: number | null;
  readonly leagueStandardDeviation: number | null;
  /** Direction-adjusted z-score: positive always means stronger. */
  readonly strengthZScore: number | null;
  /** Direction-adjusted midrank percentile from 0 to 100. */
  readonly percentile: number | null;
  /** Competition rank within this position; tied values share a rank. */
  readonly rank: number | null;
  readonly sampleSize: number;
  readonly tiedTeams: number;
  readonly explanation: string;
}

export interface TeamPositionalStrengthSummary {
  readonly teamId: string;
  readonly averagePercentile: number | null;
  readonly averageStrengthZScore: number | null;
  readonly positionsAvailable: number;
  readonly positionsExpected: number;
  readonly coverage: number;
  readonly entries: readonly PositionalStrengthEntry[];
  readonly definition: string;
}

export interface PositionalStrengthResult {
  readonly basis: Required<PositionalValueBasis>;
  readonly positions: readonly string[];
  readonly teams: readonly TeamPositionalStrengthSummary[];
  readonly definition: MetricDefinition;
}

const POSITIONAL_STRENGTH_DEFINITION =
  "Within each position, supplied team values are compared only with league peers. Percentiles use midranks, z-scores use the population standard deviation, and positive values always mean stronger.";

function validateInput(input: AnalyzePositionalStrengthInput): readonly string[] {
  if (input.teamIds.length === 0) throw new RangeError("At least one team is required");
  assertUniqueStrings(input.teamIds, "team IDs");
  if (input.basis.id.trim().length === 0 || input.basis.label.trim().length === 0) {
    throw new Error("The positional value basis requires an id and label");
  }
  if (input.basis.definition.trim().length === 0) {
    throw new Error("The positional value basis requires a definition");
  }

  const knownTeams = new Set(input.teamIds);
  const inferredPositions = input.values.map((item) => item.position);
  const positions =
    input.positions === undefined ? [...new Set(inferredPositions)] : [...input.positions];
  assertUniqueStrings(positions, "positions");
  const knownPositions = new Set(positions);
  const valueKeys = new Set<string>();

  for (const item of input.values) {
    if (!knownTeams.has(item.teamId)) throw new Error(`Unknown team ${item.teamId}`);
    if (!knownPositions.has(item.position)) throw new Error(`Unknown position ${item.position}`);
    assertFinite(item.value, `positional value for ${item.teamId}/${item.position}`);
    const key = `${item.teamId}\u0000${item.position}`;
    if (valueKeys.has(key))
      throw new Error(`Duplicate positional value for ${item.teamId}/${item.position}`);
    valueKeys.add(key);
  }

  return positions.sort((left, right) => left.localeCompare(right));
}

export function analyzePositionalStrength(
  input: AnalyzePositionalStrengthInput,
): PositionalStrengthResult {
  const positions = validateInput(input);
  const higherIsBetter = input.basis.higherIsBetter ?? true;
  const orderedTeamIds = [...input.teamIds].sort((left, right) => left.localeCompare(right));
  const valueByKey = new Map(
    input.values.map((item) => [`${item.teamId}\u0000${item.position}`, item.value]),
  );
  const entriesByTeam = new Map<string, PositionalStrengthEntry[]>();

  for (const position of positions) {
    const available = orderedTeamIds.flatMap((teamId) => {
      const value = valueByKey.get(`${teamId}\u0000${position}`);
      return value === undefined ? [] : [{ teamId, value }];
    });
    const rawValues = available.map((item) => item.value);
    const leagueMean = mean(rawValues);
    const leagueStandardDeviation = populationStandardDeviation(rawValues);

    for (const teamId of orderedTeamIds) {
      const value = valueByKey.get(`${teamId}\u0000${position}`);
      let entry: PositionalStrengthEntry;
      if (value === undefined) {
        entry = {
          teamId,
          position,
          status: "missing",
          value: null,
          leagueMean,
          leagueStandardDeviation,
          strengthZScore: null,
          percentile: null,
          rank: null,
          sampleSize: rawValues.length,
          tiedTeams: 0,
          explanation: `No ${input.basis.label} value was supplied; this position is excluded from the team aggregate.`,
        };
      } else {
        const direction = higherIsBetter ? 1 : -1;
        const tiedTeams = rawValues.filter(
          (candidate) => Math.abs(candidate - value) <= ANALYTICS_EPSILON,
        ).length;
        const strongerTeams = rawValues.filter(
          (candidate) => direction * candidate > direction * value + ANALYTICS_EPSILON,
        ).length;
        const zScore =
          leagueMean === null ||
          leagueStandardDeviation === null ||
          leagueStandardDeviation <= ANALYTICS_EPSILON
            ? 0
            : (direction * (value - leagueMean)) / leagueStandardDeviation;
        const percentile = strengthPercentile(value, rawValues, higherIsBetter);
        entry = {
          teamId,
          position,
          status: "available",
          value,
          leagueMean,
          leagueStandardDeviation,
          strengthZScore: zScore,
          percentile,
          rank: strongerTeams + 1,
          sampleSize: rawValues.length,
          tiedTeams,
          explanation: `${input.basis.label}: ${value}; league mean: ${leagueMean ?? "unavailable"}; strength percentile: ${percentile.toFixed(1)}.`,
        };
      }

      const teamEntries = entriesByTeam.get(teamId) ?? [];
      teamEntries.push(entry);
      entriesByTeam.set(teamId, teamEntries);
    }
  }

  const teams = orderedTeamIds.map((teamId): TeamPositionalStrengthSummary => {
    const entries = entriesByTeam.get(teamId) ?? [];
    const availableEntries = entries.filter(
      (
        entry,
      ): entry is PositionalStrengthEntry & {
        percentile: number;
        strengthZScore: number;
      } => entry.percentile !== null && entry.strengthZScore !== null,
    );
    const averagePercentile = mean(availableEntries.map((entry) => entry.percentile));
    const averageStrengthZScore = mean(availableEntries.map((entry) => entry.strengthZScore));

    return {
      teamId,
      averagePercentile,
      averageStrengthZScore,
      positionsAvailable: availableEntries.length,
      positionsExpected: positions.length,
      coverage: positions.length === 0 ? 1 : availableEntries.length / positions.length,
      entries,
      definition:
        "The team aggregate is the unweighted mean of its available position percentiles; coverage reports how many requested positions contributed.",
    };
  });

  return {
    basis: {
      id: input.basis.id,
      label: input.basis.label,
      definition: input.basis.definition,
      higherIsBetter,
    },
    positions,
    teams,
    definition: {
      id: "positional-strength",
      label: "Positional strength",
      definition: POSITIONAL_STRENGTH_DEFINITION,
    },
  };
}
