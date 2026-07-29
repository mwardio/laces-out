import {
  aiFeatureOutcomeWithToolsSchema,
  aiFeatureResponseSchema,
  aiToolUseSchema,
  type AiFeatureName,
  type AiFeatureResponse,
  type AiFeatureOutcomeWithTools,
  type AiToolUse,
} from "@fantasy/contracts";

/**
 * `AiFeatureResponse`, widened by the two fields WP7 adds.
 *
 * Composed here rather than inlined into the contracts barrel: `packages/contracts/src/index.ts` is
 * a re-export surface, and `ai-tools.ts` is a leaf that must not read its siblings back through the
 * barrel. The base schema stays authoritative for every field it already owns, so a change there
 * still flows through to this surface.
 */
export const aiFeatureWithToolUseResponseSchema = aiFeatureResponseSchema.extend({
  outcome: aiFeatureOutcomeWithToolsSchema,
  toolUse: aiToolUseSchema,
});

export type AiFeatureWithToolUseResponse = Omit<AiFeatureResponse, "outcome"> & {
  readonly outcome: AiFeatureOutcomeWithTools;
  readonly toolUse: AiToolUse;
};

/**
 * Which features route through the deterministic tool loop.
 *
 * Deliberately one feature, not all six. `start-sit` is the feature whose whole answer is the
 * Decision Desk lineup result, so it is the one where a typed tool strictly beats shipping the
 * entire context blob. The rest keep the existing bounded-context path until each gets its own
 * tool, and report `not-requested` rather than pretending otherwise.
 */
export const AI_TOOL_ENABLED_FEATURES: ReadonlySet<AiFeatureName> = new Set(["start-sit"]);
