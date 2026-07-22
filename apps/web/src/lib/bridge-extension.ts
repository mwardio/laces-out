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
