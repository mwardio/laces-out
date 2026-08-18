import * as React from 'react';

/**
 * AiProviderPicker — from @laces-out/web@0.1.0.
 */
export interface AiProviderPickerProps {
  options: readonly {
    provider: "openai" | "anthropic" | "gemini" | "deepseek" | "grok" | "openrouter";
    detail: string;
    state?: "ready" | "invalid" | "idle";
  }[];
  value: "openai" | "anthropic" | "gemini" | "deepseek" | "grok" | "openrouter";
  onChange: (provider: "openai" | "anthropic" | "gemini" | "deepseek" | "grok" | "openrouter") => void;
  /** Visible field label. Defaults to "AI provider". */
  label?: string;
  disabled?: boolean;
}

export declare const AiProviderPicker: React.ComponentType<AiProviderPickerProps>;
