import { describe, expect, it } from "vitest";

import { yahooScoringOperation } from "./yahoo-sync.js";

describe("Yahoo scoring persistence", () => {
  it("marks Yahoo yardage rules as whole scoring groups when fractional points are off", () => {
    for (const statId of ["4", "9", "12", "14"]) {
      expect(yahooScoringOperation(statId, false)).toBe("floor-groups");
      expect(yahooScoringOperation(statId, true)).toBe("multiply");
    }
  });

  it("leaves count categories and unknown fractional settings linear", () => {
    expect(yahooScoringOperation("5", false)).toBe("multiply");
    expect(yahooScoringOperation("4", null)).toBe("multiply");
    expect(yahooScoringOperation("4", undefined)).toBe("multiply");
  });
});
