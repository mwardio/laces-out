export type ProviderId = "yahoo" | "espn";

export type ProviderAuthority = "official" | "unofficial" | "manual";

export type AuthenticationCapability =
  | "oauth2-authorization-code-pkce"
  | "browser-session"
  | "server-session-cookie"
  | "public-none"
  | "manual-import";

export type DraftReadCapability = "none" | "completed" | "polling-unverified" | "live";

export interface ProviderReadCapabilities {
  readonly discoverLeagues: boolean;
  readonly settings: boolean;
  readonly rosters: boolean;
  readonly matchups: boolean;
  readonly transactions: boolean;
  readonly availablePlayers: boolean;
  readonly draft: DraftReadCapability;
}

export interface ProviderWriteCapabilities {
  readonly lineup: boolean;
  readonly transactions: boolean;
  readonly trades: boolean;
  readonly draft: boolean;
}

/**
 * A truthful, UI-safe description of a provider integration. Capabilities are
 * deliberately more explicit than a single `connected` boolean so unsupported
 * provider behavior cannot accidentally appear enabled.
 */
export interface ProviderCapabilities {
  readonly provider: ProviderId;
  readonly authority: ProviderAuthority;
  readonly authentication: readonly AuthenticationCapability[];
  readonly accountData: "authorized-private" | "public-only" | "user-supplied";
  readonly read: ProviderReadCapabilities;
  readonly write: ProviderWriteCapabilities;
  readonly caveats: readonly string[];
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Validate capability combinations once, close to the adapter definition. */
export function defineProviderCapabilities(
  capabilities: ProviderCapabilities,
): Readonly<ProviderCapabilities> {
  const hasWriteCapability = Object.values(capabilities.write).some(Boolean);
  if (hasWriteCapability && capabilities.authority !== "official") {
    throw new TypeError("Unofficial and manual connectors cannot advertise write capability");
  }

  if (
    capabilities.accountData === "authorized-private" &&
    !capabilities.authentication.some((mode) =>
      ["oauth2-authorization-code-pkce", "browser-session", "server-session-cookie"].includes(mode),
    )
  ) {
    throw new TypeError("Private account data requires an authorized authentication mode");
  }

  if (
    capabilities.authority === "manual" &&
    !capabilities.authentication.includes("manual-import")
  ) {
    throw new TypeError("Manual providers must advertise manual import authentication");
  }

  return deepFreeze(capabilities);
}
