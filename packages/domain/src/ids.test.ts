import { describe, expect, it } from "vitest";

import { providerPlayerCrosswalkId } from "./ids.js";

describe("provider player crosswalk identifiers", () => {
  it.each(["26686", "470.p.26686", "461.p.26686", "nfl.p.26686"])(
    "joins Yahoo key %s to its bare player identifier",
    (id) => {
      expect(providerPlayerCrosswalkId("yahoo", id)).toBe("26686");
      expect(providerPlayerCrosswalkId("sleeper-yahoo", id)).toBe("26686");
    },
  );

  it("preserves long identifiers and leading zeroes as strings", () => {
    expect(providerPlayerCrosswalkId("yahoo", "470.p.9007199254740993")).toBe("9007199254740993");
    expect(providerPlayerCrosswalkId("yahoo", "470.p.0026686")).toBe("0026686");
  });

  it.each([
    "",
    "nba.p.26686",
    "470.l.26686",
    "470.p.26686.extra",
    "470.p.-1",
    "470.p.1e3",
    "470.p.2.5",
    "x470.p.26686",
    "470.p.",
  ])("does not invent a player identifier from %s", (id) =>
    expect(providerPlayerCrosswalkId("yahoo", id)).toBeUndefined(),
  );

  it("keeps ESPN identifiers in their own namespace", () => {
    expect(providerPlayerCrosswalkId("espn", "provider-b")).toBe("provider-b");
    expect(providerPlayerCrosswalkId("sleeper-espn", "470.p.26686")).toBe("470.p.26686");
    expect(providerPlayerCrosswalkId("unknown", "26686")).toBeUndefined();
  });
});
