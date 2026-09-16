import { describe, expect, it } from "vitest";

import {
  parseWeeklyRecapOutput,
  WEEKLY_RECAP_OUTPUT_INSTRUCTIONS,
} from "./recap-generation-output.js";

const BODY = [
  "## Week 1: The Reckoning",
  "The Dungeon opened its season with a narrow escape: Budget Ballers beat Waiver Theory 112.4–110.2.",
  "The final margin was just 2.2 points, leaving the losing manager to replay every lineup choice until next Sunday.",
].join("\n\n");

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ week: 1, status: "written", body: BODY, ...overrides });
}

describe("weekly recap output contract", () => {
  it("accepts the requested week's complete JSON envelope and returns only Markdown", () => {
    expect(parseWeeklyRecapOutput(envelope(), 1)).toEqual({ state: "written", body: BODY });
    expect(parseWeeklyRecapOutput(`\n ${envelope({ body: `  ${BODY}\n` })} \t`, 1)).toEqual({
      state: "written",
      body: BODY,
    });
  });

  it("accepts one complete JSON Markdown fence", () => {
    expect(parseWeeklyRecapOutput(`\`\`\`json\n${envelope()}\n\`\`\``, 1)).toEqual({
      state: "written",
      body: BODY,
    });
    expect(parseWeeklyRecapOutput(`\`\`\`JSON\r\n${envelope()}\r\n\`\`\``, 1)).toEqual({
      state: "written",
      body: BODY,
    });
  });

  it("rejects the observed plain refusal instead of returning it as a recap", () => {
    const refusal =
      "**Week 2 recap unavailable**\n\nI cannot produce a completed recap because the supplied context does not include a completed Week 2 matchup snapshot. Please refresh the league and try again once all scores are final.";
    expect(parseWeeklyRecapOutput(refusal, 1)).toEqual({ state: "invalid" });
    expect(parseWeeklyRecapOutput(BODY, 1)).toEqual({ state: "invalid" });
  });

  it.each([
    { week: 2 },
    { week: "1" },
    { week: null },
    { status: "unavailable" },
    { status: "refused" },
    { status: "Written" },
    { body: "" },
    { body: " ".repeat(200) },
    { body: "Not enough context to recap this week." },
    { body: 200 },
    { extra: "unexpected provider field" },
  ])("rejects an invalid envelope: %j", (invalid) => {
    expect(parseWeeklyRecapOutput(envelope(invalid), 1)).toEqual({ state: "invalid" });
  });

  it.each([
    "",
    "null",
    "[]",
    "true",
    "{}",
    '{"week":1,"status":"written","body":',
    JSON.stringify(BODY),
    JSON.stringify([{ week: 1, status: "written", body: BODY }]),
  ])("rejects malformed or non-object JSON: %s", (text) => {
    expect(parseWeeklyRecapOutput(text, 1)).toEqual({ state: "invalid" });
  });

  it("rejects prose prefixes, suffixes, extra documents, and unlabeled fences", () => {
    for (const text of [
      `Here is the recap:\n${envelope()}`,
      `${envelope()}\nHope you enjoy it!`,
      `${envelope()}\n${envelope()}`,
      `Here is the recap:\n\`\`\`json\n${envelope()}\n\`\`\``,
      `\`\`\`json\n${envelope()}\n\`\`\`\n\`\`\`json\n${envelope()}\n\`\`\``,
      `\`\`\`\n${envelope()}\n\`\`\``,
    ]) {
      expect(parseWeeklyRecapOutput(text, 1)).toEqual({ state: "invalid" });
    }
  });

  it("bounds the trimmed body and response without exposing invalid provider text", () => {
    expect(parseWeeklyRecapOutput(envelope({ body: "a".repeat(99) }), 1)).toEqual({
      state: "invalid",
    });
    expect(parseWeeklyRecapOutput(envelope({ body: "a".repeat(100) }), 1).state).toBe("written");
    expect(parseWeeklyRecapOutput(envelope({ body: "a".repeat(30_000) }), 1).state).toBe("written");
    expect(parseWeeklyRecapOutput(envelope({ body: "a".repeat(30_001) }), 1)).toEqual({
      state: "invalid",
    });
    expect(parseWeeklyRecapOutput(" ".repeat(200_000), 1)).toEqual({ state: "invalid" });
  });

  it.each([0, 31, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid requested week %s",
    (week) => {
      expect(parseWeeklyRecapOutput(envelope({ week }), week)).toEqual({ state: "invalid" });
    },
  );

  it("instructs providers to label unavailable output separately from written recaps", () => {
    expect(WEEKLY_RECAP_OUTPUT_INSTRUCTIONS).toContain('"status": "written"');
    expect(WEEKLY_RECAP_OUTPUT_INSTRUCTIONS).toContain('"status": "unavailable"');
    expect(WEEKLY_RECAP_OUTPUT_INSTRUCTIONS).toContain("requested recap week");
    expect(WEEKLY_RECAP_OUTPUT_INSTRUCTIONS).toContain("150–250-word");
  });
});
