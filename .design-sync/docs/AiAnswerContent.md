---
category: Data Display
---
Renders an assistant answer as structured, styled blocks.

Takes the raw answer string and parses it — headings, ordered and unordered
lists, block quotes, fenced code, and inline strong/emphasis/code/links all
render with the design system's typography. It is display-only: it holds no
state and never fetches. Inline source tags the model emits (for example
`[League overview]`) are stripped before rendering, so pass the answer through
unmodified.

```jsx
<AiAnswerContent answer={response.answer} />
```
