import { describe, expect, it } from "vitest";

import { safeReturnTo } from "./safe-return-to";

describe("safeReturnTo", () => {
  it("keeps an internal path and query", () => {
    expect(safeReturnTo("/projections?week=4")).toBe("/projections?week=4");
  });

  it("rejects absolute and protocol-relative destinations", () => {
    expect(safeReturnTo("https://example.com/steal-session")).toBe("/app");
    expect(safeReturnTo("//example.com/steal-session")).toBe("/app");
  });

  it("avoids returning to the sign-in screen", () => {
    expect(safeReturnTo("/login")).toBe("/app");
  });

  it("uses the workspace when no destination is supplied", () => {
    expect(safeReturnTo(null)).toBe("/app");
  });
});
