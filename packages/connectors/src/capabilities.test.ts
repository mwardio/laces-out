import { describe, expect, it } from "vitest";

import { defineProviderCapabilities } from "./capabilities.js";

describe("defineProviderCapabilities", () => {
  it("rejects writes from unofficial providers", () => {
    expect(() =>
      defineProviderCapabilities({
        provider: "espn",
        authority: "unofficial",
        authentication: ["public-none"],
        accountData: "public-only",
        read: {
          discoverLeagues: false,
          settings: true,
          rosters: true,
          matchups: false,
          transactions: false,
          availablePlayers: false,
          draft: "none",
        },
        write: { lineup: true, transactions: false, trades: false, draft: false },
        caveats: [],
      }),
    ).toThrow(/cannot advertise write/i);
  });

  it("deep freezes an accepted declaration", () => {
    const capabilities = defineProviderCapabilities({
      provider: "yahoo",
      authority: "official",
      authentication: ["oauth2-authorization-code-pkce"],
      accountData: "authorized-private",
      read: {
        discoverLeagues: true,
        settings: true,
        rosters: true,
        matchups: true,
        transactions: true,
        availablePlayers: true,
        draft: "polling-unverified",
      },
      write: { lineup: false, transactions: false, trades: false, draft: false },
      caveats: ["Read only"],
    });

    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.read)).toBe(true);
    expect(Object.isFrozen(capabilities.caveats)).toBe(true);
  });
});
