import type { BridgePingOutcome, DiscoverLeaguesOutcome } from "./bridge-extension";

// Mirrors the extension's pending-offer TTL (apps/espn-bridge/src/protocol.ts):
// past this age the extension will discard the offer, so the page stops telling
// the member a confirmation is still waiting.
export const pairingOfferTtlMs = 10 * 60 * 1000;

export type EspnPairingStep =
  | "checking"
  | "extension-missing"
  | "legacy-form"
  | "ready-to-discover"
  | "discovering"
  | "espn-login-required"
  | "league-selection"
  | "offer-sent"
  | "offer-expired"
  | "paired-syncing"
  | "connected"
  | "self-hosted-code";

export interface EspnPairingFlowInputs {
  /** Latest extension probe; undefined until the first pingBridge resolves. */
  readonly ping?: BridgePingOutcome | undefined;
  /** Epoch ms when `ping` resolved; used to ignore probes older than the offer. */
  readonly pingAt?: number | undefined;
  /** window.location.origin is one of the published hosted origins. */
  readonly publishedOrigin: boolean;
  readonly discovering: boolean;
  /** Latest discovery result, if any. */
  readonly discovery?: DiscoverLeaguesOutcome | undefined;
  /** Epoch ms when the extension accepted a pairing offer as pending. */
  readonly offerSentAt?: number | undefined;
  readonly now: number;
  /** A self-hosted pairing-code card is currently showing. */
  readonly selfHostedPairing: boolean;
}

// Sync states that mean the paired extension finished (or conclusively failed)
// its first pass, as opposed to still working toward one.
const settledBridgeStates = new Set([
  "healthy",
  "partial-failure",
  "error",
  "laces-out-auth-failed",
]);

/**
 * Derives which pairing step the /connections ESPN panel shows. Pure so every
 * transition is unit-testable; the component owns timers, polling, and fetches
 * and feeds their outcomes in here.
 */
export function deriveEspnPairingStep(inputs: EspnPairingFlowInputs): EspnPairingStep {
  if (inputs.selfHostedPairing) return "self-hosted-code";
  const { ping } = inputs;
  const offerActive = inputs.offerSentAt !== undefined;
  const offerFresh =
    inputs.offerSentAt !== undefined && inputs.now - inputs.offerSentAt < pairingOfferTtlMs;
  // An offer the extension still holds outranks any previous pairing: when a
  // paired browser re-pairs (new leagues, new season), the waiting confirmation
  // is what matters, not the old configuration.
  if (offerActive && ping?.pendingOffer === true) {
    return offerFresh ? "offer-sent" : "offer-expired";
  }
  if (ping?.pairedToThisOrigin === true) {
    if (ping.state === "espn-login-required") return "espn-login-required";
    if (
      (typeof ping.lastSuccessfulAt === "string" && ping.lastSuccessfulAt !== "") ||
      settledBridgeStates.has(ping.state ?? "")
    ) {
      return "connected";
    }
    return "paired-syncing";
  }
  if (offerActive) {
    // A discovery-capable extension that no longer holds the offer and is not
    // paired means the member dismissed it in the popup — surface that instead
    // of waiting out the TTL. Only a probe taken after the offer counts; an
    // older one predates the offer's storage write. Legacy builds cannot
    // report either way.
    const pingPostdatesOffer =
      inputs.pingAt !== undefined &&
      inputs.offerSentAt !== undefined &&
      inputs.pingAt > inputs.offerSentAt;
    if (ping?.pendingOffer === false && ping.supportsDiscovery && pingPostdatesOffer) {
      return "offer-expired";
    }
    return offerFresh ? "offer-sent" : "offer-expired";
  }
  if (ping === undefined) return "checking";
  if (!ping.installed) {
    // Off the published origins the extension cannot be messaged even when
    // installed (externally_connectable), so the classic form with its
    // pairing-code fallback is the only workable path.
    return inputs.publishedOrigin ? "extension-missing" : "legacy-form";
  }
  if (!ping.supportsDiscovery) return "legacy-form";
  if (inputs.discovering) return "discovering";
  if (inputs.discovery !== undefined) {
    if (inputs.discovery.ok) return "league-selection";
    if (inputs.discovery.state === "espn-login-required") return "espn-login-required";
    // Discovery errored: fall through to the discover button so the member can
    // retry; the component surfaces the error text alongside it.
  }
  return "ready-to-discover";
}
