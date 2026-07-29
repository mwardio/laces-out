import { describe, expect, it, vi, type Mock } from "vitest";

import { createAiProviderAdapters } from "./ai-provider-adapters.js";
import type { AiProviderAdapterError, AiToolSpec } from "./ai-provider-adapters.js";

const input = {
  apiKey: "secret-provider-key",
  model: "current-model",
  system: "System rules",
  prompt: "League question",
  maxOutputTokens: 321,
  safetyIdentifier: "lo_safe-user",
};

const LINEUP_TOOL_SPEC = {
  name: "get_lineup_recommendation",
  description: "Return the deterministic lineup result for the member's claimed team.",
  parameters: {
    type: "object",
    properties: { week: { type: "integer", description: "NFL week" } },
    required: [],
    additionalProperties: false,
  },
} as const satisfies AiToolSpec;

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
      toolCalls: [],
      stopReason: "end",
      conversation: null,
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

  it("sends Gemini function declarations and reads a function_call step", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "interaction_1",
            steps: [
              {
                type: "function_call",
                id: "call_1",
                name: "get_lineup_recommendation",
                arguments: { week: 3 },
              },
            ],
            usage: { total_input_tokens: 90, total_output_tokens: 12, total_cached_tokens: 0 },
          }),
          { status: 200, headers: { "x-request-id": "req-gemini" } },
        ),
      ),
    );
    const adapter = createAiProviderAdapters("https://laces.test", fetcher).gemini;

    const result = await adapter.complete({
      ...input,
      model: "gemini-3.6-flash",
      tools: [LINEUP_TOOL_SPEC],
      toolChoice: "auto",
    });

    // Function calling is documented on /v1beta/interactions; the non-tool path stays on /v1.
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(requestBody(fetcher)).toMatchObject({
      model: "gemini-3.6-flash",
      store: false,
      tools: [
        {
          type: "function",
          name: "get_lineup_recommendation",
          parameters: { additionalProperties: false },
        },
      ],
    });
    // `auto` is the documented default, so no tool_choice is sent for it.
    expect(requestBody(fetcher).generation_config).not.toHaveProperty("tool_choice");
    expect(result.stopReason).toBe("tool-calls");
    expect(result.toolCalls).toEqual([
      { callId: "call_1", name: "get_lineup_recommendation", argumentsValue: { week: 3 } },
    ]);
    expect(result.conversation).toEqual({
      kind: "gemini-interaction",
      previousInteractionId: "interaction_1",
    });
    // A tool-only turn carries no prose, and that is not a provider error.
    expect(result.text).toBe("");
  });

  it("returns a Gemini function_result and links it to the prior interaction", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "interaction_2",
            steps: [{ type: "model_output", content: [{ type: "text", text: "Start Reed." }] }],
            usage: { total_input_tokens: 130, total_output_tokens: 9, total_cached_tokens: 0 },
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createAiProviderAdapters("https://laces.test", fetcher).gemini;

    const result = await adapter.complete({
      ...input,
      model: "gemini-3.6-flash",
      conversation: { kind: "gemini-interaction", previousInteractionId: "interaction_1" },
      toolResults: [
        { callId: "call_1", name: "get_lineup_recommendation", resultJson: '{"lineup":{}}' },
      ],
    });

    expect(requestBody(fetcher)).toMatchObject({
      previous_interaction_id: "interaction_1",
      input: [
        {
          type: "function_result",
          name: "get_lineup_recommendation",
          call_id: "call_1",
          result: [{ type: "text", text: '{"lineup":{}}' }],
        },
      ],
    });
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("Start Reed.");
    expect(result.toolCalls).toEqual([]);
  });

  it("publishes a capability matrix and refuses tools a model cannot use", async () => {
    const fetcher = vi.fn<Fetcher>();
    const adapters = createAiProviderAdapters("https://laces.test", fetcher);

    expect(adapters.gemini.capabilities("gemini-3.6-flash")).toEqual({
      toolUse: true,
      structuredOutput: true,
      streaming: true,
      modelSelection: false,
    });
    // Fail closed: an unrecognized model is assumed unable to call tools.
    expect(adapters.gemini.capabilities("gemini-2.0-legacy").toolUse).toBe(false);
    expect(adapters.openrouter.capabilities("some/unknown-model").toolUse).toBe(false);
    // WP7 ships no BYOK tool path, and the matrix says so rather than implying one.
    expect(adapters.openai.capabilities("gpt-5.6-luna").toolUse).toBe(false);
    expect(adapters.anthropic.capabilities("claude-sonnet-5").toolUse).toBe(false);

    for (const provider of ["openai", "anthropic", "openrouter"] as const) {
      await expect(
        adapters[provider].complete({ ...input, tools: [LINEUP_TOOL_SPEC] }),
      ).rejects.toMatchObject({ code: "TOOL_USE_UNSUPPORTED", statusCode: 422 });
    }
    await expect(
      adapters.gemini.complete({
        ...input,
        model: "gemini-2.0-legacy",
        tools: [LINEUP_TOOL_SPEC],
      }),
    ).rejects.toMatchObject({ code: "TOOL_USE_UNSUPPORTED", statusCode: 422 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves the existing non-tool completion path byte-identical", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "interaction_0",
            steps: [{ type: "model_output", content: [{ type: "text", text: "Plain answer." }] }],
            usage: { total_input_tokens: 5, total_output_tokens: 2, total_cached_tokens: 0 },
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await createAiProviderAdapters("https://laces.test", fetcher).gemini.complete({
      ...input,
      model: "gemini-3.6-flash",
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1/interactions",
    );
    expect(requestBody(fetcher)).not.toHaveProperty("tools");
    expect(requestBody(fetcher)).not.toHaveProperty("previous_interaction_id");
    expect(result).toMatchObject({ text: "Plain answer.", toolCalls: [], stopReason: "end" });
  });
});
