import type { DraftSessionSnapshot } from "@laces-out/contracts";

/**
 * Browsers may request a refresh more often than Yahoo is queried. The API owns the provider
 * throttle and coalesces every open browser into one official read per league.
 */
export const YAHOO_DRAFT_REFRESH_REQUEST_MS = 15_000;

export const YAHOO_DRAFT_ASSIST_COPY = {
  label: "Automatically check Yahoo for picks (beta)",
  detail:
    "Laces Out checks Yahoo's official draft results up to every 15 seconds during an active draft. Automatic importing stays gated by format validation; manual entry remains available.",
  safety:
    "Read-only. By enabling this, you confirm the draft has no keepers or traded picks; Laces Out never submits actions to Yahoo.",
} as const;

export function draftLedgerStateLabel(
  transport: DraftSessionSnapshot["transport"],
  state: DraftSessionSnapshot["persistedState"],
): string {
  return transport === "yahoo-assisted" && state === "live" ? "in progress" : state;
}

export function yahooAssistAvailable(
  provider: string | null | undefined,
  serverSupported: boolean,
): boolean {
  return provider === "yahoo" && serverSupported;
}

export function yahooAssistSelection(
  provider: string | null | undefined,
  optedIn: boolean,
  serverSupported: boolean,
): "yahoo" | undefined {
  return yahooAssistAvailable(provider, serverSupported) && optedIn ? "yahoo" : undefined;
}

export function draftRoomStartLabel(
  provider: string | null | undefined,
  optedIn: boolean,
  serverSupported: boolean,
): "Start assisted room" | "Start manual room" {
  return yahooAssistSelection(provider, optedIn, serverSupported) === "yahoo"
    ? "Start assisted room"
    : "Start manual room";
}

export function shouldRequestYahooDraftRefresh(
  session: Pick<DraftSessionSnapshot, "transport" | "providerFeed"> | null,
): boolean {
  return (
    session?.transport === "yahoo-assisted" &&
    session.providerFeed?.provider === "yahoo" &&
    session.providerFeed.state !== "complete"
  );
}

interface ProviderManualEntryState {
  readonly transport: DraftSessionSnapshot["transport"];
  readonly providerFeed:
    | null
    | { readonly provider: "espn"; readonly manualBackupActive: boolean }
    | { readonly provider: "yahoo" };
}

/** Yahoo reconciliation is append-only, so managers never need to switch into a backup mode. */
export function providerLocksManualDraftEntry(session: ProviderManualEntryState | null): boolean {
  return (
    session?.transport === "espn-live" &&
    session.providerFeed?.provider === "espn" &&
    !session.providerFeed.manualBackupActive
  );
}
