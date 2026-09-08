import type { DraftSessionSnapshot } from "@laces-out/contracts";

/** Browser requests are coalesced by the API's database lease across every viewer. */
export const ESPN_DRAFT_REFRESH_REQUEST_MS = 5_000;

export const ESPN_DRAFT_ASSIST_COPY = {
  label: "Automatically sync ESPN results",
  detail:
    "Laces Out checks ESPN for completed picks about every 5 seconds during the draft. Current nominations and in-flight bids are not included in this result-only source.",
  safety:
    "Read-only. Manual entry remains available; Laces Out never bids, nominates, drafts a player, or changes anything in ESPN.",
} as const;

export function espnAssistAvailable(
  provider: string | null | undefined,
  serverSupported: boolean,
): boolean {
  return provider === "espn" && serverSupported;
}

export function espnAssistSelection(
  provider: string | null | undefined,
  optedIn: boolean,
  serverSupported: boolean,
): "espn" | undefined {
  return espnAssistAvailable(provider, serverSupported) && optedIn ? "espn" : undefined;
}

export function shouldRequestEspnDraftRefresh(
  session: Pick<DraftSessionSnapshot, "transport" | "providerFeed"> | null,
): boolean {
  return (
    session?.transport === "espn-live" &&
    session.providerFeed?.provider === "espn" &&
    session.providerFeed.state !== "complete"
  );
}
