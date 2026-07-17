import { describe, expect, it } from "vitest";

import { resolvePlayerIdentity, type CanonicalPlayerIdentity } from "./index.js";

const players: readonly CanonicalPlayerIdentity[] = [
  {
    id: "one",
    fullName: "Marvin Harrison Jr.",
    nflTeam: "ARI",
    position: "WR",
    birthDate: "2002-08-11",
    externalIds: { yahoo: "40001" },
  },
  {
    id: "two",
    fullName: "Marvin Harrison",
    position: "WR",
    externalIds: {},
  },
];

describe("resolvePlayerIdentity", () => {
  it("prefers an exact external ID", () => {
    const result = resolvePlayerIdentity(
      { fullName: "Wrong display", source: "yahoo", sourceId: "40001" },
      players,
    );
    expect(result.status).toBe("matched");
    if (result.status === "matched") expect(result.candidate.playerId).toBe("one");
  });

  it("uses corroborating metadata for an unambiguous match", () => {
    const result = resolvePlayerIdentity(
      {
        fullName: "Marvin Harrison Jr",
        nflTeam: "ARI",
        position: "WR",
        birthDate: "2002-08-11",
        source: "espn",
        sourceId: "x",
      },
      players,
    );
    expect(result.status).toBe("matched");
  });

  it("routes an ambiguous name-only match to review", () => {
    const result = resolvePlayerIdentity(
      { fullName: "Marvin Harrison", source: "espn", sourceId: "x" },
      players,
    );
    expect(result.status).toBe("review");
  });
});
