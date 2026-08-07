import { AiProviderPicker } from "@laces-out/web";
import { useState } from "react";

/* The picker is controlled, so every cell wraps it in the small amount of
   state a real settings form would own. Details match AI_PROVIDER_META.

   The variant axis here is the SELECTED option's `state`: the collapsed
   trigger renders a status dot from it, so selecting a ready / invalid /
   idle provider is what makes the three states visible. The open listbox
   only exists after a click and cannot be shown in a static card. */

type Provider = "openai" | "anthropic" | "gemini" | "deepseek" | "grok" | "openrouter";

const catalog = [
  { provider: "anthropic" as const, detail: "Native Claude Messages API", state: "ready" as const },
  { provider: "openai" as const, detail: "Native Responses API", state: "ready" as const },
  { provider: "grok" as const, detail: "Key rejected — re-enter it", state: "invalid" as const },
  { provider: "deepseek" as const, detail: "No key saved yet", state: "idle" as const },
];

function Picker({ label, initial }: { label: string; initial: Provider }) {
  const [provider, setProvider] = useState<Provider>(initial);
  return (
    <AiProviderPicker
      label={label}
      options={catalog}
      value={provider}
      onChange={setProvider}
    />
  );
}

export function Ready() {
  return <Picker label="Decision Desk" initial="anthropic" />;
}

export function InvalidKey() {
  return <Picker label="Draft assistant" initial="grok" />;
}

export function NoKeyYet() {
  return <Picker label="Weekly recap" initial="deepseek" />;
}

export function Disabled() {
  return (
    <AiProviderPicker
      label="Trade analyzer"
      options={catalog}
      value="anthropic"
      onChange={() => {}}
      disabled
    />
  );
}
