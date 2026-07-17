import { describe, expect, it, vi, type Mock } from "vitest";

import { createAiProviderAdapters } from "./ai-provider-adapters.js";
import type { AiProviderAdapterError } from "./ai-provider-adapters.js";

const input = {
  apiKey: "secret-provider-key",
  model: "current-model",
  system: "System rules",
  prompt: "League question",
  maxOutputTokens: 321,
  safetyIdentifier: "lo_safe-user",
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requestBody(fetcher: Mock<Fetcher>): Record<string, unknown> {
  const init = fetcher.mock.calls[0]?.[1];
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

describe("AI provider adapters", () => {
  it("uses OpenAI Responses with stateless storage and a privacy-preserving identifier", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output_text: "Start Reed in the flex.",
            usage: {
              input_tokens: 101,
              output_tokens: 19,
              input_tokens_details: { cached_tokens: 20 },
            },
          }),
          { status: 200, headers: { "x-request-id": "req-openai" } },
        ),
      ),
    );
    const result = await createAiProviderAdapters("https://laces.test", fetcher).openai.complete(
      input,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestBody(fetcher)).toMatchObject({
      model: "current-model",
      input: "League question",
      store: false,
      safety_identifier: "lo_safe-user",
      max_output_tokens: 321,
    });
    expect(result).toEqual({
      text: "Start Reed in the flex.",
      requestId: "req-openai",
      inputTokens: 101,
      outputTokens: 19,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    });
  });

  it("uses Anthropic Messages with the native API key and version headers", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_1",
            content: [{ type: "text", text: "Bid 11 percent of FAAB." }],
            usage: {
              input_tokens: 70,
              output_tokens: 12,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 6,
            },
          }),
          { status: 200, headers: { "request-id": "req-anthropic" } },
        ),
      ),
    );
    const result = await createAiProviderAdapters("https://laces.test", fetcher).anthropic.complete(
      input,
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({
      "x-api-key": "secret-provider-key",
      "anthropic-version": "2023-06-01",
    });
    expect(requestBody(fetcher)).toMatchObject({ max_tokens: 321, system: "System rules" });
    expect(result).toMatchObject({
      text: "Bid 11 percent of FAAB.",
      inputTokens: 70,
      outputTokens: 12,
      cacheReadTokens: 4,
      cacheWriteTokens: 6,
    });
  });

  it("uses Gemini Interactions statelessly and reads model-output steps", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "interaction_1",
            steps: [
              { type: "model_output", content: [{ type: "text", text: "Trade is balanced." }] },
            ],
            usage: { total_input_tokens: 88, total_output_tokens: 9, total_cached_tokens: 8 },
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await createAiProviderAdapters("https://laces.test", fetcher).gemini.complete(
      input,
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1/interactions",
    );
    expect(init.headers).toMatchObject({ "x-goog-api-key": "secret-provider-key" });
    expect(requestBody(fetcher)).toMatchObject({
      input: "League question",
      system_instruction: "System rules",
      store: false,
      generation_config: { max_output_tokens: 321 },
    });
    expect(result).toMatchObject({
      text: "Trade is balanced.",
      requestId: "interaction_1",
      inputTokens: 88,
      outputTokens: 9,
      cacheReadTokens: 8,
    });
  });

  it("uses OpenRouter chat completions with app attribution headers", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "or_1",
            choices: [{ message: { content: "Hold the current lineup." } }],
            usage: { prompt_tokens: 45, completion_tokens: 8 },
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await createAiProviderAdapters(
      "https://laces.test",
      fetcher,
    ).openrouter.complete(input);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-provider-key",
      "HTTP-Referer": "https://laces.test",
      "X-OpenRouter-Title": "Laces Out",
    });
    expect(requestBody(fetcher)).toMatchObject({ model: "current-model", max_tokens: 321 });
    expect(result).toMatchObject({ text: "Hold the current lineup.", requestId: "or_1" });
  });

  it("maps rejected keys to a safe error without exposing provider response bodies", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { type: "authentication_error", message: "raw" } }), {
          status: 401,
        }),
      ),
    );

    await expect(
      createAiProviderAdapters("https://laces.test", fetcher).anthropic.complete(input),
    ).rejects.toMatchObject({
      code: "authentication_error",
      credentialInvalid: true,
      statusCode: 422,
    } satisfies Partial<AiProviderAdapterError>);
  });
});
