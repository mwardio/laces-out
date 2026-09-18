import { describe, expect, it } from "vitest";
import { assessLineupChange, starterAllowsNearTieRetention } from "./lineup-advice.js";
const points = (mean: number, floor: number, ceiling: number) => ({ mean, floor, ceiling });

describe("lineup change assessment", () => {
  it("requires a scheduled positive forecast and preserves known absence safeguards", () => {
    const ready = { statuses: ["ACTIVE"], projection: points(5.327, 0, 12), scheduled: true };
    expect(starterAllowsNearTieRetention(ready)).toBe(true);
    expect(starterAllowsNearTieRetention({ ...ready, statuses: [null, "QUESTIONABLE"] })).toBe(
      true,
    );
    for (const status of [
      "OUT",
      "IR",
      "reserve/injured",
      "INA",
      "DOUBTFUL",
      "BYE",
      "SUSPENDED",
      "PUP",
    ])
      expect(
        starterAllowsNearTieRetention({ ...ready, statuses: ["ACTIVE", status] }),
        status,
      ).toBe(false);
    expect(starterAllowsNearTieRetention({ ...ready, scheduled: false })).toBe(false);
    expect(starterAllowsNearTieRetention({ ...ready, projection: points(0, 0, 0) })).toBe(false);
    expect(starterAllowsNearTieRetention({ ...ready, projection: undefined })).toBe(false);
  });
  it("flags an opposing provider forecast even when the model's ranges are separated", () => {
    const result = assessLineupChange(
      { ...points(20, 18, 22), confidence: 0.5925 },
      points(10, 8, 12),
      {
        add: 8,
        remove: 14,
      },
    );
    expect(result.strength).toBe("close-call");
    expect(result.explanation).toContain("Forecasts disagree");
    expect(result.explanation).toContain("14.00 points versus 8.00");
  });
  it("keeps a sparse forecast uncertain even when its supplied ranges are separated", () => {
    const add = { ...points(12, 10, 14), confidence: 0.5925 };
    const remove = { ...points(5, 2, 8), confidence: 0.95 };
    const result = assessLineupChange(add, remove);
    expect(result.strength).toBe("close-call");
    expect(result.explanation).toContain("Limited evidence");
    expect(result.explanation).toContain("not a win probability");
    expect(assessLineupChange({ ...add, confidence: 0.75 }, remove).strength).toBe("model-edge");
    expect(assessLineupChange(remove, { ...points(1, -2, 4), confidence: 0.5925 }).strength).toBe(
      "close-call",
    );
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
  it.each([
    [points(20, 5, 10), points(4, 1, 3)],
    [points(20, 25, 30), points(18, 15, 20)],
    [points(-2, -10, -5), points(-3, -20, -15)],
    [points(2, 0, 1), points(1, -2, -1)],
  ])("accepts ordered central ranges even when the mean is outside them", (add, remove) => {
    expect(assessLineupChange(add, remove).strength).toBe("model-edge");
  });
  it("qualifies a higher mean whose central range favors the other player", () => {
    const result = assessLineupChange(points(20, 1, 5), points(18, 10, 14));
    expect(result.strength).toBe("close-call");
    expect(result.explanation).toContain("mean and ranges favor different players");
    expect(result.explanation).toContain("not a win probability");
  });
  it("keeps skewed forecasts with limited evidence cautious", () => {
    const result = assessLineupChange(
      { ...points(20, 25, 30), confidence: 0 },
      { ...points(18, 15, 20), confidence: 0.95 },
    );
    expect(result.strength).toBe("close-call");
    expect(result.explanation).toContain("Limited evidence");
  });
  it("qualifies negative deltas as dependent slot moves", () => {
    expect(assessLineupChange(points(3, 1, 4), points(10, 8, 12)).explanation).toContain(
      "complete lineup plan",
    );
  });
  it("does not infer certainty from absent, degenerate, or malformed intervals", () => {
    expect(assessLineupChange(points(10, 5, 15)).strength).toBe("unrated");
    for (const add of [
      points(10, 10, 10),
      points(10, 14, 12),
      points(10, 5, NaN),
      points(10, -Infinity, 14),
      points(Infinity, 5, 14),
      { ...points(10, 5, 14), intervalAvailable: false },
    ]) {
      expect(assessLineupChange(add, points(5, 1, 10)).strength).toBe("unrated");
    }
  });
});
