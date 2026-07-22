import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgeExtensionIds, chromeWebStoreUrl, sendPairingOffer } from "./bridge-extension";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bridge extension pairing", () => {
  it("targets the published Chrome Web Store listing first", () => {
    expect(chromeWebStoreUrl).toContain(bridgeExtensionIds()[0] ?? "missing-extension-id");
    expect(bridgeExtensionIds()[0]).toBe("hmilkmcjlkpnigcfnlfogeafacjpmkbj");
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
