import { describe, expect, it } from "vitest";

import type { BridgePingOutcome } from "./bridge-extension";
import {
  deriveEspnPairingStep,
  pairingOfferTtlMs,
  type EspnPairingFlowInputs,
} from "./espn-pairing-flow";

const now = 1_700_000_000_000;

const base: EspnPairingFlowInputs = {
  publishedOrigin: true,
  discovering: false,
  now,
  selfHostedPairing: false,
};

const capable: BridgePingOutcome = {
  installed: true,
  supportsDiscovery: true,
  extensionId: "hmilkmcjlkpnigcfnlfogeafacjpmkbj",
  configured: false,
  pairedToThisOrigin: false,
  pendingOffer: false,
  state: "not-configured",
  lastSuccessfulAt: null,
};

describe("ESPN pairing step derivation", () => {
  it("starts at checking until the first ping resolves", () => {
    expect(deriveEspnPairingStep(base)).toBe("checking");
  });

  it("routes missing extensions by origin kind", () => {
    const missing: BridgePingOutcome = { installed: false, supportsDiscovery: false };
    expect(deriveEspnPairingStep({ ...base, ping: missing })).toBe("extension-missing");
    expect(deriveEspnPairingStep({ ...base, ping: missing, publishedOrigin: false })).toBe(
      "legacy-form",
    );
  });

  it("degrades to the legacy form for installed builds without discovery", () => {
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: { installed: true, supportsDiscovery: false, extensionId: "x".repeat(32) },
      }),
    ).toBe("legacy-form");
  });

  it("walks discover → selecting → offer-sent on the happy path", () => {
    expect(deriveEspnPairingStep({ ...base, ping: capable })).toBe("ready-to-discover");
    expect(deriveEspnPairingStep({ ...base, ping: capable, discovering: true })).toBe(
      "discovering",
    );
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: capable,
        discovery: { ok: true, leagues: [], seasonMatched: true },
      }),
    ).toBe("league-selection");
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: capable,
        discovery: { ok: true, leagues: [], seasonMatched: true },
        offerSentAt: now - 1000,
      }),
    ).toBe("offer-sent");
  });

  it("surfaces ESPN sign-in only when discovery reports it", () => {
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: capable,
        discovery: { ok: false, state: "espn-login-required" },
      }),
    ).toBe("espn-login-required");
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: capable,
        discovery: { ok: false, state: "error", reason: "ESPN returned status 500." },
      }),
    ).toBe("ready-to-discover");
  });

  it("expires an unconfirmed offer at the extension's TTL", () => {
    expect(
      deriveEspnPairingStep({ ...base, ping: capable, offerSentAt: now - pairingOfferTtlMs }),
    ).toBe("offer-expired");
  });

  it("flips to paired states once the extension reports pairing to this origin", () => {
    const paired: BridgePingOutcome = {
      ...capable,
      configured: true,
      pairedToThisOrigin: true,
      state: "ready",
    };
    expect(deriveEspnPairingStep({ ...base, ping: paired, offerSentAt: now - 1000 })).toBe(
      "paired-syncing",
    );
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: { ...paired, state: "syncing" },
      }),
    ).toBe("paired-syncing");
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: { ...paired, state: "healthy", lastSuccessfulAt: "2026-08-06T00:00:00.000Z" },
      }),
    ).toBe("connected");
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: { ...paired, state: "error" },
      }),
    ).toBe("connected");
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: { ...paired, state: "espn-login-required" },
      }),
    ).toBe("espn-login-required");
  });

  it("keeps a re-pair offer in front of the existing pairing until confirmed", () => {
    const paired: BridgePingOutcome = {
      ...capable,
      configured: true,
      pairedToThisOrigin: true,
      pendingOffer: true,
      state: "healthy",
      lastSuccessfulAt: "2026-08-06T00:00:00.000Z",
    };
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: paired,
        pingAt: now,
        offerSentAt: now - 1000,
      }),
    ).toBe("offer-sent");
  });

  it("treats a dismissed offer as expired only from a probe newer than the offer", () => {
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: capable,
        pingAt: now,
        offerSentAt: now - 1000,
      }),
    ).toBe("offer-expired");
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: capable,
        pingAt: now - 5000,
        offerSentAt: now - 1000,
      }),
    ).toBe("offer-sent");
  });

  it("keeps showing the self-hosted code card above everything else", () => {
    expect(
      deriveEspnPairingStep({
        ...base,
        ping: capable,
        selfHostedPairing: true,
        offerSentAt: now - 1000,
      }),
    ).toBe("self-hosted-code");
  });
});
