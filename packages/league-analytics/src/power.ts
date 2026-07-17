import {
  ANALYTICS_EPSILON,
  assertFinite,
  assertNonNegative,
  assertUniqueStrings,
  clamp,
  compareNumbers,
  strengthPercentile,
} from "./shared.js";

export type PowerFactorNormalization = "ratio" | "zero-to-hundred" | "league-percentile";

export interface PowerFactorDefinition {
  readonly id: string;
  readonly label: string;
  readonly definition: string;
  readonly weight: number;
  readonly normalization: PowerFactorNormalization;
  readonly higherIsBetter?: boolean;
}

export interface PowerRankingTeamInput {
  readonly teamId: string;
  readonly factorValues: Readonly<Record<string, number | null | undefined>>;
  readonly previousRank?: number | null;
}

export interface CalculatePowerRankingsInput {
  readonly teams: readonly PowerRankingTeamInput[];
  /** Defaults to DEFAULT_POWER_FACTORS. */
  readonly factors?: readonly PowerFactorDefinition[];
}

export interface PowerFactorContribution {
  readonly id: string;
  readonly label: string;
  readonly rawValue: number | null;
  readonly normalizedScore: number | null;
  readonly configuredWeight: number;
  /** Weight after redistributing missing-factor weight among available factors. */
  readonly effectiveWeight: number;
  readonly contribution: number;
  readonly included: boolean;
  readonly explanation: string;
}

export interface TeamPowerRanking {
  readonly teamId: string;
  readonly score: number | null;
  /** Unique ordinal; exact score ties are broken by teamId and disclosed by tiedOnScore. */
  readonly rank: number | null;
  readonly previousRank: number | null;
  /** Positive means the team moved up. */
  readonly movement: number | null;
  readonly tiedOnScore: boolean;
  readonly dataCoverage: number;
  readonly factors: readonly PowerFactorContribution[];
  readonly explanation: string;
}

export interface PowerRankingsResult {
  readonly rankings: readonly TeamPowerRanking[];
  readonly factors: readonly Required<PowerFactorDefinition>[];
  readonly definition: string;
  readonly tieBreaker: string;
}

export const DEFAULT_POWER_FACTORS: readonly Required<PowerFactorDefinition>[] = [
  {
    id: "actual-win-percentage",
    label: "Actual win percentage",
    definition: "Head-to-head wins plus half-ties divided by completed matchups.",
    weight: 0.3,
    normalization: "ratio",
    higherIsBetter: true,
  },
  {
    id: "all-play-win-percentage",
    label: "All-play win percentage",
    definition: "All-play wins plus half-ties divided by all-play comparisons.",
    weight: 0.25,
    normalization: "ratio",
    higherIsBetter: true,
  },
  {
    id: "points-for-per-week",
    label: "Points for per week",
    definition: "Average official score across available scoring weeks.",
    weight: 0.2,
    normalization: "league-percentile",
    higherIsBetter: true,
  },
  {
    id: "lineup-efficiency",
    label: "Lineup efficiency",
    definition: "Actual lineup points divided by supplied optimal lineup points.",
    weight: 0.1,
    normalization: "ratio",
    higherIsBetter: true,
  },
  {
    id: "positional-strength-percentile",
    label: "Positional strength",
    definition: "Average provider-neutral positional strength percentile.",
    weight: 0.15,
    normalization: "zero-to-hundred",
    higherIsBetter: true,
  },
];

function validateInput(
  input: CalculatePowerRankingsInput,
): readonly Required<PowerFactorDefinition>[] {
  if (input.teams.length === 0) throw new RangeError("At least one team is required");
  assertUniqueStrings(
    input.teams.map((team) => team.teamId),
    "team IDs",
  );
  const rawFactors = input.factors ?? DEFAULT_POWER_FACTORS;
  if (rawFactors.length === 0) throw new RangeError("At least one power factor is required");
  assertUniqueStrings(
    rawFactors.map((factor) => factor.id),
    "power factor IDs",
  );

  const factors = rawFactors.map((factor): Required<PowerFactorDefinition> => {
    assertNonNegative(factor.weight, `weight for ${factor.id}`);
    if (factor.label.trim().length === 0 || factor.definition.trim().length === 0) {
      throw new Error(`Power factor ${factor.id} requires a label and definition`);
    }
    return { ...factor, higherIsBetter: factor.higherIsBetter ?? true };
  });
  if (factors.every((factor) => factor.weight === 0)) {
    throw new RangeError("At least one power factor must have a positive weight");
  }

  for (const team of input.teams) {
    if (team.previousRank !== undefined && team.previousRank !== null) {
      if (!Number.isInteger(team.previousRank) || team.previousRank <= 0) {
        throw new RangeError(`previousRank for ${team.teamId} must be a positive integer`);
      }
    }
    for (const factor of factors) {
      const value = team.factorValues[factor.id];
      if (value !== undefined && value !== null) {
        assertFinite(value, `${factor.id} for ${team.teamId}`);
      }
    }
  }
  return factors;
}

function normalizeFactor(
  rawValue: number,
  factor: Required<PowerFactorDefinition>,
  peerValues: readonly number[],
): number {
  const higherIsBetter = factor.higherIsBetter;
  if (factor.normalization === "league-percentile") {
    return strengthPercentile(rawValue, peerValues, higherIsBetter);
  }
  if (factor.normalization === "ratio") {
    const normalized = clamp(rawValue, 0, 1) * 100;
    return higherIsBetter ? normalized : 100 - normalized;
  }
  const normalized = clamp(rawValue, 0, 100);
  return higherIsBetter ? normalized : 100 - normalized;
}

export function calculatePowerRankings(input: CalculatePowerRankingsInput): PowerRankingsResult {
  const factors = validateInput(input);
  const peerValues = new Map<string, readonly number[]>();
  for (const factor of factors) {
    peerValues.set(
      factor.id,
      input.teams.flatMap((team) => {
        const value = team.factorValues[factor.id];
        return value === undefined || value === null ? [] : [value];
      }),
    );
  }

  const unranked = input.teams.map((team) => {
    const availableWeight = factors.reduce((sum, factor) => {
      const value = team.factorValues[factor.id];
      return value === undefined || value === null ? sum : sum + factor.weight;
    }, 0);
    const configuredWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
    const contributions = factors.map((factor): PowerFactorContribution => {
      const value = team.factorValues[factor.id];
      const included = value !== undefined && value !== null && factor.weight > 0;
      if (!included) {
        return {
          id: factor.id,
          label: factor.label,
          rawValue: value ?? null,
          normalizedScore: null,
          configuredWeight: factor.weight,
          effectiveWeight: 0,
          contribution: 0,
          included: false,
          explanation:
            value === undefined || value === null
              ? "Missing input; excluded and its weight was redistributed."
              : "Configured weight is zero; excluded from the composite.",
        };
      }

      const normalizedScore = normalizeFactor(value, factor, peerValues.get(factor.id) ?? []);
      const effectiveWeight = availableWeight === 0 ? 0 : factor.weight / availableWeight;
      return {
        id: factor.id,
        label: factor.label,
        rawValue: value,
        normalizedScore,
        configuredWeight: factor.weight,
        effectiveWeight,
        contribution: normalizedScore * effectiveWeight,
        included: true,
        explanation: `${factor.definition} Normalization: ${factor.normalization}; ${factor.higherIsBetter ? "higher" : "lower"} is better.`,
      };
    });
    const score =
      availableWeight === 0
        ? null
        : contributions.reduce((sum, factor) => sum + factor.contribution, 0);
    return {
      teamId: team.teamId,
      score,
      previousRank: team.previousRank ?? null,
      dataCoverage: configuredWeight === 0 ? 0 : availableWeight / configuredWeight,
      factors: contributions,
    };
  });

  const scored = unranked
    .filter((team): team is (typeof unranked)[number] & { score: number } => team.score !== null)
    .sort(
      (left, right) =>
        -compareNumbers(left.score, right.score) || left.teamId.localeCompare(right.teamId),
    );
  const rankByTeam = new Map(scored.map((team, index) => [team.teamId, index + 1]));
  const scoreCounts = scored.map((team) => ({
    teamId: team.teamId,
    tied: scored.some(
      (other) =>
        other.teamId !== team.teamId && Math.abs(other.score - team.score) <= ANALYTICS_EPSILON,
    ),
  }));
  const tiedByTeam = new Map(scoreCounts.map((item) => [item.teamId, item.tied]));

  const rankings = unranked
    .map((team): TeamPowerRanking => {
      const rank = rankByTeam.get(team.teamId) ?? null;
      const movement =
        rank === null || team.previousRank === null ? null : team.previousRank - rank;
      return {
        ...team,
        rank,
        movement,
        tiedOnScore: tiedByTeam.get(team.teamId) ?? false,
        explanation:
          team.score === null
            ? "No weighted factor was available, so this team is unranked."
            : "Power score is the sum of normalized factor contributions. Missing inputs are excluded and available factor weights are renormalized to 100%.",
      };
    })
    .sort((left, right) => {
      if (left.rank !== null && right.rank !== null) return left.rank - right.rank;
      if (left.rank !== null) return -1;
      if (right.rank !== null) return 1;
      return left.teamId.localeCompare(right.teamId);
    });

  return {
    rankings,
    factors,
    definition:
      "A 0-100 weighted composite of disclosed factors. League-percentile factors are calculated only from supplied peers; ratio and 0-100 factors are clamped to their stated ranges.",
    tieBreaker: "Score descending, then teamId ascending for an explicit deterministic ordinal.",
  };
}
