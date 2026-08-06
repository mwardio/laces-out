import { describe, expect, it } from "vitest";

import {
  capturedEspnSessionFromCookies,
  isValidSwid,
  type EspnCookieCandidate,
} from "./session-credential.js";

const capturedAt = "2026-08-05T18:00:00.000Z";
const swid: EspnCookieCandidate = {
  name: "SWID",
  value: "%7B123e4567-e89b-42d3-a456-426614174000%7D",
  domain: ".espn.com",
};
const espnS2: EspnCookieCandidate = {
  name: "espn_s2",
  value: "session-value-that-is-long-enough-for-validation",
  domain: ".espn.com",
};

describe("ESPN extension session credential reduction", () => {
  it("accepts and decodes only the two exact ESPN session cookies", () => {
    expect(capturedEspnSessionFromCookies(swid, espnS2, capturedAt)).toEqual({
      ok: true,
      swid: "{123e4567-e89b-42d3-a456-426614174000}",
      espnS2: espnS2.value,
      capturedAt,
    });
  });

  it.each([
    [null, espnS2],
    [swid, null],
    [{ ...swid, name: "swid" }, espnS2],
    [swid, { ...espnS2, name: "other" }],
    [{ ...swid, domain: ".espn.com.attacker.test" }, espnS2],
    [swid, { ...espnS2, domain: ".go.com" }],
    [{ ...swid, value: "not-a-swid" }, espnS2],
    [swid, { ...espnS2, value: `valid-prefix-${"x".repeat(32)};other=value` }],
  ])(
    "rejects missing, renamed, foreign, or malformed cookie values",
    (candidateSwid, candidateS2) => {
      expect(
        capturedEspnSessionFromCookies(candidateSwid, candidateS2, capturedAt),
      ).toBeUndefined();
    },
  );

  it("validates a braced-UUID SWID and nothing else", () => {
    expect(isValidSwid("{123e4567-e89b-42d3-a456-426614174000}")).toBe(true);
    expect(isValidSwid("{123E4567-E89B-42D3-A456-426614174000}")).toBe(true);
    expect(isValidSwid("123e4567-e89b-42d3-a456-426614174000")).toBe(false);
    expect(isValidSwid("{123e4567-e89b-42d3-a456-42661417400}")).toBe(false);
    expect(isValidSwid("")).toBe(false);
  });
});
