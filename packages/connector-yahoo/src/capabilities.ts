import { defineProviderCapabilities } from "@laces-out/connectors";

export const YAHOO_CAPABILITIES = defineProviderCapabilities({
  provider: "yahoo",
  authority: "official",
  authentication: ["oauth2-authorization-code-pkce"],
  accountData: "authorized-private",
  read: {
    discoverLeagues: true,
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
    "Fantasy API application approval is required.",
    "Initial integration is read-only.",
    "Transactions, available-player reads, and draft polling are not enabled in the application.",
    "Draft polling latency and auction result fields require an approved-app contract test before enablement.",
  ],
});
