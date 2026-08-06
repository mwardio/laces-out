// Web-to-extension pairing for the Laces Out ESPN bridge companion.
//
// A Chromium page allowed by the extension's `externally_connectable` manifest
// can post a PAIRING_OFFER to the extension. The extension stores it as a
// pending offer and the user completes pairing from the extension popup, so the
// device token never has to be copied by hand. The token is only ever sent in
// this message payload — never placed in a URL, logged, or written to the
// clipboard automatically.

// The published Chrome Web Store extension ID. Store IDs are assigned at first
// publish and are permanent across every subsequent update, so baking it in is
// safe; NEXT_PUBLIC_BRIDGE_EXTENSION_ID remains available as an override for a
// future re-listing without a code change.
const storeExtensionId = "hmilkmcjlkpnigcfnlfogeafacjpmkbj";

export const chromeWebStoreUrl =
  "https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj";

const publishedBridgeOrigins = new Set(["https://laces.mward.io", "https://lacesout.app"]);

export function publishedBridgeAcceptsOrigin(origin: string): boolean {
  try {
    return publishedBridgeOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

// The stable unpacked dev-build extension ID, derived from the public `key`
// pinned in apps/espn-bridge/manifest.json.
const devExtensionId = "jmbijafllioopigmpacjkdjhbjkplndh";

function extensionIdIsValid(value: string): boolean {
  return /^[a-p]{32}$/u.test(value);
}

export function bridgeExtensionIds(): readonly string[] {
  // Store first: the published build is what nearly every paired browser runs.
  const ids = [storeExtensionId, devExtensionId];
  const overrideId = process.env.NEXT_PUBLIC_BRIDGE_EXTENSION_ID;
  if (
    typeof overrideId === "string" &&
    extensionIdIsValid(overrideId) &&
    !ids.includes(overrideId)
  ) {
    ids.unshift(overrideId);
  }
  return ids;
}

export interface PairingOfferPayload {
  readonly apiBaseUrl: string;
  readonly deviceToken: string;
  readonly leagues: readonly string[];
  readonly season: number;
}

// Minimal, local shape for the one chrome API this module touches, so the web
// app does not need the global @types/chrome package.
type ChromeSendMessage = (
  extensionId: string,
  message: unknown,
  responseCallback: (response: unknown) => void,
) => void;

interface ChromeRuntimeLike {
  readonly runtime?: {
    readonly sendMessage?: ChromeSendMessage;
    readonly lastError?: { readonly message?: string } | undefined;
  };
}

function chromeRuntime(): Required<ChromeRuntimeLike>["runtime"] | undefined {
  const candidate = (globalThis as { chrome?: ChromeRuntimeLike }).chrome;
  return candidate?.runtime?.sendMessage ? candidate.runtime : undefined;
}

function offerToExtension(
  runtime: NonNullable<ReturnType<typeof chromeRuntime>>,
  extensionId: string,
  payload: PairingOfferPayload,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      runtime.sendMessage?.(
        extensionId,
        {
          type: "PAIRING_OFFER",
          apiBaseUrl: payload.apiBaseUrl,
          deviceToken: payload.deviceToken,
          leagues: payload.leagues,
          season: payload.season,
        },
        (response: unknown) => {
          // Reading lastError clears Chrome's "unchecked runtime.lastError"
          // warning when no extension with this ID is installed.
          void runtime.lastError;
          resolve(
            typeof response === "object" &&
              response !== null &&
              (response as { ok?: unknown }).ok === true,
          );
        },
      );
    } catch {
      resolve(false);
    }
  });
}

export interface PairingOfferOutcome {
  readonly ok: boolean;
  readonly extensionId?: string;
}

export interface ServerSessionOfferOutcome {
  readonly ok: boolean;
  readonly extensionId?: string;
  readonly state?: string;
  readonly message?: string;
}

function offerServerSessionToExtension(
  runtime: NonNullable<ReturnType<typeof chromeRuntime>>,
  extensionId: string,
): Promise<ServerSessionOfferOutcome> {
  return new Promise((resolve) => {
    try {
      runtime.sendMessage?.(extensionId, { type: "ENABLE_SERVER_SESSION" }, (response: unknown) => {
        void runtime.lastError;
        if (typeof response !== "object" || response === null) {
          resolve({ ok: false });
          return;
        }
        const record = response as {
          ok?: unknown;
          status?: { state?: unknown; message?: unknown };
        };
        resolve({
          ok: record.ok === true,
          extensionId,
          ...(typeof record.status?.state === "string" ? { state: record.status.state } : {}),
          ...(typeof record.status?.message === "string" ? { message: record.status.message } : {}),
        });
      });
    } catch {
      resolve({ ok: false });
    }
  });
}

export async function sendServerSessionOffer(): Promise<ServerSessionOfferOutcome> {
  const runtime = chromeRuntime();
  if (!runtime) return { ok: false };
  for (const extensionId of bridgeExtensionIds()) {
    const outcome = await offerServerSessionToExtension(runtime, extensionId);
    if (outcome.ok || outcome.state !== undefined) return outcome;
  }
  return { ok: false };
}

// Tries each known extension ID in order, resolving on the first that accepts
// the offer. Resolves { ok: false } if none respond (extension not installed).
export async function sendPairingOffer(payload: PairingOfferPayload): Promise<PairingOfferOutcome> {
  const runtime = chromeRuntime();
  if (!runtime) return { ok: false };
  for (const extensionId of bridgeExtensionIds()) {
    if (await offerToExtension(runtime, extensionId, payload)) {
      return { ok: true, extensionId };
    }
  }
  return { ok: false };
}

export interface BridgePingOutcome {
  readonly installed: boolean;
  readonly supportsDiscovery: boolean;
  readonly extensionId?: string;
  readonly version?: string;
  readonly configured?: boolean;
  readonly pairedToThisOrigin?: boolean;
  readonly pendingOffer?: boolean;
  readonly state?: string;
  readonly lastSuccessfulAt?: string | null;
}

export interface DiscoveredEspnLeague {
  readonly leagueId: string;
  readonly leagueName: string;
  readonly teamName?: string;
  readonly seasonId: number;
}

export type DiscoverLeaguesOutcome =
  | {
      readonly ok: true;
      readonly leagues: readonly DiscoveredEspnLeague[];
      readonly seasonMatched: boolean;
    }
  | {
      readonly ok: false;
      readonly state: "espn-login-required" | "error" | "unavailable";
      readonly reason?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendToExtension(
  runtime: NonNullable<ReturnType<typeof chromeRuntime>>,
  extensionId: string,
  message: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      runtime.sendMessage?.(extensionId, message, (response: unknown) => {
        void runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

// An extension build that predates BRIDGE_PING still answers — its external
// listener replies with a pairing-offer rejection ({ ok: false, reason }). Any
// response object therefore proves the extension is installed; only the full
// validated ping shape proves it supports league discovery.
function pingOutcomeFromResponse(
  response: unknown,
  extensionId: string,
): BridgePingOutcome | undefined {
  if (response === undefined || response === null) return undefined;
  if (!isRecord(response)) return { installed: true, supportsDiscovery: false, extensionId };
  if (
    response.ok === true &&
    response.discovery === true &&
    typeof response.version === "string" &&
    typeof response.configured === "boolean" &&
    typeof response.pairedToThisOrigin === "boolean" &&
    typeof response.pendingOffer === "boolean" &&
    typeof response.state === "string" &&
    (response.lastSuccessfulAt === null || typeof response.lastSuccessfulAt === "string")
  ) {
    return {
      installed: true,
      supportsDiscovery: true,
      extensionId,
      version: response.version.slice(0, 32),
      configured: response.configured,
      pairedToThisOrigin: response.pairedToThisOrigin,
      pendingOffer: response.pendingOffer,
      state: response.state.slice(0, 64),
      lastSuccessfulAt: response.lastSuccessfulAt,
    };
  }
  return { installed: true, supportsDiscovery: false, extensionId };
}

// Probes every known extension ID, preferring a discovery-capable build over a
// merely-installed legacy one when both answer.
export async function pingBridge(): Promise<BridgePingOutcome> {
  const runtime = chromeRuntime();
  if (!runtime) return { installed: false, supportsDiscovery: false };
  let installedOnly: BridgePingOutcome | undefined;
  for (const extensionId of bridgeExtensionIds()) {
    const outcome = pingOutcomeFromResponse(
      await sendToExtension(runtime, extensionId, { type: "BRIDGE_PING" }),
      extensionId,
    );
    if (outcome?.supportsDiscovery) return outcome;
    installedOnly ??= outcome;
  }
  return installedOnly ?? { installed: false, supportsDiscovery: false };
}

function discoveredLeagueFromResponse(value: unknown): DiscoveredEspnLeague | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.leagueId !== "string" || !/^\d{1,20}$/u.test(value.leagueId)) return undefined;
  if (typeof value.leagueName !== "string" || value.leagueName.trim() === "") return undefined;
  if (
    typeof value.seasonId !== "number" ||
    !Number.isSafeInteger(value.seasonId) ||
    value.seasonId < 2000 ||
    value.seasonId > 2100
  ) {
    return undefined;
  }
  const teamName = typeof value.teamName === "string" ? value.teamName.trim().slice(0, 120) : "";
  return {
    leagueId: value.leagueId,
    leagueName: value.leagueName.trim().slice(0, 120),
    ...(teamName === "" ? {} : { teamName }),
    seasonId: value.seasonId,
  };
}

// Asks one specific extension (the ID that answered the ping) for the ESPN
// leagues on the signed-in account. The response is re-validated field by field
// before it can reach React state.
export async function discoverLeagues(
  extensionId: string,
  season: number,
): Promise<DiscoverLeaguesOutcome> {
  const runtime = chromeRuntime();
  if (!runtime) return { ok: false, state: "unavailable" };
  const response = await sendToExtension(runtime, extensionId, {
    type: "DISCOVER_LEAGUES",
    season,
  });
  if (!isRecord(response)) return { ok: false, state: "unavailable" };
  if (response.ok === true && response.state === "ok" && Array.isArray(response.leagues)) {
    const leagues = response.leagues
      .map(discoveredLeagueFromResponse)
      .filter((league): league is DiscoveredEspnLeague => league !== undefined)
      .slice(0, 32);
    return { ok: true, leagues, seasonMatched: response.seasonMatched === true };
  }
  if (
    response.ok === false &&
    (response.state === "espn-login-required" || response.state === "error")
  ) {
    return {
      ok: false,
      state: response.state,
      ...(typeof response.reason === "string" ? { reason: response.reason.slice(0, 200) } : {}),
    };
  }
  return { ok: false, state: "unavailable" };
}
