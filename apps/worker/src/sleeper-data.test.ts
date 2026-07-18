import { describe, expect, it } from "vitest";

import { buildUniqueExactPlayerIdentity } from "./sleeper-data.js";

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
