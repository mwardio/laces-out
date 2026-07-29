import { describe, expect, it } from "vitest";

import {
  AI_PROMPT_VERSION,
  AI_TOOL_CONTRACT_VERSION,
  AI_TOOL_NAMES,
  aiToolArgumentsSchema,
  aiToolProvenanceSchema,
  aiToolUseSchema,
  lineupRecommendationTool,
} from "./ai-tools.js";

describe("AI tool contract", () => {
  it("declares a read-only, league-scoped lineup tool with a bounded schema", () => {
    expect(lineupRecommendationTool).toMatchObject({
      name: "get_lineup_recommendation",
      scope: "league",
      readOnly: true,
    });
    expect(lineupRecommendationTool.parameters.additionalProperties).toBe(false);
    expect(Object.keys(lineupRecommendationTool.parameters.properties)).toEqual(["week"]);
    expect(AI_TOOL_NAMES).toEqual(["get_lineup_recommendation"]);
  });

  it("never exposes a league, user, or team identifier as a model argument", () => {
    const properties = Object.keys(lineupRecommendationTool.parameters.properties);
    for (const forbidden of ["leagueId", "userId", "teamId", "fantasyTeamId", "draftId"]) {
      expect(properties).not.toContain(forbidden);
    }
  });

  it("rejects model-supplied arguments outside the declared schema", () => {
    const schema = aiToolArgumentsSchema("get_lineup_recommendation");
    expect(schema.safeParse({ week: 5 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    // A model that tries to widen its own scope is rejected, not silently trimmed.
    expect(
      schema.safeParse({ week: 5, leagueId: "20000000-0000-4000-8000-000000000002" }).success,
    ).toBe(false);
    expect(schema.safeParse({ userId: "10000000-0000-4000-8000-000000000099" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ week: 0 }).success).toBe(false);
    expect(schema.safeParse({ week: 99 }).success).toBe(false);
    expect(schema.safeParse({ week: "5" }).success).toBe(false);
  });

  it("versions the contract and the prompt independently", () => {
    expect(AI_TOOL_CONTRACT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/u);
    expect(AI_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/u);
  });

  it("requires a real ADR 0003 pair on every tool result and names what the checksum covers", () => {
    const provenance = {
      algorithmVersion: "in-season-decisions-v1",
      inputChecksum: "a".repeat(64),
      checksumScope: "decision-snapshot-provenance",
      generatedAt: "2026-09-18T12:00:00.000Z",
      warnings: [],
    };
    expect(aiToolProvenanceSchema.safeParse(provenance).success).toBe(true);
    // Null provenance is not representable: a tool that cannot say which algorithm and which
    // inputs produced a number must not present that number to the model at all.
    expect(
      aiToolProvenanceSchema.safeParse({ ...provenance, algorithmVersion: null }).success,
    ).toBe(false);
    expect(aiToolProvenanceSchema.safeParse({ ...provenance, inputChecksum: null }).success).toBe(
      false,
    );
    expect(
      aiToolProvenanceSchema.safeParse({ ...provenance, inputChecksum: "sha256:not-hex" }).success,
    ).toBe(false);
    // The scope is a closed enum so a new surface cannot silently reuse another's meaning.
    expect(
      aiToolProvenanceSchema.safeParse({ ...provenance, checksumScope: "made-up" }).success,
    ).toBe(false);
  });

  it("describes every terminal state of a tool-using request", () => {
    const states = [
      { state: "not-requested" as const },
      { state: "unsupported" as const, reason: "This model cannot call tools." },
      { state: "budget-exhausted" as const },
      { state: "turn-limit" as const },
      { state: "wall-clock" as const },
      {
        state: "used" as const,
        contractVersion: AI_TOOL_CONTRACT_VERSION,
        promptVersion: AI_PROMPT_VERSION,
        calls: [
          {
            name: "get_lineup_recommendation" as const,
            state: "ok" as const,
            provenance: {
              algorithmVersion: "in-season-decisions-v1",
              inputChecksum: "b".repeat(64),
              checksumScope: "decision-snapshot-provenance" as const,
              generatedAt: "2026-09-18T12:00:00.000Z",
              warnings: [],
            },
          },
        ],
      },
    ];
    for (const state of states) {
      expect(aiToolUseSchema.safeParse(state).success).toBe(true);
    }
    expect(aiToolUseSchema.safeParse({ state: "invented" }).success).toBe(false);
  });
});
