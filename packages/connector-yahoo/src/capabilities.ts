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
    draft: "polling-unverified",
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
    "Transactions and available-player reads are not enabled in the application.",
    "Draft results are official cumulative reads, not a push or websocket feed; product admission remains format-specific.",
  ],
});
