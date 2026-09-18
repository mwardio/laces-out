import { z } from "zod";

const quantiles = z.tuple([z.literal(0.15), z.literal(0.5), z.literal(0.85)]);
const evidence = {
  quantiles,
  evidenceInterpretation: z.literal("historical-descriptive"),
  evidenceChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
};

/**
 * Presentation metadata derived from a published set's immutable model-run evidence. It does not
 * authorize publication or establish an individual coverage guarantee. Legacy ranges retain their
 * original method; missing or unknown evidence must never be inferred from a model display name.
 */
export const rosIntervalDescriptorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("legacy-block-cqr"),
      method: z.literal("season-blocked-split-conformal-cqr-v1"),
      ...evidence,
    })
    .strict(),
  z
    .object({
      kind: z.literal("player-marginal"),
      method: z.literal("season-prior-weighted-quantile-residuals-v1"),
      target: z.literal("individual-player-marginal-quantiles"),
      nominalCoverage: z.literal(0.7),
      qualificationMethod: z.literal("ros-marginal-interval-qualification-v1"),
      ...evidence,
    })
    .strict(),
]);

export type RosIntervalDescriptor = z.infer<typeof rosIntervalDescriptorSchema>;

/** Unknown versions and absent evidence render as unavailable, never as a legacy default. */
export function parseRosIntervalDescriptor(value: unknown): RosIntervalDescriptor | null {
  const result = rosIntervalDescriptorSchema.safeParse(value);
  return result.success ? result.data : null;
}
