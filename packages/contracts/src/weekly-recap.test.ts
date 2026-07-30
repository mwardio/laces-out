import { describe, expect, it } from "vitest";

import {
  leagueRecapResponseSchema,
  PERSONA_CARD_MAX_LENGTH,
  recapGenerateRequestSchema,
  recapPersonaCardListSchema,
  recapPersonaCardSaveRequestSchema,
  recapSettingsSaveRequestSchema,
  recapSpiceLevelSchema,
  weeklyRecapSchema,
} from "./weekly-recap.js";

const RECAP = {
  week: 5,
  body: "### Week 5\n\nBudget Ballers lost a winnable one.",
  provider: "gemini",
  model: "gemini-3.6-flash",
  spiceLevel: "scorched",
  generatedByDisplayName: "League Guru",
  generatedAt: "2026-10-07T16:20:00.000Z",
};

describe("weekly recap contracts", () => {
  it("accepts a stored recap and its league envelope", () => {
    expect(weeklyRecapSchema.parse(RECAP)).toEqual(RECAP);
    const envelope = {
      leagueId: "71000000-0000-4000-8000-000000000001",
      week: 5,
      configuredSpiceLevel: "medium",
      generation: { state: "available" },
      recap: RECAP,
    };
    expect(leagueRecapResponseSchema.parse(envelope)).toEqual(envelope);
    expect(
      leagueRecapResponseSchema.parse({
        ...envelope,
        generation: {
          state: "unavailable",
          reasons: [{ code: "AWARDS_WEEK_UNAVAILABLE", message: "Week 5 is not final." }],
        },
        recap: null,
      }).recap,
    ).toBeNull();
  });

  it("carries a retry hint for in-progress and cooldown generation", () => {
    const envelope = {
      leagueId: "71000000-0000-4000-8000-000000000001",
      week: 5,
      configuredSpiceLevel: "medium",
      generation: { state: "in-progress", retryAfterSeconds: 12 },
      recap: null,
    };
    expect(leagueRecapResponseSchema.parse(envelope)).toEqual(envelope);
    expect(
      leagueRecapResponseSchema.safeParse({
        ...envelope,
        generation: { state: "cooldown" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown spice levels and extra keys", () => {
    expect(recapSpiceLevelSchema.safeParse("nuclear").success).toBe(false);
    expect(weeklyRecapSchema.safeParse({ ...RECAP, extra: true }).success).toBe(false);
  });

  it("accepts every supported AI provider", () => {
    for (const provider of ["openai", "anthropic", "gemini", "deepseek", "grok", "openrouter"]) {
      expect(weeklyRecapSchema.safeParse({ ...RECAP, provider }).success).toBe(true);
    }
  });

  it("bounds the persona card body at the shared cap", () => {
    expect(PERSONA_CARD_MAX_LENGTH).toBe(500);
    expect(recapPersonaCardSaveRequestSchema.parse({ body: "  Fears the Horseshoe.  " }).body).toBe(
      "Fears the Horseshoe.",
    );
    expect(recapPersonaCardSaveRequestSchema.safeParse({ body: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(recapPersonaCardSaveRequestSchema.safeParse({ body: "   " }).success).toBe(false);
  });

  it("lists one entry per team with a nullable card body", () => {
    const list = {
      leagueId: "71000000-0000-4000-8000-000000000001",
      cards: [
        {
          teamId: "71000000-0000-4000-8000-000000000010",
          teamName: "Budget Ballers",
          body: null,
          updatedAt: null,
          updatedByDisplayName: null,
        },
      ],
    };
    expect(recapPersonaCardListSchema.parse(list)).toEqual(list);
  });

  it("keeps a card body and its edit timestamp paired", () => {
    const base = {
      teamId: "71000000-0000-4000-8000-000000000010",
      teamName: "Budget Ballers",
      body: "Fears the Horseshoe.",
      updatedAt: "2026-10-01T12:00:00.000Z",
      updatedByDisplayName: null,
    };
    const list = { leagueId: "71000000-0000-4000-8000-000000000001", cards: [base] };
    expect(recapPersonaCardListSchema.parse(list)).toEqual(list);
    expect(
      recapPersonaCardListSchema.safeParse({
        ...list,
        cards: [{ ...base, updatedAt: null }],
      }).success,
    ).toBe(false);
  });

  it("validates generate and settings requests", () => {
    expect(recapGenerateRequestSchema.parse({ week: 5 })).toEqual({ week: 5 });
    expect(recapGenerateRequestSchema.safeParse({ week: 0 }).success).toBe(false);
    expect(recapGenerateRequestSchema.safeParse({ week: 5, provider: "nope" }).success).toBe(false);
    expect(recapSettingsSaveRequestSchema.parse({ spiceLevel: "mild" })).toEqual({
      spiceLevel: "mild",
    });
  });
});
