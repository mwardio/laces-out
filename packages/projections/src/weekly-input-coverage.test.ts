import { describe, expect, it } from "vitest";
import {
  weeklyInputCoverage,
  weeklyStatsCutoff,
  type WeeklyCoverageGame,
} from "./weekly-input-coverage.js";

const now = new Date("2026-09-15T12:00:00Z");
const game: WeeklyCoverageGame = {
  season: 2026,
  week: 1,
  kickoffAt: new Date("2026-09-15T00:15:00Z"),
  status: "final",
};
const coverage = (statsThrough: unknown, schedule = [game], targetWeek = 2) =>
  weeklyInputCoverage({
    season: 2026,
    targetWeek,
    now,
    statsThrough: weeklyStatsCutoff(statsThrough),
    schedule,
  });

describe("weekly forecast input coverage", () => {
  it("rejects newly computed forecasts whose statistics missed the completed week", () => {
    expect(coverage({ season: 2025, week: 18 }).warnings.join(" ")).toContain("2026 Week 1");
    expect(coverage(null).warnings).toHaveLength(1);
    expect(coverage({ season: 2026, week: 1 }).warnings).toEqual([]);
  });
  it("requires resolution of a frozen game even when a statistics cutoff claims freshness", () => {
    expect(
      coverage({ season: 2026, week: 1 }, [{ ...game, status: "in-progress" }]).warnings.join(" "),
    ).toContain("unresolved");
  });
  it("waits for a whole week and never treats elapsed time as a final result", () => {
    const later = { ...game, kickoffAt: new Date("2026-09-15T05:00:00Z"), status: "scheduled" };
    expect(coverage(null, [game, later]).expectedThroughWeek).toBeNull();
    const result = coverage(null, [{ ...later, kickoffAt: new Date("2026-09-15T04:00:00Z") }]);
    expect(result.expectedThroughWeek).toBe(1);
    expect(result.warnings).toHaveLength(2);
  });
  it("trusts explicit completion without waiting eight hours and ignores cancellations", () => {
    expect(coverage(null, [{ ...game, kickoffAt: now }]).expectedThroughWeek).toBe(1);
    expect(
      coverage({ season: 2026, week: 1 }, [game, { ...game, status: "cancelled", kickoffAt: null }])
        .warnings,
    ).toEqual([]);
  });
  it("fails closed on absent prior schedules and inconsistent cutoffs, but permits Week 1", () => {
    expect(coverage(null, []).warnings.join(" ")).toContain("coverage is unavailable");
    expect(coverage({ season: 2026, week: 2 }).warnings.join(" ")).toContain("inconsistent");
    expect(coverage({ season: 2027, week: 1 }).warnings.join(" ")).toContain("inconsistent");
    expect(coverage({ season: 2025, week: 18 }, [], 1).warnings).toEqual([]);
  });
  it.each([
    {},
    { season: "2026", week: 1 },
    { season: 2026, week: 0 },
    { season: 2026, week: 1.5 },
    { season: 2026, week: 19 },
  ])("rejects malformed cutoff %j", (value) => {
    expect(weeklyStatsCutoff(value)).toBeNull();
  });
});
