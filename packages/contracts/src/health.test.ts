import { describe, expect, it } from "vitest";

import { createBrowserHandoffRequestSchema, healthResponseSchema } from "./index.js";

const validHealth = {
  status: "ok",
  service: "fantasy-api",
  version: "1.0.0",
  time: "2031-01-02T03:04:05.000Z",
  mobileApiVersion: 1,
  mobileCapabilities: [
    "cookie-authentication",
    "league-dashboard",
    "authenticated-browser-handoff",
  ],
} as const;

describe("native compatibility health contract", () => {
  it("accepts the versioned fantasy API declaration", () => {
    expect(healthResponseSchema.parse(validHealth)).toEqual(validHealth);
  });

  it("rejects lookalike services and unbounded capability labels", () => {
    expect(() =>
      healthResponseSchema.parse({ ...validHealth, service: "some-other-api" }),
    ).toThrow();
    expect(() =>
      healthResponseSchema.parse({
        ...validHealth,
        mobileCapabilities: [...validHealth.mobileCapabilities, "operator-invented-capability"],
      }),
    ).toThrow();
  });
});

describe("browser handoff destination contract", () => {
  it("accepts product routes but rejects absolute URLs and lookalike prefixes", () => {
    expect(createBrowserHandoffRequestSchema.parse({ destination: "/stats" })).toEqual({
      destination: "/stats",
    });
    expect(() =>
      createBrowserHandoffRequestSchema.parse({ destination: "https://attacker.example/stats" }),
    ).toThrow();
    expect(() =>
      createBrowserHandoffRequestSchema.parse({ destination: "/stats/../../admin" }),
    ).toThrow();
    expect(() =>
      createBrowserHandoffRequestSchema.parse({
        destination: "/stats?next=https://attacker.example",
      }),
    ).toThrow();
  });
});
