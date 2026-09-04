import { describe, expect, it } from "vitest";

import { waiverDecisionSectionSchema } from "./index.js";

const add = {
  id: "70000000-0000-4000-8000-000000000001",
  name: "Incoming Player",
  positions: ["WR"],
  nflTeam: "CHI",
  status: "ACTIVE",
  projectedPoints: 12.4,
} as const;

const drop = {
  id: "70000000-0000-4000-8000-000000000002",
  name: "Outgoing Player",
  positions: ["WR"],
  nflTeam: "DET",
  status: "ACTIVE",
  projectedPoints: 8.1,
} as const;

const availableWaivers = {
  state: "available",
  candidateCount: 24,
  evaluatedMoveCount: 312,
  recommendations: [
    {
      add,
      drop,
      weightedGain: 3.49,
      lineupGain: 1.2,
      faab: null,
      market: null,
      rationale: "Incoming Player for Outgoing Player improves the modeled roster.",
    },
  ],
  execution: {
    mode: "provider-required",
    provider: "espn",
    label: "Open ESPN to verify and apply manually",
    url: "https://fantasy.espn.com/football/league?leagueId=123",
  },
  notes: [],
} as const;

describe("waiverDecisionSectionSchema", () => {
  it("accepts a recommendation with its modeled outgoing player", () => {
    expect(waiverDecisionSectionSchema.safeParse(availableWaivers).success).toBe(true);
  });

  it("rejects an add-only recommendation without a modeled drop", () => {
    const addOnly = {
      ...availableWaivers,
      recommendations: [{ ...availableWaivers.recommendations[0], drop: null }],
    };

    expect(waiverDecisionSectionSchema.safeParse(addOnly).success).toBe(false);
  });
});
