import type { AiToolDenialCode, AiToolName, AiToolOutcome } from "@fantasy/contracts";

import { neutralizeLeagueDataDelimiters } from "./ai-bounded-text.js";
import type {
  AiCompletionInput,
  AiProviderAdapter,
  AiProviderToolCall,
  AiToolSpec,
} from "./ai-provider-adapters.js";
import type { AiExecutableTool, AiToolContext } from "./ai-tool-registry.js";

/**
 * The bounded orchestration loop.
 *
 * The provider never runs the loop; we do. Every ceiling below exists because a model that can ask
 * for one more tool result can ask for a thousand, and each request costs a reserved daily-budget
 * slot. Every exit path returns the same result object, so a caller never has to branch on an
 * exception to find out whether it got an answer.
 */
export const AI_TOOL_LOOP_LIMITS = {
  /** Model invocations per feature request, including the final summarizing turn. */
  maxModelTurns: 4,
  /** Tool executions across the whole request. */
  maxToolCalls: 6,
  /** Executions of any single tool, so a loop cannot re-ask forever. */
  maxCallsPerTool: 2,
  /** Serialized characters returned to the model for one tool result. */
  maxToolResultChars: 12_000,
  /** Serialized characters returned across all tool results in one request. */
  maxTotalToolResultChars: 32_000,
  /** Wall-clock budget for the whole loop, provider time included. */
  wallClockMs: 45_000,
} as const;

export interface AiTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** One reserved model invocation, so the caller can finalize the ledger row it reserved for it. */
export interface AiToolLoopTurn {
  readonly index: number;
  readonly reservationId: string;
  readonly usage: AiTurnUsage;
  readonly requestId: string | null;
}

export interface AiToolLoopResult {
  readonly outcome: "answered" | "budget-exhausted" | "turn-limit" | "wall-clock";
  readonly answer: string;
  readonly modelTurns: number;
  readonly turns: readonly AiToolLoopTurn[];
  readonly toolResults: readonly AiToolLoopCall[];
  readonly deniedCodes: readonly string[];
  readonly usage: AiTurnUsage;
  readonly requestIds: readonly string[];
}

export interface AiToolLoopCall {
  readonly name: string;
  readonly outcome: AiToolOutcome;
  /** Exactly what was handed back to the model: neutralized, capped, and possibly truncated. */
  readonly resultJson: string;
}

export interface AiToolLoopInput {
  readonly adapter: Pick<AiProviderAdapter, "complete" | "capabilities">;
  readonly tools: ReadonlyMap<AiToolName, AiExecutableTool>;
  readonly context: AiToolContext;
  readonly completionInput: Omit<AiCompletionInput, "tools" | "conversation" | "toolResults">;
  /**
   * Reserves one daily-budget slot for one model turn. Rejecting with `code === "DAILY_LIMIT"` is
   * the documented, expected way to say "no budget left"; the loop degrades rather than failing.
   */
  readonly reserveTurn: (turn: number) => Promise<string>;
  readonly now: () => Date;
}

function isDailyLimit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "DAILY_LIMIT"
  );
}

function toolSpecs(tools: ReadonlyMap<AiToolName, AiExecutableTool>): readonly AiToolSpec[] {
  return [...tools.values()].map((tool) => ({
    name: tool.definition.name,
    description: tool.definition.description,
    parameters: tool.definition.parameters,
  }));
}

/**
 * A tool result is untrusted content the moment it contains a synced string, so it gets the same
 * delimiter scrubbing the context blob already gets before it re-enters the prompt.
 */
function serializeOutcome(outcome: AiToolOutcome, budgetChars: number): string {
  const raw = JSON.stringify(outcome) ?? '{"state":"unavailable"}';
  const neutralized = neutralizeLeagueDataDelimiters(raw);
  const cap = Math.min(AI_TOOL_LOOP_LIMITS.maxToolResultChars, Math.max(0, budgetChars));
  if (neutralized.length <= cap) return neutralized;
  return JSON.stringify({
    state: "unavailable",
    code: "RESULT_TRUNCATED",
    message: "The deterministic result did not fit inside this request's tool-result budget.",
  });
}

function denial(code: AiToolDenialCode, message: string): AiToolOutcome {
  return { state: "denied", code, message };
}

export async function runAiToolLoop(input: AiToolLoopInput): Promise<AiToolLoopResult> {
  const startedAt = input.now().getTime();
  const specs = toolSpecs(input.tools);
  const toolResults: AiToolLoopCall[] = [];
  const deniedCodes: string[] = [];
  const requestIds: string[] = [];
  const callsPerTool = new Map<string, number>();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const turns: AiToolLoopTurn[] = [];
  let totalResultChars = 0;
  let answer = "";
  let conversation: AiCompletionInput["conversation"];
  let pendingResults: AiCompletionInput["toolResults"];
  let modelTurns = 0;

  const finish = (outcome: AiToolLoopResult["outcome"]): AiToolLoopResult => ({
    outcome,
    answer,
    modelTurns,
    turns,
    toolResults,
    deniedCodes,
    usage,
    requestIds,
  });

  for (let turn = 1; turn <= AI_TOOL_LOOP_LIMITS.maxModelTurns; turn += 1) {
    if (input.now().getTime() - startedAt >= AI_TOOL_LOOP_LIMITS.wallClockMs) {
      return finish("wall-clock");
    }

    // Every model invocation reserves its own slot — not merely the original feature request.
    let reservationId: string;
    try {
      reservationId = await input.reserveTurn(turn);
    } catch (error) {
      if (isDailyLimit(error)) return finish("budget-exhausted");
      throw error;
    }

    modelTurns = turn;
    const completion = await input.adapter.complete({
      ...input.completionInput,
      tools: specs,
      toolChoice: "auto",
      ...(conversation ? { conversation } : {}),
      ...(pendingResults ? { toolResults: pendingResults } : {}),
    });
    usage.inputTokens += completion.inputTokens;
    usage.outputTokens += completion.outputTokens;
    usage.cacheReadTokens += completion.cacheReadTokens;
    usage.cacheWriteTokens += completion.cacheWriteTokens;
    turns.push({
      index: turn,
      reservationId,
      usage: {
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        cacheReadTokens: completion.cacheReadTokens,
        cacheWriteTokens: completion.cacheWriteTokens,
      },
      requestId: completion.requestId,
    });
    if (completion.requestId) requestIds.push(completion.requestId);
    if (completion.text) answer = completion.text;

    if (completion.stopReason !== "tool-calls" || completion.toolCalls.length === 0) {
      return finish("answered");
    }

    conversation = completion.conversation ?? conversation;
    const results: { callId: string; name: string; resultJson: string }[] = [];
    for (const call of completion.toolCalls) {
      const outcome = await executeCall({
        call,
        tools: input.tools,
        context: input.context,
        toolResults,
        callsPerTool,
      });
      if (outcome.state === "denied") deniedCodes.push(outcome.code);
      const remaining = AI_TOOL_LOOP_LIMITS.maxTotalToolResultChars - totalResultChars;
      const resultJson = serializeOutcome(outcome, remaining);
      totalResultChars += resultJson.length;
      toolResults.push({ name: call.name, outcome, resultJson });
      results.push({ callId: call.callId, name: call.name, resultJson });
    }
    pendingResults = results;

    if (input.now().getTime() - startedAt >= AI_TOOL_LOOP_LIMITS.wallClockMs) {
      return finish("wall-clock");
    }
  }

  return finish("turn-limit");
}

async function executeCall(input: {
  readonly call: AiProviderToolCall;
  readonly tools: ReadonlyMap<AiToolName, AiExecutableTool>;
  readonly context: AiToolContext;
  readonly toolResults: readonly AiToolLoopCall[];
  readonly callsPerTool: Map<string, number>;
}): Promise<AiToolOutcome> {
  const tool = input.tools.get(input.call.name as AiToolName);
  if (!tool) {
    // A name the model invented, or one it read out of untrusted content. Never an exception.
    return denial(
      "OUT_OF_SCOPE",
      `There is no tool named ${JSON.stringify(input.call.name).slice(0, 120)} in this request's fixed tool list.`,
    );
  }
  if (input.toolResults.length >= AI_TOOL_LOOP_LIMITS.maxToolCalls) {
    return denial("CALL_BUDGET_EXHAUSTED", "This request's tool-call budget is spent.");
  }
  const used = input.callsPerTool.get(input.call.name) ?? 0;
  if (used >= AI_TOOL_LOOP_LIMITS.maxCallsPerTool) {
    return denial(
      "CALL_BUDGET_EXHAUSTED",
      `${input.call.name} has already run ${AI_TOOL_LOOP_LIMITS.maxCallsPerTool} times in this request. Answer from the results you already have.`,
    );
  }
  if (input.call.argumentsValue === undefined) {
    return denial(
      "TOOL_ARGUMENTS_UNPARSEABLE",
      "The tool arguments were not parseable JSON. Retry with a valid arguments object.",
    );
  }
  input.callsPerTool.set(input.call.name, used + 1);
  return tool.execute(input.context, input.call.argumentsValue);
}
