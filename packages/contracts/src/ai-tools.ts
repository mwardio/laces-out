import { z } from "zod";

/**
 * Typed, deterministic AI tools (ENHANCEMENT_PLAN.md §2.5, ADR 0003).
 *
 * A tool lets the model *retrieve* an already-computed deterministic result. It never lets the
 * model compute one. Everything here is therefore read-only by construction: there is no mutating
 * variant of `AiToolDefinition`, and no tool declares a parameter that could widen its own scope.
 *
 * Its own module because `index.ts` is a re-export barrel. Nothing here imports from that barrel —
 * a leaf module that reached back through the barrel would read its own siblings in their temporal
 * dead zone, the same hazard `trade-evaluation.ts` documents.
 */

/** Bumped when a tool's name, scope, parameters, or result projection changes. */
export const AI_TOOL_CONTRACT_VERSION = "2026-07-27.1";

/** Bumped when the system prompt or feature instructions change. Versioned independently. */
export const AI_PROMPT_VERSION = "2026-07-27.1";

/**
 * Exactly the tools the server can execute today.
 *
 * WP7 ships `get_lineup_recommendation` end to end. The remaining planned tools
 * (`get_waiver_recommendations`, `get_trade_packages`, `compare_players`, `get_playoff_outlook`,
 * `get_player_stats`, `get_draft_advice`) are deliberately absent rather than declared-and-stubbed:
 * a name in this union is a promise that the registry can serve it, and advertising a tool the
 * server cannot execute would teach the model to call something that always fails.
 */
export const AI_TOOL_NAMES = ["get_lineup_recommendation"] as const;
export type AiToolName = (typeof AI_TOOL_NAMES)[number];

/** The bounded JSON Schema subset every provider in the capability matrix accepts. */
export interface AiToolPropertySchema {
  readonly type: "string" | "integer" | "boolean";
  readonly description: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface AiToolParameterSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, AiToolPropertySchema>>;
  readonly required: readonly string[];
  /** Always false. A provider that supports strict tool schemas needs it, and it is also the
   *  wire-level statement that an undeclared argument is an error rather than an extra. */
  readonly additionalProperties: false;
}

/** What scope the SERVER supplies for a call. Never a model argument. */
export type AiToolScope = "league" | "draft" | "public";

export interface AiToolDefinition {
  readonly name: AiToolName;
  readonly description: string;
  readonly scope: AiToolScope;
  readonly parameters: AiToolParameterSchema;
  /** Read-only is structural: there is no mutating variant of this type. */
  readonly readOnly: true;
}

/**
 * Which deterministic surface a tool result's `inputChecksum` belongs to.
 *
 * ADR 0003 requires an input hash beside the algorithm version. It does not permit two different
 * digests to wear the same name. `decision-snapshot-provenance` is `InSeasonDecisionSnapshot`'s own
 * canonical checksum, passed through unchanged; it is computed with the same function as
 * `recommendation_runs.input_hash` (WP4) but under the `decision-snapshot` scope rather than a run
 * kind, so it is deliberately a different digest from any persisted per-kind run over the same
 * league. Naming the scope says which one a caller is holding, and is what a second tool over a
 * different deterministic surface will extend.
 */
export const aiToolChecksumScopeSchema = z.enum(["decision-snapshot-provenance"]);
export type AiToolChecksumScope = z.infer<typeof aiToolChecksumScopeSchema>;

/** ADR 0003: every tool result carries the identity of the deterministic run behind it. */
export const aiToolProvenanceSchema = z
  .object({
    /** The engine's own version constant, read from the owning package. Never synthesized. */
    algorithmVersion: z.string().min(1).max(120),
    /** …and the checksum of the inputs it was computed from, in the repo's 64-hex convention. */
    inputChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
    checksumScope: aiToolChecksumScopeSchema,
    generatedAt: z.iso.datetime().nullable(),
    warnings: z.array(z.string().min(1).max(300)).max(16),
  })
  .strict();
export type AiToolProvenance = z.infer<typeof aiToolProvenanceSchema>;

export const aiToolDenialCodeSchema = z.enum([
  /** The caller is not a member of the scoped league, or it does not exist. Collapsed on purpose. */
  "NOT_AUTHORIZED",
  /** A declared identifier that does not belong to the request scope, or an unknown tool name. */
  "OUT_OF_SCOPE",
  /** The model's arguments failed the strict parse. No service was touched. */
  "INVALID_ARGUMENTS",
  /** The per-request tool-call budget is spent. */
  "CALL_BUDGET_EXHAUSTED",
  /** The provider returned arguments that are not parseable JSON. */
  "TOOL_ARGUMENTS_UNPARSEABLE",
]);
export type AiToolDenialCode = z.infer<typeof aiToolDenialCodeSchema>;

export type AiToolOutcome =
  | {
      readonly state: "ok";
      /** Already bounded by the tool. Serialized with a hard character cap by the loop. */
      readonly data: unknown;
      readonly provenance: AiToolProvenance;
    }
  | { readonly state: "denied"; readonly code: AiToolDenialCode; readonly message: string }
  | { readonly state: "unavailable"; readonly code: string; readonly message: string };

const aiToolCallReportSchema = z
  .object({
    name: z.enum(AI_TOOL_NAMES),
    state: z.enum(["ok", "denied", "unavailable"]),
    provenance: aiToolProvenanceSchema.nullable(),
  })
  .strict()
  .or(
    z
      .object({
        /** A name the model invented. Reported verbatim-but-bounded so the denial is auditable. */
        name: z.string().min(1).max(120),
        state: z.literal("denied"),
        provenance: z.null(),
      })
      .strict(),
  );
export type AiToolCallReport = z.infer<typeof aiToolCallReportSchema>;

/**
 * How a feature request actually used tools. Every terminal state renders its own sentence on the
 * surface — none of them is a spinner, and none of them is silence.
 */
export const aiToolUseSchema = z.discriminatedUnion("state", [
  /** The feature does not use tools, or the deterministic short-circuit answered for free. */
  z.object({ state: z.literal("not-requested") }).strict(),
  /** The selected model has no tool-use capability. The bounded-context path answered instead. */
  z.object({ state: z.literal("unsupported"), reason: z.string().min(1).max(300) }).strict(),
  /** The daily budget ran out mid-loop. The deterministic result answered. Never a 429. */
  z.object({ state: z.literal("budget-exhausted") }).strict(),
  z.object({ state: z.literal("turn-limit") }).strict(),
  z.object({ state: z.literal("wall-clock") }).strict(),
  z
    .object({
      state: z.literal("used"),
      contractVersion: z.string().min(1).max(40),
      promptVersion: z.string().min(1).max(40),
      calls: z.array(aiToolCallReportSchema).max(16),
    })
    .strict(),
]);
export type AiToolUse = z.infer<typeof aiToolUseSchema>;

/**
 * `AiFeatureResponse.outcome`, widened by one arm.
 *
 * `deterministic` means the model did not write the answer: a pure formatter rendered it from tool
 * results after the budget ran out. It is distinct from `no-action`, which is the zero-cost
 * short-circuit for a genuinely empty engine result.
 */
export const aiFeatureOutcomeWithToolsSchema = z.enum(["generated", "no-action", "deterministic"]);
export type AiFeatureOutcomeWithTools = z.infer<typeof aiFeatureOutcomeWithToolsSchema>;

const lineupToolArgumentsSchema = z
  .object({
    /** Advisory only. The deterministic snapshot decides its own week; a mismatch is reported. */
    week: z.number().int().min(1).max(25).optional(),
  })
  .strict();

const argumentSchemas = {
  get_lineup_recommendation: lineupToolArgumentsSchema,
} as const satisfies Record<AiToolName, z.ZodType>;

/**
 * The strict parser for one tool's model-supplied arguments.
 *
 * Strict is the whole point. `leagueId`, `userId`, and `teamId` are not "ignored extras" — they are
 * a model trying to widen its own scope, and the parse fails so the executor never runs.
 */
export function aiToolArgumentsSchema<Name extends AiToolName>(
  name: Name,
): (typeof argumentSchemas)[Name] {
  return argumentSchemas[name];
}

export const lineupRecommendationTool: AiToolDefinition = {
  name: "get_lineup_recommendation",
  description:
    "Return the deterministic Decision Desk lineup result for the signed-in member's own claimed team in the league this request is scoped to. Returns the optimal start/sit changes, the projected point totals behind them, and the provenance of the projection set used. It cannot read any other league, team, or member.",
  scope: "league",
  parameters: {
    type: "object",
    properties: {
      week: {
        type: "integer",
        description:
          "Optional NFL week to confirm against the snapshot. The server decides the week; supplying a different one does not change what is read.",
        minimum: 1,
        maximum: 25,
      },
    },
    required: [],
    additionalProperties: false,
  },
  readOnly: true,
};

export const AI_TOOL_DEFINITIONS: readonly AiToolDefinition[] = [lineupRecommendationTool];
