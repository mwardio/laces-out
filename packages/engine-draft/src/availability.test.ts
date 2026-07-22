import { describe, expect, it } from "vitest";

import { estimateDraftAvailability } from "./availability.js";

describe("draft availability", () => {
  it("conditions normal survival on the player still being available now", () => {
    const estimate = estimateDraftAvailability({
      meanAdp: 30,
      standardDeviation: 8,
      currentPick: 20,
      nextPick: 32,
    });
    expect(estimate.method).toBe("normal");
    expect(estimate.probabilityAvailable).toBeGreaterThan(0);
    expect(estimate.probabilityAvailable).toBeLessThan(1);
    expect(estimate.probabilitySelectedBeforeNextPick).toBeCloseTo(
      1 - estimate.probabilityAvailable,
    );
  });

  it("uses sufficiently large empirical context and ignores already-drafted samples", () => {
    const empiricalPicks = [
      5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
      31,
    ];
    const estimate = estimateDraftAvailability({
      meanAdp: 20,
      currentPick: 20,
      nextPick: 26,
      empiricalPicks,
    });
    // Of the 12 samples that survived pick 20, six survive to pick 26.
    expect(estimate).toMatchObject({
      method: "empirical",
      probabilityAvailable: 0.5,
      sampleSize: 25,
    });
  });

  it("makes availability decrease as the next pick moves farther away", () => {
    const near = estimateDraftAvailability({
      meanAdp: 50,
      standardDeviation: 10,
      currentPick: 30,
      nextPick: 35,
    });
    const far = estimateDraftAvailability({
      meanAdp: 50,
      standardDeviation: 10,
      currentPick: 30,
      nextPick: 55,
    });
    expect(near.probabilityAvailable).toBeGreaterThan(far.probabilityAvailable);
  });

  it("uses source distribution sample size to qualify normal-model confidence", () => {
    const sparse = estimateDraftAvailability({
      meanAdp: 30,
      standardDeviation: 6,
      distributionSampleSize: 10,
      currentPick: 20,
      nextPick: 32,
    });
    const established = estimateDraftAvailability({
      meanAdp: 30,
      standardDeviation: 6,
      distributionSampleSize: 200,
      currentPick: 20,
      nextPick: 32,
    });

    expect(sparse.method).toBe("normal");
    expect(sparse.sampleSize).toBe(10);
    expect(established.confidence).toBeGreaterThan(sparse.confidence);
  });

  it("rejects an invalid pick sequence", () => {
    expect(() => estimateDraftAvailability({ meanAdp: 20, currentPick: 10, nextPick: 10 })).toThrow(
      "after the current pick",
    );
  });
});
