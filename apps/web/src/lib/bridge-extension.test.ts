import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bridgeExtensionIds,
  chromeWebStoreUrl,
  discoverLeagues,
  pingBridge,
  publishedBridgeAcceptsOrigin,
  sendPairingOffer,
} from "./bridge-extension";

type SendMessageCallback = (response: unknown) => void;

function stubExtensionResponses(respond: (extensionId: string, message: unknown) => unknown) {
  const sendMessage = vi.fn(
    (extensionId: string, message: unknown, callback: SendMessageCallback): void => {
      callback(respond(extensionId, message));
    },
  );
  vi.stubGlobal("chrome", { runtime: { sendMessage, lastError: undefined } });
  return sendMessage;
}

const validPing = {
  ok: true,
  discovery: true,
  version: "0.8.0",
  configured: false,
  pairedToThisOrigin: false,
  pendingOffer: false,
  state: "not-configured",
  lastSuccessfulAt: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bridge extension pairing", () => {
  it("targets the published Chrome Web Store listing first", () => {
    expect(chromeWebStoreUrl).toContain(bridgeExtensionIds()[0] ?? "missing-extension-id");
    expect(bridgeExtensionIds()[0]).toBe("hmilkmcjlkpnigcfnlfogeafacjpmkbj");
  });

  it("distinguishes published hosts from self-hosted pairing origins", () => {
    expect(publishedBridgeAcceptsOrigin("https://lacesout.app/connections")).toBe(true);
    expect(publishedBridgeAcceptsOrigin("https://laces.mward.io")).toBe(true);
    expect(publishedBridgeAcceptsOrigin("https://fantasy.example.com")).toBe(false);
    expect(publishedBridgeAcceptsOrigin("not a URL")).toBe(false);
  });

  it("hands the scoped credential directly to the installed extension", async () => {
    const sendMessage = vi.fn(
      (extensionId: string, message: unknown, callback: (response: unknown) => void): void => {
        void extensionId;
        void message;
        callback({ ok: true });
      },
    );
    vi.stubGlobal("chrome", { runtime: { sendMessage, lastError: undefined } });

    await expect(
      sendPairingOffer({
        apiBaseUrl: "https://laces.mward.io",
        deviceToken: "secret-device-token",
        leagues: ["123456789"],
        season: 2026,
      }),
    ).resolves.toEqual({
      ok: true,
      extensionId: "hmilkmcjlkpnigcfnlfogeafacjpmkbj",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "hmilkmcjlkpnigcfnlfogeafacjpmkbj",
      {
        type: "PAIRING_OFFER",
        apiBaseUrl: "https://laces.mward.io",
        deviceToken: "secret-device-token",
        leagues: ["123456789"],
        season: 2026,
      },
      expect.any(Function),
    );
  });

  it("fails closed when no connectable extension is installed", async () => {
    await expect(
      sendPairingOffer({
        apiBaseUrl: "https://laces.mward.io",
        deviceToken: "secret-device-token",
        leagues: ["123456789"],
        season: 2026,
      }),
    ).resolves.toEqual({ ok: false });
  });
});

describe("bridge extension ping", () => {
  it("reports not installed without a chrome runtime or any response", async () => {
    await expect(pingBridge()).resolves.toEqual({ installed: false, supportsDiscovery: false });
    stubExtensionResponses(() => undefined);
    await expect(pingBridge()).resolves.toEqual({ installed: false, supportsDiscovery: false });
  });

  it("treats a legacy pairing-offer rejection as installed without discovery", async () => {
    stubExtensionResponses(() => ({ ok: false, reason: "Not a bridge pairing offer" }));
    await expect(pingBridge()).resolves.toEqual({
      installed: true,
      supportsDiscovery: false,
      extensionId: "hmilkmcjlkpnigcfnlfogeafacjpmkbj",
    });
  });

  it("returns the full validated outcome from a discovery-capable build", async () => {
    stubExtensionResponses(() => ({ ...validPing, configured: true, pairedToThisOrigin: true }));
    await expect(pingBridge()).resolves.toEqual({
      installed: true,
      supportsDiscovery: true,
      extensionId: "hmilkmcjlkpnigcfnlfogeafacjpmkbj",
      version: "0.8.0",
      configured: true,
      pairedToThisOrigin: true,
      pendingOffer: false,
      state: "not-configured",
      lastSuccessfulAt: null,
    });
  });

  it("prefers a discovery-capable extension over a legacy responder", async () => {
    stubExtensionResponses((extensionId) =>
      extensionId === "jmbijafllioopigmpacjkdjhbjkplndh"
        ? validPing
        : { ok: false, reason: "Not a bridge pairing offer" },
    );
    await expect(pingBridge()).resolves.toMatchObject({
      supportsDiscovery: true,
      extensionId: "jmbijafllioopigmpacjkdjhbjkplndh",
    });
  });

  it("fails closed to installed-only when ping fields are malformed", async () => {
    stubExtensionResponses(() => ({ ...validPing, pairedToThisOrigin: "yes" }));
    await expect(pingBridge()).resolves.toMatchObject({
      installed: true,
      supportsDiscovery: false,
    });
  });
});

describe("bridge extension league discovery", () => {
  it("validates and passes through discovered leagues", async () => {
    stubExtensionResponses((extensionId, message) => {
      expect(extensionId).toBe("hmilkmcjlkpnigcfnlfogeafacjpmkbj");
      expect(message).toEqual({ type: "DISCOVER_LEAGUES", season: 2026 });
      return {
        ok: true,
        state: "ok",
        seasonMatched: true,
        leagues: [
          {
            leagueId: "111222333",
            leagueName: "  Championship Chasers ",
            teamName: "Laces Out!",
            seasonId: 2026,
          },
          { leagueId: "not-digits", leagueName: "Broken", seasonId: 2026 },
          { leagueId: "444", leagueName: "", seasonId: 2026 },
          { leagueId: "555", leagueName: "No Season", seasonId: 1999 },
        ],
      };
    });
    await expect(discoverLeagues("hmilkmcjlkpnigcfnlfogeafacjpmkbj", 2026)).resolves.toEqual({
      ok: true,
      seasonMatched: true,
      leagues: [
        {
          leagueId: "111222333",
          leagueName: "Championship Chasers",
          teamName: "Laces Out!",
          seasonId: 2026,
        },
      ],
    });
  });

  it("passes through login-required with a bounded reason", async () => {
    stubExtensionResponses(() => ({
      ok: false,
      state: "espn-login-required",
      reason: "Sign in to ESPN in this browser, then try again.",
    }));
    await expect(discoverLeagues("hmilkmcjlkpnigcfnlfogeafacjpmkbj", 2026)).resolves.toEqual({
      ok: false,
      state: "espn-login-required",
      reason: "Sign in to ESPN in this browser, then try again.",
    });
  });

  it("maps missing runtimes and malformed responses to unavailable", async () => {
    await expect(discoverLeagues("hmilkmcjlkpnigcfnlfogeafacjpmkbj", 2026)).resolves.toEqual({
      ok: false,
      state: "unavailable",
    });
    stubExtensionResponses(() => ({ ok: true, state: "ok", leagues: "not-an-array" }));
    await expect(discoverLeagues("hmilkmcjlkpnigcfnlfogeafacjpmkbj", 2026)).resolves.toEqual({
      ok: false,
      state: "unavailable",
    });
  });
});
