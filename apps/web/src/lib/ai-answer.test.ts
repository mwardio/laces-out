import { describe, expect, it } from "vitest";

import { aiAnswerForDisplay, parseAiAnswer, parseAiAnswerInline } from "./ai-answer";

describe("AI answer display", () => {
  it("removes inline source tags while preserving the answer structure", () => {
    expect(
      aiAnswerForDisplay(
        "One move: start Johnston. [Decision Desk] [League overview]\n\nCheck again before lock. [League analytics]",
      ),
    ).toBe("One move: start Johnston.\n\nCheck again before lock.");
  });

  it("does not remove unrelated bracketed text", () => {
    expect(aiAnswerForDisplay("Consider the options [A] and [B].")).toBe(
      "Consider the options [A] and [B].",
    );
  });

  it("removes a model-authored sources line when structured source chips already exist", () => {
    expect(
      aiAnswerForDisplay("Hold the roster.\n\n### Sources\n[Decision Desk] · [League overview]"),
    ).toBe("Hold the roster.");
  });

  it("parses headings, emphasis, lists, quotes, and intentional line breaks", () => {
    expect(
      parseAiAnswer(
        "### Week 8 plan\n\n**Priority:** Protect the floor.\nCheck again Sunday.\n\n1. Start Reed\n2. Hold Evans\n\n> Send this offer only if it stays fair.",
      ),
    ).toEqual([
      {
        type: "heading",
        level: 3,
        children: [{ type: "text", value: "Week 8 plan" }],
      },
      {
        type: "paragraph",
        lines: [
          [
            { type: "strong", children: [{ type: "text", value: "Priority:" }] },
            { type: "text", value: " Protect the floor." },
          ],
          [{ type: "text", value: "Check again Sunday." }],
        ],
      },
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", value: "Start Reed" }], [{ type: "text", value: "Hold Evans" }]],
      },
      {
        type: "quote",
        lines: [[{ type: "text", value: "Send this offer only if it stays fair." }]],
      },
    ]);
  });

  it("links only explicit HTTP and HTTPS destinations", () => {
    expect(
      parseAiAnswerInline(
        "Read [the report](https://example.com/report) or https://example.org/news. Never [run this](javascript:alert(1)).",
      ),
    ).toEqual([
      { type: "text", value: "Read " },
      {
        type: "link",
        href: "https://example.com/report",
        children: [{ type: "text", value: "the report" }],
      },
      { type: "text", value: " or " },
      {
        type: "link",
        href: "https://example.org/news",
        children: [{ type: "text", value: "https://example.org/news" }],
      },
      { type: "text", value: ". Never [run this](javascript:alert(1))." },
    ]);
  });

  it("keeps raw model HTML inert as text", () => {
    expect(parseAiAnswerInline('<img src=x onerror="alert(1)"> **Safe**')).toEqual([
      { type: "text", value: '<img src=x onerror="alert(1)"> ' },
      { type: "strong", children: [{ type: "text", value: "Safe" }] },
    ]);
  });
});
