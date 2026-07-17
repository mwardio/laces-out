import { describe, expect, it } from "vitest";

import { aiAnswerForDisplay } from "./ai-answer";

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
});
