import type { AiProviderName } from "@fantasy/contracts";

export const customModelOption = "__custom-model__" as const;

export interface AiModelOption {
  readonly id: string;
  readonly label: string;
}

export const aiModelOptions: Readonly<Record<AiProviderName, readonly AiModelOption[]>> = {
  openai: [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna · Efficient" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra · Balanced" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol · Maximum capability" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini · Fast" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 Nano · Lowest cost" },
  ],
  anthropic: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5 · Balanced" },
    { id: "claude-fable-5", label: "Claude Fable 5 · Maximum capability" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 · Deep reasoning" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5 · Fastest",
    },
  ],
  gemini: [
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash · Balanced" },
    {
      id: "gemini-3.5-flash-lite",
      label: "Gemini 3.5 Flash-Lite · Fastest",
    },
  ],
  deepseek: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash · Fast and efficient" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro · Maximum capability" },
  ],
  grok: [
    { id: "grok-4.3", label: "Grok 4.3 · Balanced" },
    { id: "grok-4.5", label: "Grok 4.5 · Frontier reasoning" },
  ],
  openrouter: [
    { id: "openrouter/auto", label: "OpenRouter Auto · Smart routing" },
    {
      id: "~openai/gpt-latest",
      label: "Latest OpenAI flagship · Moving alias",
    },
    {
      id: "~anthropic/claude-sonnet-latest",
      label: "Latest Claude Sonnet · Moving alias",
    },
    { id: "openai/gpt-5.6-sol", label: "OpenAI · GPT-5.6 Sol" },
    {
      id: "anthropic/claude-sonnet-5",
      label: "Anthropic · Claude Sonnet 5",
    },
    {
      id: "google/gemini-3.6-flash",
      label: "Google · Gemini 3.6 Flash",
    },
  ],
};

export function isKnownAiModel(provider: AiProviderName, model: string): boolean {
  return aiModelOptions[provider].some((option) => option.id === model);
}
