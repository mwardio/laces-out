import { describe, expect, it } from "vitest";

import { canonicalNflTeamCode, nflverseNflTeamCode } from "./nfl-team-code.js";

describe("NFL team code boundary", () => {
  it("maps nflverse's Rams alias to the app's canonical code in both directions", () => {
    expect(canonicalNflTeamCode("LA")).toBe("LAR");
    expect(canonicalNflTeamCode("lar")).toBe("LAR");
    expect(nflverseNflTeamCode("LAR")).toBe("LA");
  });

  it("normalizes ordinary team codes without changing their identity", () => {
    expect(canonicalNflTeamCode(" det ")).toBe("DET");
    expect(nflverseNflTeamCode("DET")).toBe("DET");
  });
});
