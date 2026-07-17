import type { ProviderId } from "./capabilities.js";

export const NORMALIZED_SYNC_SCHEMA_VERSION = 1 as const;

export type DraftType = "snake" | "auction" | "offline" | "unknown";

export type WaiverType = "faab" | "rolling" | "reverse-standings" | "free-agent" | "unknown";

export interface NormalizedRosterSlot {
  readonly position: string;
  readonly count: number;
  readonly starting: boolean;
}

export interface NormalizedScoringRule {
  readonly statId: string;
  readonly name: string | null;
  readonly points: number;
}

export interface NormalizedLeagueSettings {
  readonly teamCount: number;
  readonly draftType: DraftType;
  readonly auctionBudget: number | null;
  readonly waiverType: WaiverType;
  readonly faabBudget: number | null;
  readonly playoffTeamCount: number | null;
  readonly rosterSlots: readonly NormalizedRosterSlot[];
  readonly scoringRules: readonly NormalizedScoringRule[];
}

export interface NormalizedManager {
  readonly externalId: string | null;
  readonly displayName: string;
  readonly isCommissioner: boolean;
}

export interface NormalizedRosterPlayer {
  /** Complete provider key when one exists; never a season-ambiguous bare ID. */
  readonly externalId: string;
  readonly providerPlayerId: string;
  readonly fullName: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: readonly string[];
  readonly lineupSlot: string;
  readonly proTeamAbbreviation: string | null;
  readonly status: string | null;
}

export interface NormalizedTeam {
  readonly externalId: string;
  readonly providerTeamId: string;
  readonly name: string;
  readonly abbreviation: string | null;
  readonly url: string | null;
  readonly logoUrl: string | null;
  readonly isCurrentUser: boolean;
  readonly managers: readonly NormalizedManager[];
  readonly roster: readonly NormalizedRosterPlayer[];
}

export interface NormalizedLeague {
  /** Complete season-scoped provider key where the provider has one. */
  readonly externalId: string;
  readonly providerLeagueId: string;
  readonly provider: ProviderId;
  readonly season: number;
  readonly name: string;
  readonly url: string | null;
  readonly currentWeek: number | null;
  readonly settings: NormalizedLeagueSettings;
}

export type NormalizedStandingStreakType = "win" | "loss" | "tie" | "none";

export interface NormalizedStandingEntry {
  /** Season-scoped normalized team key used to join this row to `teams`. */
  readonly teamExternalId: string;
  /** Provider-native team ID retained as text so decimal IDs are never rounded. */
  readonly providerTeamId: string;
  readonly rank: number;
  readonly playoffSeed: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;
  readonly streakType: NormalizedStandingStreakType;
  readonly streakLength: number;
}

export interface NormalizedStandingsSnapshot {
  readonly asOfWeek: number | null;
  readonly entries: readonly NormalizedStandingEntry[];
}

export type NormalizedMatchupStatus = "scheduled" | "in-progress" | "final";

export interface NormalizedMatchupTeam {
  /** Season-scoped normalized team key used to join this side to `teams`. */
  readonly teamExternalId: string;
  /** Provider-native team ID retained as text so decimal IDs are never rounded. */
  readonly providerTeamId: string;
  readonly score: number | null;
}

export interface NormalizedWeeklyMatchup {
  /** Complete season/league-scoped normalized matchup key. */
  readonly externalId: string;
  /** Provider-native matchup ID retained as text. */
  readonly providerMatchupId: string;
  readonly week: number;
  readonly status: NormalizedMatchupStatus;
  readonly home: NormalizedMatchupTeam;
  readonly away: NormalizedMatchupTeam;
  readonly winnerTeamExternalId: string | null;
  readonly tied: boolean;
}

export interface NormalizedMatchupSnapshot {
  readonly asOfWeek: number | null;
  readonly matchups: readonly NormalizedWeeklyMatchup[];
}

export type SyncSourceMode =
  "official-api" | "browser-local" | "public-unofficial" | "manual-import";

export interface SyncProvenance {
  readonly mode: SyncSourceMode;
  readonly fetchedAt: string;
  readonly endpoint: string | null;
  readonly artifactChecksumSha256: string | null;
}

export interface LeagueSyncBundle {
  readonly schemaVersion: typeof NORMALIZED_SYNC_SCHEMA_VERSION;
  readonly provider: ProviderId;
  readonly league: NormalizedLeague;
  readonly teams: readonly NormalizedTeam[];
  readonly standings?: NormalizedStandingsSnapshot;
  readonly matchups?: NormalizedMatchupSnapshot;
  readonly provenance: SyncProvenance;
  readonly warnings: readonly string[];
}

export interface ExternalLeagueRef {
  readonly provider: ProviderId;
  readonly externalId: string;
  readonly providerLeagueId: string;
  readonly season: number;
  readonly name: string;
}

export interface ExternalDraftRef {
  readonly provider: ProviderId;
  readonly leagueExternalId: string;
  readonly draftExternalId: string;
}

export interface NormalizedDraftEvent {
  readonly externalId: string;
  readonly sequence: number;
  readonly occurredAt: string | null;
  readonly teamExternalId: string;
  readonly playerExternalId: string;
  readonly amount: number | null;
}

export interface DraftDelta {
  readonly events: readonly NormalizedDraftEvent[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
}
