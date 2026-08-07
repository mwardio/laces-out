---
category: Forms
---
Listbox for choosing which AI provider serves a feature.

A controlled component: it renders `options` in the order given and calls
`onChange` with the chosen provider. Each option carries a `detail` line and an
optional `state` — `ready`, `invalid`, or `idle` — which is how a
missing or rejected API key is surfaced next to the provider name.

```jsx
<AiProviderPicker
  label="Draft assistant"
  value={provider}
  onChange={setProvider}
  options={[
    { provider: "anthropic", detail: "Native Claude Messages API", state: "ready" },
    { provider: "openai", detail: "Native Responses API", state: "idle" },
  ]}
/>
```

Provider display names come from the design system, so pass the bare provider
id (`"anthropic"`, `"openai"`, `"gemini"`, `"deepseek"`, `"grok"`,
`"openrouter"`), never a formatted label.
