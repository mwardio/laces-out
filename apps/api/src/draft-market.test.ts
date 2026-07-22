import { describe, expect, it } from "vitest";

import { inferDraftMarketScoringFormat, supportsOneQuarterbackRoster } from "./draft-market.js";

describe("draft-market context selection", () => {
  it.each([
    [[], null],
    [[{ statKey: "Passing Yards", operation: "multiply", points: "0.04" }], "standard"],
    [[{ statKey: "Receptions", operation: "multiply", points: "0.5" }], "half-ppr"],
    [[{ statKey: "Reception", operation: "multiply", points: "1" }], "ppr"],
    [[{ statKey: "Receptions", operation: "multiply", points: "0.75" }], null],
  ] as const)("maps explicit reception scoring without guessing", (rules, expected) => {
    expect(inferDraftMarketScoringFormat(rules)).toBe(expected);
  });

  it("accepts one dedicated quarterback and rejects superflex or missing rules", () => {
    expect(
      supportsOneQuarterbackRoster([
        { count: 1, eligiblePositions: ["QB"], isStarter: true },
        { count: 2, eligiblePositions: ["RB", "WR", "TE"], isStarter: true },
      ]),
    ).toBe(true);
    expect(
      supportsOneQuarterbackRoster([
        { count: 1, eligiblePositions: ["QB"], isStarter: true },
        { count: 1, eligiblePositions: ["QB", "RB", "WR", "TE"], isStarter: true },
      ]),
    ).toBe(false);
    expect(supportsOneQuarterbackRoster([])).toBeNull();
  });
});
