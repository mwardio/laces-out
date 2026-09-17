import { describe, expect, it } from "vitest";

import { rosProfileDefinitionFromKey } from "./ros-profile-definition.js";
import { rosScoringProfileCatalog } from "./ros-scoring-profiles.js";
import { projectionScoringProfileKey } from "./scoring.js";

describe("rosProfileDefinitionFromKey", () => {
  it("preserves every catalog profile's complete exact scoring identity", () => {
    for (const entry of rosScoringProfileCatalog()) {
      const definition = rosProfileDefinitionFromKey(entry.scoringProfileKey);
      expect(definition.digest).toBe(entry.digest);
      expect(projectionScoringProfileKey(definition.profile)).toBe(entry.scoringProfileKey);
    }
  });

  it("accepts unseen finite weights without approximating an existing profile", () => {
    const key = projectionScoringProfileKey({
      id: "unseen",
      rules: [{ statId: "receptions", points: 0.73 }],
    });
    expect(rosProfileDefinitionFromKey(key).profile.rules).toEqual([
      { statId: "receptions", points: 0.73 },
    ]);
  });

  it.each([
    "not-json",
    "[]",
    '[{"statId":"receptions","points":1}]',
    '[{"statId":"receptions","points":null,"bonuses":[]}]',
    '[{"statId":"receptions","points":1,"bonuses":[],"extra":true}]',
    '[{"statId":"unknown","points":1,"bonuses":[]}]',
    '[{"statId":"receptions","points":0,"bonuses":[]}]',
    '[{"statId":"receptions","points":1,"bonuses":[{"atLeast":5,"points":3}]}]',
    '[{"statId":"receptions","points":1,"bonuses":[]},{"statId":"receptions","points":2,"bonuses":[]}]',
    " ".repeat(8_193),
  ])("rejects an unsafe or noncanonical identity %s", (key) => {
    expect(() => rosProfileDefinitionFromKey(key)).toThrow();
  });
});
