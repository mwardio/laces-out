import { describe, expect, it } from "vitest";

import { aiModelOptions, isKnownAiModel } from "./ai-model-options.js";

describe("BYOK model options", () => {
  it("offers multiple unique choices for every provider", () => {
    for (const options of Object.values(aiModelOptions)) {
      expect(options.length).toBeGreaterThan(1);
      expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
    }
  });

  it("includes every provider default and preserves custom model IDs", () => {
    expect(isKnownAiModel("openai", "gpt-5.6-luna")).toBe(true);
    expect(isKnownAiModel("anthropic", "claude-sonnet-5")).toBe(true);
    expect(isKnownAiModel("gemini", "gemini-3.6-flash")).toBe(true);
    expect(isKnownAiModel("deepseek", "deepseek-v4-flash")).toBe(true);
    expect(isKnownAiModel("grok", "grok-4.3")).toBe(true);
    expect(isKnownAiModel("openrouter", "~openai/gpt-latest")).toBe(true);
    expect(isKnownAiModel("openrouter", "vendor/future-model")).toBe(false);
  });
});
