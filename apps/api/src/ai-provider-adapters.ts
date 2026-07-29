import type { AiProviderName, AiToolParameterSchema } from "@fantasy/contracts";

/**
 * Provider capability matrix.
 *
 * A model that cannot call tools must say so rather than silently answering without them, so the
 * surface can tell the member why the answer is thinner than usual.
 */
export interface AiProviderCapabilities {
  readonly toolUse: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly modelSelection: boolean;
}

export interface AiToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: AiToolParameterSchema;
}

export interface AiProviderToolCall {
  /** Provider call id. Empty string when the provider omits one. */
  readonly callId: string;
  readonly name: string;
  /** Parsed JSON. UNTRUSTED. `undefined` when the provider sent unparseable arguments. */
  readonly argumentsValue: unknown;
}

export interface AiToolResultInput {
  readonly callId: string;
  readonly name: string;
  readonly resultJson: string;
}

/**
 * Opaque, adapter-owned resume handle. The orchestrator must never inspect it — Gemini needs
 * `previous_interaction_id`, and the message-shaped providers need the accumulated transcript.
 */
export type AiConversationState =
  | { readonly kind: "gemini-interaction"; readonly previousInteractionId: string }
  | { readonly kind: "messages"; readonly messages: readonly unknown[] };

export interface AiCompletionInput {
  readonly apiKey: string;
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly safetyIdentifier: string;
  readonly tools?: readonly AiToolSpec[];
  readonly toolChoice?: "auto" | "none";
  /** Present on every turn after the first. */
  readonly conversation?: AiConversationState;
  /** Results for the tool calls returned by the previous turn. */
  readonly toolResults?: readonly AiToolResultInput[];
}

export interface AiCompletionResult {
  readonly text: string;
  readonly requestId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Defaults to `[]`, so every existing non-tool call site keeps working unchanged. */
  readonly toolCalls: readonly AiProviderToolCall[];
  readonly stopReason: "end" | "tool-calls" | "length";
  readonly conversation: AiConversationState | null;
}

export interface AiProviderAdapter {
  complete(input: AiCompletionInput): Promise<AiCompletionResult>;
  capabilities(model: string): AiProviderCapabilities;
}

export class AiProviderAdapterError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly credentialInvalid: boolean;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly statusCode: number;
    readonly credentialInvalid?: boolean;
  }) {
    super(input.message);
    this.name = "AiProviderAdapterError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.credentialInvalid = input.credentialInvalid ?? false;
  }
}

type JsonRecord = Record<string, unknown>;

const PROVIDER_TIMEOUT_MS = 30_000;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function providerErrorCode(body: unknown, status: number): string {
  const root = record(body);
  const error = record(root?.error);
  const code = textValue(error?.code) ?? textValue(error?.type);
  return (code ?? `HTTP_${status}`).slice(0, 120);
}

function providerErrorMessage(provider: AiProviderName, status: number): string {
  if (status === 401 || status === 403) {
    return `${provider} rejected this API key. Check the key and its project permissions.`;
  }
  if (status === 429) {
    return `${provider} rate-limited the request or the account has no available quota.`;
  }
  if (status === 404) {
    return `${provider} could not find that model. Check the configured model ID.`;
  }
  return `${provider} could not complete the request (HTTP ${status}).`;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function postJson(input: {
  readonly provider: AiProviderName;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly fetcher: typeof fetch;
}): Promise<{ readonly body: unknown; readonly response: Response }> {
  let response: Response;
  try {
    response = await input.fetcher(input.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...input.headers,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new AiProviderAdapterError({
      code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      message: timedOut
        ? `${input.provider} did not respond within ${PROVIDER_TIMEOUT_MS / 1_000} seconds.`
        : `${input.provider} could not be reached.`,
      statusCode: 502,
    });
  }
  const body = await parseJson(response);
  if (!response.ok) {
    throw new AiProviderAdapterError({
      code: providerErrorCode(body, response.status),
      message: providerErrorMessage(input.provider, response.status),
      statusCode: response.status === 401 || response.status === 403 ? 422 : 502,
      credentialInvalid: response.status === 401 || response.status === 403,
    });
  }
  return { body, response };
}

function requireText(provider: AiProviderName, value: string | undefined): string {
  if (value) return value;
  throw new AiProviderAdapterError({
    code: "EMPTY_RESPONSE",
    message: `${provider} returned no readable text.`,
    statusCode: 502,
  });
}

/**
 * What each provider adapter in THIS repository can actually do — not what the vendor's API can do
 * in principle.
 *
 * Gemini is the only adapter with a tool path today. OpenAI, Anthropic, and
 * OpenRouter report `toolUse: false` and refuse a `tools` argument rather than dropping it
 * silently, so a BYOK member is told why their answer used the bounded-context path instead of
 * being left to wonder. Unknown models fail closed for the same reason.
 */
const GEMINI_TOOL_MODEL_PATTERN = /^gemini-3(?:\.\d+)?-/u;

const PROVIDER_CAPABILITY_DEFAULTS: Readonly<Record<AiProviderName, AiProviderCapabilities>> = {
  // Managed access pins the model, so the member cannot select one.
  gemini: { toolUse: false, structuredOutput: true, streaming: true, modelSelection: false },
  openai: { toolUse: false, structuredOutput: true, streaming: true, modelSelection: true },
  anthropic: { toolUse: false, structuredOutput: true, streaming: true, modelSelection: true },
  openrouter: { toolUse: false, structuredOutput: false, streaming: true, modelSelection: true },
};

export function aiProviderCapabilities(
  provider: AiProviderName,
  model: string,
): AiProviderCapabilities {
  const defaults = PROVIDER_CAPABILITY_DEFAULTS[provider];
  if (provider === "gemini" && GEMINI_TOOL_MODEL_PATTERN.test(model)) {
    return { ...defaults, toolUse: true };
  }
  return defaults;
}

/**
 * A `tools` argument sent to a model whose matrix entry says `toolUse: false` is a wiring bug, and
 * a wiring bug that silently produced an ungrounded answer would be the worst possible failure
 * mode here. Fail loudly, before the request leaves the process.
 */
function assertToolsSupported(
  provider: AiProviderName,
  model: string,
  input: AiCompletionInput,
): void {
  if (!input.tools?.length && !input.toolResults?.length) return;
  if (aiProviderCapabilities(provider, model).toolUse) return;
  throw new AiProviderAdapterError({
    code: "TOOL_USE_UNSUPPORTED",
    message: `The ${provider} adapter cannot use deterministic tools with model ${model}.`,
    statusCode: 422,
  });
}

/** The non-tool result shape, so existing call sites read identically to before. */
function plainResult(
  base: Omit<AiCompletionResult, "toolCalls" | "stopReason" | "conversation">,
): AiCompletionResult {
  return { ...base, toolCalls: [], stopReason: "end", conversation: null };
}

class OpenAiAdapter implements AiProviderAdapter {
  readonly #fetcher: typeof fetch;

  constructor(fetcher: typeof fetch) {
    this.#fetcher = fetcher;
  }

  capabilities(model: string): AiProviderCapabilities {
    return aiProviderCapabilities("openai", model);
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
    assertToolsSupported("openai", input.model, input);
    const { body, response } = await postJson({
      provider: "openai",
      url: "https://api.openai.com/v1/responses",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: {
        model: input.model,
        instructions: input.system,
        input: input.prompt,
        max_output_tokens: input.maxOutputTokens,
        safety_identifier: input.safetyIdentifier,
        store: false,
      },
      fetcher: this.#fetcher,
    });
    const root = record(body);
    const outputText =
      textValue(root?.output_text) ??
      list(root?.output)
        .flatMap((item) => list(record(item)?.content))
        .map((item) => record(item))
        .filter((item) => item?.type === "output_text")
        .map((item) => textValue(item?.text))
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
    const usage = record(root?.usage);
    const inputDetails = record(usage?.input_tokens_details);
    return plainResult({
      text: requireText("openai", outputText),
      requestId: response.headers.get("x-request-id") ?? textValue(root?.id) ?? null,
      inputTokens: tokenCount(usage?.input_tokens),
      outputTokens: tokenCount(usage?.output_tokens),
      cacheReadTokens: tokenCount(inputDetails?.cached_tokens),
      cacheWriteTokens: 0,
    });
  }
}

class AnthropicAdapter implements AiProviderAdapter {
  readonly #fetcher: typeof fetch;

  constructor(fetcher: typeof fetch) {
    this.#fetcher = fetcher;
  }

  capabilities(model: string): AiProviderCapabilities {
    return aiProviderCapabilities("anthropic", model);
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
    assertToolsSupported("anthropic", input.model, input);
    const { body, response } = await postJson({
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
      body: {
        model: input.model,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
        max_tokens: input.maxOutputTokens,
      },
      fetcher: this.#fetcher,
    });
    const root = record(body);
    const outputText = list(root?.content)
      .map((item) => record(item))
      .filter((item) => item?.type === "text")
      .map((item) => textValue(item?.text))
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const usage = record(root?.usage);
    return plainResult({
      text: requireText("anthropic", outputText),
      requestId: response.headers.get("request-id") ?? textValue(root?.id) ?? null,
      inputTokens: tokenCount(usage?.input_tokens),
      outputTokens: tokenCount(usage?.output_tokens),
      cacheReadTokens: tokenCount(usage?.cache_read_input_tokens),
      cacheWriteTokens: tokenCount(usage?.cache_creation_input_tokens),
    });
  }
}

/**
 * Gemini Interactions, with function calling.
 *
 * Endpoint discipline, checked live against
 * `https://ai.google.dev/gemini-api/docs/function-calling` on 2026-07-27 (page reports itself last
 * updated 2026-07-21 UTC): function calling is documented on `/v1beta/interactions`. The existing
 * non-tool path stays on `/v1/interactions` byte for byte, because moving a shipped path to a beta
 * version is a behavior change nobody asked for and this build cannot verify against live traffic.
 * Only a request that actually carries `tools` or `toolResults` goes to `/v1beta`.
 */
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1/interactions";
const GEMINI_TOOL_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

class GeminiAdapter implements AiProviderAdapter {
  readonly #fetcher: typeof fetch;

  constructor(fetcher: typeof fetch) {
    this.#fetcher = fetcher;
  }

  capabilities(model: string): AiProviderCapabilities {
    return aiProviderCapabilities("gemini", model);
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
    assertToolsSupported("gemini", input.model, input);
    const usesTools = Boolean(input.tools?.length || input.toolResults?.length);
    // Documented shape: `{ type: "function_result", name, call_id, result: [{type:"text",text}] }`.
    const toolResultTurn = input.toolResults?.map((result) => ({
      type: "function_result",
      name: result.name,
      call_id: result.callId,
      result: [{ type: "text", text: result.resultJson }],
    }));
    const { body, response } = await postJson({
      provider: "gemini",
      url: usesTools ? GEMINI_TOOL_INTERACTIONS_URL : GEMINI_INTERACTIONS_URL,
      headers: { "x-goog-api-key": input.apiKey },
      body: {
        model: input.model,
        input: toolResultTurn?.length ? toolResultTurn : input.prompt,
        system_instruction: input.system,
        generation_config: {
          max_output_tokens: input.maxOutputTokens,
          // `tool_choice` lives inside generation_config, not at the top level. It is sent only to
          // shut tools off; `auto` is the documented default and needs no field.
          ...(input.toolChoice === "none"
            ? { tool_choice: { allowed_tools: { mode: "none", tools: [] } } }
            : {}),
        },
        store: false,
        // Flat declarations — there is no `functionDeclarations` wrapper on this surface.
        ...(input.tools?.length
          ? {
              tools: input.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            }
          : {}),
        ...(input.conversation?.kind === "gemini-interaction"
          ? { previous_interaction_id: input.conversation.previousInteractionId }
          : {}),
      },
      fetcher: this.#fetcher,
    });
    const root = record(body);
    const steps = list(root?.steps).map((item) => record(item));
    const outputText = steps
      .filter((item) => item?.type === "model_output")
      .flatMap((item) => list(item?.content))
      .map((item) => record(item))
      .filter((item) => item?.type === "text")
      .map((item) => textValue(item?.text))
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const toolCalls = steps
      .filter((item) => item?.type === "function_call")
      .map((item) => ({
        callId: textValue(item?.id) ?? "",
        name: textValue(item?.name) ?? "",
        argumentsValue: record(item?.arguments) ?? undefined,
      }))
      .filter((call) => call.name.length > 0);
    const usage = record(root?.usage);
    const interactionId = textValue(root?.id);
    return {
      // A turn that only asks for a tool legitimately carries no prose. Requiring text there would
      // turn a normal tool call into a provider error.
      text: toolCalls.length > 0 ? (outputText ?? "") : requireText("gemini", outputText),
      requestId: response.headers.get("x-request-id") ?? interactionId ?? null,
      inputTokens: tokenCount(usage?.total_input_tokens),
      outputTokens: tokenCount(usage?.total_output_tokens),
      cacheReadTokens: tokenCount(usage?.total_cached_tokens),
      cacheWriteTokens: 0,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool-calls" : "end",
      conversation: interactionId
        ? { kind: "gemini-interaction", previousInteractionId: interactionId }
        : null,
    };
  }
}

class OpenRouterAdapter implements AiProviderAdapter {
  readonly #fetcher: typeof fetch;
  readonly #webUrl: string;

  constructor(fetcher: typeof fetch, webUrl: string) {
    this.#fetcher = fetcher;
    this.#webUrl = webUrl;
  }

  capabilities(model: string): AiProviderCapabilities {
    return aiProviderCapabilities("openrouter", model);
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
    assertToolsSupported("openrouter", input.model, input);
    const { body, response } = await postJson({
      provider: "openrouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "HTTP-Referer": this.#webUrl,
        "X-OpenRouter-Title": "Laces Out",
      },
      body: {
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        max_tokens: input.maxOutputTokens,
      },
      fetcher: this.#fetcher,
    });
    const root = record(body);
    const firstChoice = record(list(root?.choices)[0]);
    const message = record(firstChoice?.message);
    const rawContent = message?.content;
    const outputText =
      textValue(rawContent) ??
      list(rawContent)
        .map((item) => record(item))
        .map((item) => textValue(item?.text))
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
    const usage = record(root?.usage);
    const promptDetails = record(usage?.prompt_tokens_details);
    return plainResult({
      text: requireText("openrouter", outputText),
      requestId: response.headers.get("x-request-id") ?? textValue(root?.id) ?? null,
      inputTokens: tokenCount(usage?.prompt_tokens),
      outputTokens: tokenCount(usage?.completion_tokens),
      cacheReadTokens: tokenCount(promptDetails?.cached_tokens),
      cacheWriteTokens: 0,
    });
  }
}

export function createAiProviderAdapters(
  webUrl: string,
  fetcher: typeof fetch = fetch,
): Readonly<Record<AiProviderName, AiProviderAdapter>> {
  return {
    openai: new OpenAiAdapter(fetcher),
    anthropic: new AnthropicAdapter(fetcher),
    gemini: new GeminiAdapter(fetcher),
    openrouter: new OpenRouterAdapter(fetcher, webUrl),
  };
}
