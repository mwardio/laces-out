import type { ProjectionValue } from "@laces-out/domain";

/** Descriptive interval comparison, deliberately not a probability of winning the matchup. */
export function assessLineupChange(
  add?: ProjectionValue,
  remove?: ProjectionValue,
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
    add.floor > add.mean ||
    add.mean > add.ceiling ||
    remove.floor > remove.mean ||
    remove.mean > remove.ceiling ||
    add.floor === add.ceiling ||
    remove.floor === remove.ceiling
  )
    return {
      strength: "unrated" as const,
      explanation:
        "Comparable outcome ranges are unavailable. The point estimate alone does not establish confidence in this change.",
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
