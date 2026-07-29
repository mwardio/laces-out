import { describe, expect, it } from "vitest";

import { absoluteApiOrigin, apiBaseUrl, resolveApiBaseUrl } from "./api-client.js";

describe("API base URL resolution", () => {
  it("keeps the configured absolute base unless same-origin mode is on in a browser", () => {
    expect(resolveApiBaseUrl("https://laces.example.com", undefined, true)).toBe(
      "https://laces.example.com",
    );
    expect(resolveApiBaseUrl("https://laces.example.com", "false", true)).toBe(
      "https://laces.example.com",
    );
    // Server rendering has no domain of its own to be relative to, so it keeps the absolute base
    // even in same-origin mode.
    expect(resolveApiBaseUrl("https://laces.example.com", "true", false)).toBe(
      "https://laces.example.com",
    );
  });

  it("goes relative in a browser in same-origin mode so every domain calls its own /v1", () => {
    const base = resolveApiBaseUrl("https://laces.example.com", "true", true);
    expect(base).toBe("");
    expect(`${base}/v1/leagues`).toBe("/v1/leagues");
  });

  it("still offers an absolute origin for URLs that leave this app", () => {
    // Under Node there is no window, so this module resolved to the configured base and the
    // absolute origin has to be that same base rather than an empty string.
    expect(apiBaseUrl).not.toBe("");
    expect(absoluteApiOrigin()).toBe(apiBaseUrl);
    expect(() => new URL(absoluteApiOrigin())).not.toThrow();
  });
});
