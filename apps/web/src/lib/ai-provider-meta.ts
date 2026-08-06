import type { AiProviderName } from "@laces-out/contracts";

export interface AiProviderMeta {
  readonly name: string;
  readonly shortName: string;
  readonly description: string;
  readonly keyUrl: string;
}

export const AI_PROVIDER_ORDER: readonly AiProviderName[] = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "grok",
  "openrouter",
];

export const AI_PROVIDER_META: Readonly<Record<AiProviderName, AiProviderMeta>> = {
  openai: {
    name: "OpenAI",
    shortName: "OA",
    description: "Native Responses API",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    name: "Anthropic",
    shortName: "AN",
    description: "Native Claude Messages API",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    name: "Google Gemini",
    shortName: "G",
    description: "Native Interactions API",
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  deepseek: {
    name: "DeepSeek",
    shortName: "DS",
    description: "Native DeepSeek Chat API",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  grok: {
    name: "Grok",
    shortName: "X",
    description: "Native xAI Chat API",
    keyUrl: "https://console.x.ai/",
  },
  openrouter: {
    name: "OpenRouter",
    shortName: "OR",
    description: "One key, broad model catalog",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
};
