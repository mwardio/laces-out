import { describe, expect, it } from "vitest";
import { Script } from "node:vm";

import { createEspnBookmarklet, currentEspnSeason } from "./espn-bookmarklet.js";

describe("ESPN one-click bookmark", () => {
  it("builds a scoped snapshot uploader without ESPN credentials or cookie reads", () => {
    const bookmarklet = createEspnBookmarklet({
      apiBaseUrl: "https://laces.example/path-that-must-not-survive",
      deviceToken: `lo_espn_${"a".repeat(43)}`,
      leagueIds: ["12345", "67890"],
      season: 2026,
    });

    expect(bookmarklet).toMatch(/^javascript:/u);
    expect(bookmarklet).toContain('"api":"https://laces.example"');
    expect(bookmarklet).toContain('"leagues":["12345","67890"]');
    expect(bookmarklet).toContain("/v1/bridge/espn/snapshots");
    expect(bookmarklet).toContain("credentials:'include'");
    expect(bookmarklet).not.toMatch(/document\.cookie|espn_s2|swid|password/iu);
    expect(() => new Script(bookmarklet.slice("javascript:".length))).not.toThrow();
  });

  it("uses the prior fantasy season during the NFL postseason", () => {
    expect(currentEspnSeason(new Date(2027, 0, 15))).toBe(2026);
    expect(currentEspnSeason(new Date(2027, 7, 15))).toBe(2027);
  });
});
