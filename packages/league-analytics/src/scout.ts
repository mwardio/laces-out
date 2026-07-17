import {
  ANALYTICS_EPSILON,
  assertFinite,
  assertNonNegative,
  assertUniqueStrings,
  compareNumbers,
} from "./shared.js";

export interface OpponentScoutMetricInput {
  readonly id: string;
  readonly label: string;
  readonly definition: string;
  readonly subjectValue: number | null;
  readonly opponentValue: number | null;
  readonly leagueAverage?: number | null;
  readonly higherIsBetter?: boolean;
  readonly unit?: string;
}

export interface BuildOpponentScoutInput {
  readonly subjectTeamId: string;
  readonly opponentTeamId: string;
  readonly metrics: readonly OpponentScoutMetricInput[];
  /** Direction-adjusted differences inside this tolerance are called even. */
  readonly evenTolerance?: number;
}

export type ScoutEdgeOwner = "subject" | "opponent" | "even" | "unknown";

export interface OpponentScoutMetricDelta {
  readonly id: string;
  readonly label: string;
  readonly definition: string;
  readonly unit: string | null;
  readonly higherIsBetter: boolean;
  readonly subjectValue: number | null;
  readonly opponentValue: number | null;
  readonly leagueAverage: number | null;
  /** Raw opponent value minus subject value. */
  readonly opponentMinusSubject: number | null;
  /** Raw opponent value minus league average. */
  readonly opponentMinusLeague: number | null;
  /** Direction-adjusted subject value minus opponent value; positive favors subject. */
  readonly subjectAdvantage: number | null;
  /** Direction-adjusted opponent value minus league average; positive means above average. */
  readonly opponentStrengthVsLeague: number | null;
  readonly edgeOwner: ScoutEdgeOwner;
  readonly explanation: string;
}

export interface OpponentScoutResult {
  readonly subjectTeamId: string;
  readonly opponentTeamId: string;
  readonly metrics: readonly OpponentScoutMetricDelta[];
  readonly subjectAdvantages: readonly string[];
  readonly opponentAdvantages: readonly string[];
  readonly unavailableMetrics: readonly string[];
  readonly definition: string;
}

function validateInput(input: BuildOpponentScoutInput): void {
  if (input.subjectTeamId.trim().length === 0 || input.opponentTeamId.trim().length === 0) {
    throw new Error("subjectTeamId and opponentTeamId are required");
  }
  if (input.subjectTeamId === input.opponentTeamId) {
    throw new Error("A team cannot scout itself as an opponent");
  }
  assertUniqueStrings(
    input.metrics.map((metric) => metric.id),
    "scout metric IDs",
  );
  assertNonNegative(input.evenTolerance ?? ANALYTICS_EPSILON, "evenTolerance");

  for (const metric of input.metrics) {
    if (metric.label.trim().length === 0 || metric.definition.trim().length === 0) {
      throw new Error(`Scout metric ${metric.id} requires a label and definition`);
    }
    if (metric.subjectValue !== null) {
      assertFinite(metric.subjectValue, `${metric.id} subjectValue`);
    }
    if (metric.opponentValue !== null) {
      assertFinite(metric.opponentValue, `${metric.id} opponentValue`);
    }
    if (metric.leagueAverage !== undefined && metric.leagueAverage !== null) {
      assertFinite(metric.leagueAverage, `${metric.id} leagueAverage`);
    }
  }
}

export function buildOpponentScout(input: BuildOpponentScoutInput): OpponentScoutResult {
  validateInput(input);
  const tolerance = input.evenTolerance ?? ANALYTICS_EPSILON;
  const metrics = input.metrics.map((metric): OpponentScoutMetricDelta => {
    const higherIsBetter = metric.higherIsBetter ?? true;
    const leagueAverage = metric.leagueAverage ?? null;
    const complete = metric.subjectValue !== null && metric.opponentValue !== null;
    const opponentMinusSubject = complete ? metric.opponentValue - metric.subjectValue : null;
    const subjectAdvantage =
      opponentMinusSubject === null ? null : (higherIsBetter ? -1 : 1) * opponentMinusSubject;
    const opponentMinusLeague =
      metric.opponentValue === null || leagueAverage === null
        ? null
        : metric.opponentValue - leagueAverage;
    const opponentStrengthVsLeague =
      opponentMinusLeague === null ? null : (higherIsBetter ? 1 : -1) * opponentMinusLeague;
    const comparison =
      subjectAdvantage === null ? null : compareNumbers(subjectAdvantage, 0, tolerance);
    const edgeOwner: ScoutEdgeOwner =
      comparison === null
        ? "unknown"
        : comparison > 0
          ? "subject"
          : comparison < 0
            ? "opponent"
            : "even";

    return {
      id: metric.id,
      label: metric.label,
      definition: metric.definition,
      unit: metric.unit ?? null,
      higherIsBetter,
      subjectValue: metric.subjectValue,
      opponentValue: metric.opponentValue,
      leagueAverage,
      opponentMinusSubject,
      opponentMinusLeague,
      subjectAdvantage,
      opponentStrengthVsLeague,
      edgeOwner,
      explanation:
        edgeOwner === "unknown"
          ? "A subject or opponent value is missing, so no edge is assigned."
          : `Raw delta is opponent minus subject; direction-adjusted subject advantage is positive when ${input.subjectTeamId} is stronger.`,
    };
  });

  const byEdgeMagnitude = (
    left: OpponentScoutMetricDelta,
    right: OpponentScoutMetricDelta,
  ): number =>
    Math.abs(right.subjectAdvantage ?? 0) - Math.abs(left.subjectAdvantage ?? 0) ||
    left.id.localeCompare(right.id);

  return {
    subjectTeamId: input.subjectTeamId,
    opponentTeamId: input.opponentTeamId,
    metrics,
    subjectAdvantages: metrics
      .filter((metric) => metric.edgeOwner === "subject")
      .sort(byEdgeMagnitude)
      .map((metric) => metric.id),
    opponentAdvantages: metrics
      .filter((metric) => metric.edgeOwner === "opponent")
      .sort(byEdgeMagnitude)
      .map((metric) => metric.id),
    unavailableMetrics: metrics
      .filter((metric) => metric.edgeOwner === "unknown")
      .map((metric) => metric.id),
    definition:
      "A direction-aware comparison of the subject, upcoming opponent, and optional league average. It can consume projections, season metrics, power scores, or positional values without a provider dependency.",
  };
}
