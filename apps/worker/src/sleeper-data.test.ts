import { describe, expect, it } from "vitest";

import {
  buildUniqueExactPlayerIdentity,
  sleeperPlayerCrosswalkRows,
  uniqueSleeperPlayerCrosswalkRows,
} from "./sleeper-data.js";

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

describe("uniqueSleeperPlayerCrosswalkRows", () => {
  it("collapses exact aliases and retains their strongest confidence", () => {
    expect(
      uniqueSleeperPlayerCrosswalkRows([
        {
          playerId: "player-1",
          source: "sleeper-espn",
          externalId: "1234",
          confidence: "0.8000",
          verified: false,
        },
        {
          playerId: "player-1",
          source: "sleeper-espn",
          externalId: "1234",
          confidence: "1.0000",
          verified: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        playerId: "player-1",
        source: "sleeper-espn",
        externalId: "1234",
        confidence: "1.0000",
      }),
    ]);
  });

  it("withholds provider aliases that resolve to multiple canonical players", () => {
    expect(
      uniqueSleeperPlayerCrosswalkRows([
        {
          playerId: "player-1",
          source: "sleeper-yahoo",
          externalId: "5678",
          confidence: "1.0000",
          verified: false,
        },
        {
          playerId: "player-2",
          source: "sleeper-yahoo",
          externalId: "5678",
          confidence: "1.0000",
          verified: false,
        },
        {
          playerId: "player-3",
          source: "sleeper",
          externalId: "unique",
          confidence: "0.9500",
          verified: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        playerId: "player-3",
        source: "sleeper",
        externalId: "unique",
      }),
    ]);
  });
});
