import type { AiProviderName } from "@fantasy/contracts";

export interface AiCompletionInput {
  readonly apiKey: string;
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly safetyIdentifier: string;
}

export interface AiCompletionResult {
  readonly text: string;
  readonly requestId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface AiProviderAdapter {
  complete(input: AiCompletionInput): Promise<AiCompletionResult>;
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

class OpenAiAdapter implements AiProviderAdapter {
  readonly #fetcher: typeof fetch;

  constructor(fetcher: typeof fetch) {
    this.#fetcher = fetcher;
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
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
    return {
      text: requireText("openai", outputText),
      requestId: response.headers.get("x-request-id") ?? textValue(root?.id) ?? null,
      inputTokens: tokenCount(usage?.input_tokens),
      outputTokens: tokenCount(usage?.output_tokens),
      cacheReadTokens: tokenCount(inputDetails?.cached_tokens),
      cacheWriteTokens: 0,
    };
  }
}

class AnthropicAdapter implements AiProviderAdapter {
  readonly #fetcher: typeof fetch;

  constructor(fetcher: typeof fetch) {
    this.#fetcher = fetcher;
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
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
    return {
      text: requireText("anthropic", outputText),
      requestId: response.headers.get("request-id") ?? textValue(root?.id) ?? null,
      inputTokens: tokenCount(usage?.input_tokens),
      outputTokens: tokenCount(usage?.output_tokens),
      cacheReadTokens: tokenCount(usage?.cache_read_input_tokens),
      cacheWriteTokens: tokenCount(usage?.cache_creation_input_tokens),
    };
  }
}

class GeminiAdapter implements AiProviderAdapter {
  readonly #fetcher: typeof fetch;

  constructor(fetcher: typeof fetch) {
    this.#fetcher = fetcher;
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
    const { body, response } = await postJson({
      provider: "gemini",
      url: "https://generativelanguage.googleapis.com/v1/interactions",
      headers: { "x-goog-api-key": input.apiKey },
      body: {
        model: input.model,
        input: input.prompt,
        system_instruction: input.system,
        generation_config: { max_output_tokens: input.maxOutputTokens },
        store: false,
      },
      fetcher: this.#fetcher,
    });
    const root = record(body);
    const outputText = list(root?.steps)
      .map((item) => record(item))
      .filter((item) => item?.type === "model_output")
      .flatMap((item) => list(item?.content))
      .map((item) => record(item))
      .filter((item) => item?.type === "text")
      .map((item) => textValue(item?.text))
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const usage = record(root?.usage);
    return {
      text: requireText("gemini", outputText),
      requestId: response.headers.get("x-request-id") ?? textValue(root?.id) ?? null,
      inputTokens: tokenCount(usage?.total_input_tokens),
      outputTokens: tokenCount(usage?.total_output_tokens),
      cacheReadTokens: tokenCount(usage?.total_cached_tokens),
      cacheWriteTokens: 0,
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

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
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
    return {
      text: requireText("openrouter", outputText),
      requestId: response.headers.get("x-request-id") ?? textValue(root?.id) ?? null,
      inputTokens: tokenCount(usage?.prompt_tokens),
      outputTokens: tokenCount(usage?.completion_tokens),
      cacheReadTokens: tokenCount(promptDetails?.cached_tokens),
      cacheWriteTokens: 0,
    };
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
