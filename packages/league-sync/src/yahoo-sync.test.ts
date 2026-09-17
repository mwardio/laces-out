import { describe, expect, it } from "vitest";

import { yahooScoringOperation, yahooScoringPositionTypes } from "./yahoo-sync.js";

describe("Yahoo scoring persistence", () => {
  it("marks Yahoo yardage rules as whole scoring groups when fractional points are off", () => {
    for (const statId of ["4", "9", "12", "14", "84"]) {
      expect(yahooScoringOperation(statId, false)).toBe("floor-groups");
      expect(yahooScoringOperation(statId, true)).toBe("multiply");
    }
  });

  it("preserves negative-yardage settings independently of fractional and count scoring", () => {
    for (const statId of ["4", "9", "12", "14"]) {
      expect(yahooScoringOperation(statId, true, false)).toBe("multiply-nonnegative");
      expect(yahooScoringOperation(statId, false, false)).toBe("floor-groups-nonnegative");
      expect(yahooScoringOperation(statId, true, true)).toBe("multiply");
    }
    expect(yahooScoringOperation("18", true, false)).toBe("multiply");
    expect(yahooScoringOperation("84", false, false)).toBe("floor-groups");
  });

  it("leaves count categories and unknown fractional settings linear", () => {
    expect(yahooScoringOperation("5", false)).toBe("multiply");
    expect(yahooScoringOperation("4", null)).toBe("multiply");
    expect(yahooScoringOperation("4", undefined)).toBe("multiply");
  });

  it("canonicalizes provider-declared scoring position families for persistence", () => {
    expect(yahooScoringPositionTypes(["dt", " K ", "DT", ""])).toEqual(["DT", "K"]);
    expect(yahooScoringPositionTypes([])).toBeNull();
    expect(yahooScoringPositionTypes(undefined)).toBeNull();
  });
});
