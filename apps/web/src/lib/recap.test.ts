import {
  leagueRecapResponseSchema,
  recapPersonaCardListSchema,
  type LeagueWeeklyAwardsSection,
} from "@fantasy/contracts";
import { describe, expect, it } from "vitest";

import {
  demoAnalyticsSnapshot,
  demoHistoricalRecapBodies,
  demoLeagueRecap,
  demoRecapPersonaCards,
} from "./demo-contract-data.js";

import {
  awardableWeek,
  canEditSpice,
  canGenerateRecap,
  canManageLeagueIntel,
  parseLeagueRecap,
  parseRecapPersonaCards,
  parseRecapSettings,
  recapByline,
  recapUnavailableReasons,
  selectableRecapWeeks,
} from "./recap.js";

const RECAP = {
  week: 5,
  body: "The recap",
  provider: "gemini",
  model: "gemini-3.6-flash",
  spiceLevel: "scorched",
  generatedByDisplayName: "Mack",
  generatedAt: "2026-10-07T16:20:00.000Z",
} as const;

const LEAGUE_ID = "71000000-0000-4000-8000-000000000001";
const TEAM_ID = "40000000-0000-4000-8000-000000000001";

describe("recap helpers", () => {
  it("parses a valid envelope and rejects garbage", () => {
    const envelope = {
      leagueId: LEAGUE_ID,
      week: 5,
      configuredSpiceLevel: "medium",
      generation: { state: "available" },
      recap: RECAP,
    };

    expect(parseLeagueRecap(envelope)).toEqual(envelope);
    expect(parseLeagueRecap({ nope: true })).toBeNull();
    expect(parseLeagueRecap(null)).toBeNull();
  });

  it("parses League Intel lists and settings", () => {
    const list = {
      leagueId: LEAGUE_ID,
      cards: [
        {
          teamId: TEAM_ID,
          teamName: "Budget Ballers",
          body: null,
          updatedAt: null,
          updatedByDisplayName: null,
        },
      ],
    };

    expect(parseRecapPersonaCards(list)).toEqual(list);
    expect(parseRecapPersonaCards({ leagueId: LEAGUE_ID })).toBeNull();
    expect(parseRecapSettings({ leagueId: LEAGUE_ID, spiceLevel: "mild" })).toEqual({
      leagueId: LEAGUE_ID,
      spiceLevel: "mild",
    });
    expect(parseRecapSettings({ leagueId: LEAGUE_ID, spiceLevel: "nuclear" })).toBeNull();
  });

  it("writes the provenance byline", () => {
    expect(recapByline(RECAP)).toBe("Week 5 · written by Gemini · Scorched · requested by Mack");
    expect(recapByline({ ...RECAP, generatedByDisplayName: null })).toBe(
      "Week 5 · written by Gemini · Scorched",
    );
  });

  it("bylines the level a recap was written at, not today's setting", () => {
    expect(recapByline({ ...RECAP, spiceLevel: "mild" })).toContain("Mild");
  });

  it("restricts League Intel to league owners and commissioners", () => {
    expect(canManageLeagueIntel({ role: "manager", claimedTeamId: TEAM_ID })).toBe(false);
    expect(canManageLeagueIntel({ role: "manager", claimedTeamId: null })).toBe(false);
    expect(canManageLeagueIntel({ role: "commissioner", claimedTeamId: null })).toBe(true);
    expect(canManageLeagueIntel({ role: "owner", claimedTeamId: null })).toBe(true);
    expect(canManageLeagueIntel({ role: "viewer", claimedTeamId: null })).toBe(false);
    expect(canManageLeagueIntel({ role: "viewer", claimedTeamId: TEAM_ID })).toBe(false);
  });

  it("gates spice and generation by role", () => {
    expect(canEditSpice({ role: "owner", claimedTeamId: null })).toBe(true);
    expect(canEditSpice({ role: "commissioner", claimedTeamId: null })).toBe(true);
    expect(canEditSpice({ role: "manager", claimedTeamId: null })).toBe(false);
    expect(canGenerateRecap({ role: "manager", claimedTeamId: null })).toBe(true);
    expect(canGenerateRecap({ role: "viewer", claimedTeamId: null })).toBe(false);
  });

  it("reads the awardable week and unavailable reasons from the awards section", () => {
    expect(
      awardableWeek({ state: "available", week: 5, awards: [], withheld: [], definitions: [] }),
    ).toBe(5);
    const unavailable: LeagueWeeklyAwardsSection = {
      state: "unavailable",
      reasons: [{ code: "AWARDS_WEEK_UNAVAILABLE", message: "No completed week yet." }],
    };
    expect(awardableWeek(unavailable)).toBeNull();
    expect(recapUnavailableReasons(unavailable)).toEqual(["No completed week yet."]);
    expect(
      recapUnavailableReasons({
        state: "available",
        week: 5,
        awards: [],
        withheld: [],
        definitions: [],
      }),
    ).toEqual([]);
  });

  it("orders the selectable weeks newest first and falls back to the awarded week", () => {
    expect(selectableRecapWeeks([3, 5, 4], null)).toEqual([5, 4, 3]);
    expect(selectableRecapWeeks([], 5)).toEqual([5]);
    expect(selectableRecapWeeks([], null)).toEqual([]);
    // A duplicated or already-listed week never appears twice.
    expect(selectableRecapWeeks([4, 5, 5], 5)).toEqual([5, 4]);
  });
});

describe("recap demo fixtures", () => {
  it("stay valid against the contracts", () => {
    expect(leagueRecapResponseSchema.parse(demoLeagueRecap)).toBeTruthy();
    expect(recapPersonaCardListSchema.parse(demoRecapPersonaCards)).toBeTruthy();
  });

  it("cover every week the tour's selector offers", () => {
    const offered = selectableRecapWeeks(
      demoAnalyticsSnapshot.weeklyAwardWeeks,
      awardableWeek(demoAnalyticsSnapshot.weeklyAwards),
    );
    expect(offered).toEqual([5, 4, 3]);
    for (const week of offered) {
      const body =
        week === demoLeagueRecap.week
          ? demoLeagueRecap.recap?.body
          : demoHistoricalRecapBodies[week];
      expect(body).toBeTruthy();
    }
  });

  it("shows one League Intel entry per demo team, including an unwritten one", () => {
    expect(demoRecapPersonaCards.cards).toHaveLength(4);
    expect(demoRecapPersonaCards.cards.filter((card) => card.body === null)).toHaveLength(1);
  });
});
