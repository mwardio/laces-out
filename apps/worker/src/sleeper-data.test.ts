import { describe, expect, it } from "vitest";

import { buildUniqueExactPlayerIdentity, sleeperPlayerCrosswalkRows } from "./sleeper-data.js";

describe("buildUniqueExactPlayerIdentity", () => {
  it("normalizes unique exact name-and-position matches", () => {
    const identity = buildUniqueExactPlayerIdentity([
      { id: "player-1", fullName: "  Treylon Burks ", primaryPosition: "wr" },
      { id: "player-2", fullName: "Malik Willis", primaryPosition: "QB" },
    ]);

    expect(identity.get("treylon burks|WR")).toBe("player-1");
    expect(identity.get("malik willis|QB")).toBe("player-2");
  });

  it("drops ambiguous exact matches instead of guessing", () => {
    const identity = buildUniqueExactPlayerIdentity([
      { id: "player-1", fullName: "Chris Smith", primaryPosition: "DB" },
      { id: "player-2", fullName: "Chris Smith", primaryPosition: "DB" },
    ]);

    expect(identity.has("chris smith|DB")).toBe(false);
  });
});

describe("sleeperPlayerCrosswalkRows", () => {
  it("keeps provider aliases in separate crosswalk namespaces", () => {
    expect(
      sleeperPlayerCrosswalkRows({
        playerId: "canonical-player",
        sleeperId: "1234",
        espnId: "5678",
        yahooId: "9012",
        confidence: "1.0000",
      }),
    ).toEqual([
      expect.objectContaining({ source: "sleeper", externalId: "1234" }),
      expect.objectContaining({ source: "sleeper-espn", externalId: "5678" }),
      expect.objectContaining({ source: "sleeper-yahoo", externalId: "9012" }),
    ]);
  });

  it("does not manufacture aliases for an unresolved player", () => {
    expect(
      sleeperPlayerCrosswalkRows({
        playerId: null,
        sleeperId: "1234",
        espnId: "5678",
        yahooId: "9012",
        confidence: "0.0000",
      }),
    ).toEqual([]);
  });
});
