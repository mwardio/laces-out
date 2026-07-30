import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bridgeExtensionIds,
  chromeWebStoreUrl,
  publishedBridgeAcceptsOrigin,
  sendPairingOffer,
} from "./bridge-extension";

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
