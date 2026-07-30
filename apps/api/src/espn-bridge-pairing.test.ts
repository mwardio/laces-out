import { describe, expect, it } from "vitest";

import { createEspnBridgePairingCode } from "./espn-bridge.js";

describe("ESPN bridge self-hosted pairing", () => {
  it("creates unambiguous 80-bit codes in four readable groups", () => {
    const codes = Array.from({ length: 256 }, () => createEspnBridgePairingCode());
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/u);
      expect(code).not.toMatch(/[01IO]/u);
    }
  });
});
