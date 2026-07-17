import { defineProviderCapabilities } from "@fantasy/connectors";

export const ESPN_MANUAL_IMPORT_CAPABILITIES = defineProviderCapabilities({
  provider: "espn",
  authority: "manual",
  authentication: ["manual-import"],
  accountData: "user-supplied",
  read: {
    discoverLeagues: false,
    settings: true,
    rosters: true,
    matchups: false,
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
    "Canonical imports are snapshots and must be re-imported to refresh data.",
    "No ESPN credentials, cookies, or passwords are accepted.",
    "All provider actions are completed by the user on ESPN.",
  ],
});

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
    "The endpoint contract may change without notice; manual import remains the durable path.",
  ],
});
