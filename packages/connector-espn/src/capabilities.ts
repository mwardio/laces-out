import { defineProviderCapabilities } from "@fantasy/connectors";

export const ESPN_PUBLIC_READ_CAPABILITIES = defineProviderCapabilities({
  provider: "espn",
  authority: "unofficial",
  authentication: ["public-none"],
  accountData: "public-only",
  read: {
    discoverLeagues: false,
    settings: true,
    rosters: true,
    matchups: true,
    transactions: false,
    availablePlayers: false,
    draft: "none",
  },
  write: {
    lineup: false,
    transactions: false,
    trades: false,
    draft: false,
  },
  caveats: [
    "ESPN does not document this endpoint as a supported third-party Fantasy API.",
    "Only leagues readable without authentication are in scope.",
    "The endpoint contract may change without notice; the browser bridge remains the supported path.",
  ],
});

export const ESPN_BROWSER_BRIDGE_CAPABILITIES = defineProviderCapabilities({
  provider: "espn",
  authority: "unofficial",
  authentication: ["browser-session"],
  accountData: "authorized-private",
  read: {
    discoverLeagues: false,
    settings: true,
    rosters: true,
    matchups: true,
    transactions: true,
    availablePlayers: true,
    draft: "completed",
  },
  write: {
    lineup: false,
    transactions: false,
    trades: false,
    draft: false,
  },
  caveats: [
    "ESPN does not document these Fantasy endpoints as a supported third-party API.",
    "The signed browser bridge reads only explicitly paired leagues from the user's ESPN session.",
    "Core league sync remains usable when an independently admitted supplemental view drifts.",
  ],
});
