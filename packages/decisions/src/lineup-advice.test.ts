import { describe, expect, it } from "vitest";
import { assessLineupChange } from "./lineup-advice.js";
const points = (mean: number, floor: number, ceiling: number) => ({ mean, floor, ceiling });

describe("lineup change assessment", () => {
  it("flags an opposing provider forecast even when the model's ranges are separated", () => {
    const result = assessLineupChange(points(20, 18, 22), points(10, 8, 12), {
      add: 8,
      remove: 14,
    });
    expect(result.strength).toBe("close-call");
    expect(result.explanation).toContain("Forecasts disagree");
    expect(result.explanation).toContain("14.00 points versus 8.00");
  });
  it.each([
    [points(7.481, 3.55, 10.818), points(5.658, 1.727, 8.995)],
    [points(12.568, 7.377, 17.528), points(4.847, -0.782, 9.6)],
    [points(10, 8, 12), points(7, 5, 8)],
  ])("qualifies overlapping outcome ranges as a close call", (add, remove) => {
    expect(assessLineupChange(add, remove).strength).toBe("close-call");
  });
  it("does not invent a win probability from separated ranges", () => {
    const result = assessLineupChange(points(12, 10, 14), points(5, 2, 8));
    expect(result.strength).toBe("model-edge");
    expect(result.explanation).toContain("not a guarantee");
  });
  it("qualifies negative deltas as dependent slot moves", () => {
    expect(assessLineupChange(points(3, 1, 4), points(10, 8, 12)).explanation).toContain(
      "complete lineup plan",
    );
  });
  it("does not infer certainty from absent, degenerate, or malformed intervals", () => {
    expect(assessLineupChange(points(10, 5, 15)).strength).toBe("unrated");
    for (const add of [points(10, 10, 10), points(10, 12, 14), points(10, 5, NaN)]) {
      expect(assessLineupChange(add, points(5, 1, 10)).strength).toBe("unrated");
    }
  });
});
