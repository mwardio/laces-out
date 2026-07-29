import { describe, expect, it } from "vitest";

import { parseLeagueRules } from "./league-rules.js";

describe("parseLeagueRules", () => {
  it("reads operational rules from a stored ESPN settings blob", () => {
    const rules = parseLeagueRules({
      teamCount: 12,
      playoffTeamCount: 6,
      operationalRules: {
        regularSeasonMatchupPeriods: 14,
        playoffMatchupPeriodLength: 1,
        medianGameEnabled: false,
        keeperCount: null,
        tradeDeadlineAt: "2026-11-25T05:00:00.000Z",
        divisions: [{ providerDivisionId: "0", name: "East" }],
      },
    });

    expect(rules.teamCount).toBe(12);
    expect(rules.playoffTeamCount).toBe(6);
    expect(rules.regularSeasonMatchupPeriods).toBe(14);
    expect(rules.divisions).toEqual([{ providerDivisionId: "0", name: "East" }]);
    expect(rules.missing).toEqual(["keeperCount"]);
  });

  it("reports missing rules instead of guessing them", () => {
    const rules = parseLeagueRules({ teamCount: 10 });

    expect(rules.playoffTeamCount).toBeNull();
    expect(rules.regularSeasonMatchupPeriods).toBeNull();
    expect(rules.missing).toContain("playoffTeamCount");
  });

  it("survives a malformed blob without throwing", () => {
    expect(() => parseLeagueRules("not an object")).not.toThrow();
    expect(parseLeagueRules(null).teamCount).toBe(0);
    expect(parseLeagueRules({ teamCount: -3 }).teamCount).toBe(0);
  });

  it("never throws on hostile or exotic input", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      Number.NaN,
      "",
      true,
      [],
      [1, 2, 3],
      Symbol("nope"),
      () => "nope",
      new Date(),
      Object.create(null),
      { operationalRules: "not an object" },
      { operationalRules: [] },
      { operationalRules: { divisions: "not an array" } },
      {
        get teamCount(): number {
          throw new Error("exploding getter");
        },
      },
    ];

    for (const input of hostile) {
      expect(() => parseLeagueRules(input)).not.toThrow();
      expect(parseLeagueRules(input).teamCount).toBe(0);
    }
  });

  it("lists every unsupplied field in a fixed declaration order", () => {
    expect(parseLeagueRules({}).missing).toEqual([
      "teamCount",
      "playoffTeamCount",
      "regularSeasonMatchupPeriods",
      "playoffMatchupPeriodLength",
      "medianGameEnabled",
      "keeperCount",
      "tradeDeadlineAt",
      "divisions",
    ]);
  });

  it("rejects non-integer numbers rather than rounding them", () => {
    const rules = parseLeagueRules({
      teamCount: 12.5,
      playoffTeamCount: 6.1,
      operationalRules: {
        regularSeasonMatchupPeriods: 14.5,
        playoffMatchupPeriodLength: Number.NaN,
        keeperCount: Number.POSITIVE_INFINITY,
      },
    });

    expect(rules.teamCount).toBe(0);
    expect(rules.playoffTeamCount).toBeNull();
    expect(rules.regularSeasonMatchupPeriods).toBeNull();
    expect(rules.playoffMatchupPeriodLength).toBeNull();
    expect(rules.keeperCount).toBeNull();
    expect(rules.missing).toContain("teamCount");
    expect(rules.missing).toContain("regularSeasonMatchupPeriods");
  });

  it("rejects out-of-range numbers rather than clamping them into range", () => {
    const rules = parseLeagueRules({
      teamCount: 4096,
      playoffTeamCount: 1,
      operationalRules: {
        regularSeasonMatchupPeriods: 18,
        playoffMatchupPeriodLength: 0,
        keeperCount: -1,
      },
    });

    expect(rules.teamCount).toBe(0);
    expect(rules.playoffTeamCount).toBeNull();
    expect(rules.regularSeasonMatchupPeriods).toBeNull();
    expect(rules.playoffMatchupPeriodLength).toBeNull();
    expect(rules.keeperCount).toBeNull();
  });

  it("keeps legitimate boundary values", () => {
    const rules = parseLeagueRules({
      teamCount: 2,
      playoffTeamCount: 2,
      operationalRules: {
        regularSeasonMatchupPeriods: 17,
        playoffMatchupPeriodLength: 1,
        medianGameEnabled: true,
        keeperCount: 0,
        tradeDeadlineAt: "2026-11-25T00:00:00+00:00",
        divisions: [],
      },
    });

    expect(rules).toEqual({
      teamCount: 2,
      playoffTeamCount: 2,
      regularSeasonMatchupPeriods: 17,
      playoffMatchupPeriodLength: 1,
      medianGameEnabled: true,
      keeperCount: 0,
      tradeDeadlineAt: "2026-11-25T00:00:00+00:00",
      divisions: [],
      missing: [],
    });
    expect(parseLeagueRules({ teamCount: 1 }).teamCount).toBe(1);
  });

  it("treats a non-boolean median flag and a non-ISO trade deadline as missing", () => {
    const rules = parseLeagueRules({
      teamCount: 10,
      operationalRules: { medianGameEnabled: "false", tradeDeadlineAt: "next Tuesday" },
    });

    expect(rules.medianGameEnabled).toBeNull();
    expect(rules.tradeDeadlineAt).toBeNull();
    expect(rules.missing).toContain("medianGameEnabled");
    expect(rules.missing).toContain("tradeDeadlineAt");
  });

  it("drops malformed division entries instead of emitting partial ones", () => {
    const rules = parseLeagueRules({
      teamCount: 12,
      operationalRules: {
        divisions: [
          { providerDivisionId: "0", name: "East" },
          { providerDivisionId: "1" },
          { name: "West" },
          { providerDivisionId: "", name: "Blank" },
          { providerDivisionId: "2", name: "   " },
          { providerDivisionId: 3, name: "Numeric" },
          null,
          "South",
          { providerDivisionId: "4", name: "North", extra: "ignored" },
        ],
      },
    });

    expect(rules.divisions).toEqual([
      { providerDivisionId: "0", name: "East" },
      { providerDivisionId: "4", name: "North" },
    ]);
    expect(rules.missing).not.toContain("divisions");
  });

  it("reports divisions as missing when the provider supplied only unusable entries", () => {
    const rules = parseLeagueRules({
      teamCount: 12,
      operationalRules: { divisions: [{ providerDivisionId: "1" }, null] },
    });

    expect(rules.divisions).toEqual([]);
    expect(rules.missing).toContain("divisions");
  });

  it("produces deep-equal output for the same input parsed twice", () => {
    const settings = {
      teamCount: 12,
      playoffTeamCount: 6,
      operationalRules: {
        regularSeasonMatchupPeriods: 14,
        playoffMatchupPeriodLength: 2,
        medianGameEnabled: true,
        keeperCount: 3,
        tradeDeadlineAt: "2026-11-25T05:00:00.000Z",
        divisions: [
          { providerDivisionId: "1", name: "West" },
          { providerDivisionId: "0", name: "East" },
        ],
      },
    };

    expect(parseLeagueRules(settings)).toEqual(parseLeagueRules(settings));
    expect(parseLeagueRules(structuredClone(settings))).toEqual(parseLeagueRules(settings));
  });

  it("orders missing independently of key insertion order", () => {
    const first = parseLeagueRules({
      operationalRules: { keeperCount: 2, medianGameEnabled: false },
      teamCount: 12,
    });
    const second = parseLeagueRules({
      teamCount: 12,
      operationalRules: { medianGameEnabled: false, keeperCount: 2 },
    });

    expect(first).toEqual(second);
    expect(first.missing).toEqual([
      "playoffTeamCount",
      "regularSeasonMatchupPeriods",
      "playoffMatchupPeriodLength",
      "tradeDeadlineAt",
      "divisions",
    ]);
  });

  it("ignores top-level copies of operational fields so provenance stays honest", () => {
    const rules = parseLeagueRules({ teamCount: 12, regularSeasonMatchupPeriods: 14 });

    expect(rules.regularSeasonMatchupPeriods).toBeNull();
    expect(rules.missing).toContain("regularSeasonMatchupPeriods");
  });
});
