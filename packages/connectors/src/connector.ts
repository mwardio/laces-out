import type { ProviderCapabilities, ProviderId } from "./capabilities.js";
import type {
  DraftDelta,
  ExternalDraftRef,
  ExternalLeagueRef,
  LeagueSyncBundle,
} from "./normalized.js";

export interface ConnectorContext<TCredential> {
  readonly connectionId: string;
  readonly correlationId: string;
  readonly credential: TCredential;
  readonly signal: AbortSignal | undefined;
}

export interface SyncFailure {
  readonly stage: "discovery" | "settings" | "teams" | "rosters" | "draft";
  readonly code: string;
  /** Sanitized for display/logging; provider response bodies do not belong here. */
  readonly message: string;
  readonly retryable: boolean;
}

export type LeagueSyncResult =
  | {
      readonly status: "complete";
      readonly bundle: LeagueSyncBundle;
      readonly failures: readonly [];
    }
  | {
      readonly status: "partial";
      readonly bundle: LeagueSyncBundle;
      readonly failures: readonly SyncFailure[];
    };

/** Provider adapter port. Persistence and token rotation remain caller-owned. */
export interface FantasyConnector<TCredential> {
  readonly provider: ProviderId;
  readonly capabilities: Readonly<ProviderCapabilities>;

  discoverLeagues(context: ConnectorContext<TCredential>): Promise<readonly ExternalLeagueRef[]>;

  syncLeague(
    context: ConnectorContext<TCredential>,
    league: ExternalLeagueRef,
  ): Promise<LeagueSyncResult>;

  syncDraft?(
    context: ConnectorContext<TCredential>,
    draft: ExternalDraftRef,
    cursor?: string,
  ): Promise<DraftDelta>;
}
