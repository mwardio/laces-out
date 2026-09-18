import type { ProjectionValue } from "@laces-out/domain";

export interface LineupAdviceProjection extends ProjectionValue {
  readonly confidence?: number;
  /** False when numeric endpoints exist only as a mean-only engine fallback. */
  readonly intervalAvailable?: boolean;
}

/** Half of the decision UI's 0.1-point display unit; this is a presentation rule, not a model gate. */
export const LINEUP_NEGLIGIBLE_GAIN = 0.05;

/** Matches the projection model's high-quality boundary; confidence is not a win probability. */
export function projectionHasLimitedConfidence(
  projection: LineupAdviceProjection | undefined,
): boolean {
  const confidence = projection?.confidence;
  return (
    confidence !== undefined &&
    (!Number.isFinite(confidence) || confidence < 0.75 || confidence > 1)
  );
}

/** Never retain a starter with a known absence, no scheduled game, or a zero/missing forecast. */
export function starterAllowsNearTieRetention(input: {
  readonly statuses: readonly (string | null | undefined)[];
  readonly projection: ProjectionValue | undefined;
  readonly scheduled: boolean;
}): boolean {
  if (
    !input.scheduled ||
    !input.projection ||
    !Number.isFinite(input.projection.mean) ||
    input.projection.mean <= 0
  )
    return false;
  const unavailable = new Set([
    "OUT",
    "O",
    "IR",
    "INJUREDRESERVE",
    "RESERVEINJURED",
    "PUP",
    "RESERVEPUP",
    "SUSPENDED",
    "SUSP",
    "SUS",
    "INACTIVE",
    "INA",
    "NA",
    "RES",
    "RESERVE",
    "DEV",
    "CUT",
    "NWT",
    "RET",
    "TRC",
    "TRD",
    "TRT",
    "EXE",
    "BYE",
    "DOUBTFUL",
    "D",
  ]);
  return !input.statuses.some((status) =>
    unavailable.has(
      status
        ?.trim()
        .toUpperCase()
        .replaceAll(/[\s_/-]/gu, "") ?? "",
    ),
  );
}

/** Descriptive interval comparison, deliberately not a probability of winning the matchup. */
export function assessLineupChange(
  add?: LineupAdviceProjection,
  remove?: LineupAdviceProjection,
  provider?: { add: number | undefined; remove: number | undefined },
) {
  if (!add || !remove)
    return {
      strength: "unrated" as const,
      explanation: "A two-player uncertainty comparison is unavailable for this slot change.",
    };
  if (add.mean < remove.mean)
    return {
      strength: "unrated" as const,
      explanation:
        "This slot move lowers projected points on its own and only makes sense as part of the complete lineup plan.",
    };
  if (
    provider &&
    typeof provider.add === "number" &&
    Number.isFinite(provider.add) &&
    typeof provider.remove === "number" &&
    Number.isFinite(provider.remove) &&
    provider.remove > provider.add
  )
    return {
      strength: "close-call" as const,
      explanation: `Forecasts disagree: ESPN's current league-scored projections favor the player being removed (${provider.remove.toFixed(2)} points versus ${provider.add.toFixed(2)}). Review the alternative before making this change; ESPN's numbers are a separate comparison.`,
    };
  if (
    ![add.floor, add.mean, add.ceiling, remove.floor, remove.mean, remove.ceiling].every(
      Number.isFinite,
    ) ||
    add.intervalAvailable === false ||
    remove.intervalAvailable === false ||
    add.floor > add.ceiling ||
    remove.floor > remove.ceiling ||
    add.floor === add.ceiling ||
    remove.floor === remove.ceiling
  )
    return {
      strength: "unrated" as const,
      explanation:
        "Comparable outcome ranges are unavailable. The point estimate alone does not establish confidence in this change.",
    };
  if (projectionHasLimitedConfidence(add) || projectionHasLimitedConfidence(remove))
    return {
      strength: "close-call" as const,
      explanation:
        "Limited evidence behind one or both forecasts makes this an uncertain call. The projected ranges may not reliably capture player uncertainty. Recheck current usage and injury news before changing your lineup; the point gap is not a win probability.",
    };
  // A skewed distribution's mean can lie outside its central interval. Separated ranges only
  // support the higher-mean player when the ranges point in that same direction.
  if (add.ceiling < remove.floor)
    return {
      strength: "close-call" as const,
      explanation:
        "The higher expected-point forecast has a lower central outcome range. The mean and ranges favor different players, so treat this as an uncertain call; the point gap is not a win probability.",
    };
  const overlap = add.floor <= remove.ceiling && remove.floor <= add.ceiling;
  return overlap
    ? {
        strength: "close-call" as const,
        explanation:
          "The projected outcome ranges overlap. Treat this as a model preference and recheck usage and injury news before making the change.",
      }
    : {
        strength: "model-edge" as const,
        explanation:
          "The supplied outcome ranges do not overlap. This supports the model's preference but is not a guarantee or a calibrated win probability.",
      };
}
