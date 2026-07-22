import { describe, expect, it } from "vitest";

import type { NflversePlayerInjuryReport } from "@fantasy/source-nflverse";

import {
  injuryReportStateKey,
  snapCountsIdentityKey,
  uniqueSeasonWindow,
  weeklyRosterIdentityKey,
  weeklyStatsIdentityKey,
} from "./nflverse-weekly-data.js";

describe("nflverse weekly worker helpers", () => {
  it("checks a four-season training window in chronological order", () => {
    expect(uniqueSeasonWindow(2026)).toEqual([2023, 2024, 2025, 2026]);
    expect(() => uniqueSeasonWindow(2011)).toThrow(/between 2012 and 2200/u);
  });

  it("uses stable provider identifiers rather than names for player resolution", () => {
    expect(weeklyStatsIdentityKey({ gsisId: "00-0031234" } as never)).toBe("00-0031234");
    expect(snapCountsIdentityKey({ pfrPlayerId: "PlaySc00" } as never)).toBe("PlaySc00");
    expect(
      weeklyRosterIdentityKey({
        gsisId: null,
        esbId: "PLY123",
        smartId: "10000000-0000-4000-8000-000000000123",
      } as never),
    ).toBe("PLY123");
    expect(() =>
      weeklyRosterIdentityKey({ gsisId: null, esbId: null, smartId: null } as never),
    ).toThrow(/stable player identity/u);
  });

  it("fingerprints normalized injury state rather than player names", () => {
    const observation: NflversePlayerInjuryReport = {
      season: 2025,
      week: 5,
      seasonType: "REG",
      gameType: "REG",
      team: "MIA",
      gsisId: "00-0031234",
      position: "QB",
      fullName: "Dan Marino",
      firstName: "Dan",
      lastName: "Marino",
      report: { primaryInjury: "Knee", secondaryInjury: null, status: "questionable" },
      practice: { primaryInjury: "Knee", secondaryInjury: null, status: "limited" },
      dateModified: null,
    };
    expect(injuryReportStateKey(observation)).toMatch(/^[a-f0-9]{64}$/u);
    expect(injuryReportStateKey(observation)).toBe(
      injuryReportStateKey({ ...observation, fullName: "Different Name" }),
    );
    expect(injuryReportStateKey(observation)).not.toBe(
      injuryReportStateKey({
        ...observation,
        report: { primaryInjury: "Knee", secondaryInjury: null, status: "out" },
      }),
    );
  });
});
