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
  /** Optional provider-observed operating rules used to guard recommendations and explain timing. */
  readonly operationalRules?: {
    readonly acquisitionLimit: number | null;
    /** The per-matchup acquisition count in force, or `null` when no count is in force or known. */
    readonly matchupAcquisitionLimit: number | null;
    /**
     * Whether a per-matchup acquisition limit applies at all, or `null` when the provider did not
     * say. A provider can report that a limit applies without reporting its count, so `true` with a
     * `null` {@link matchupAcquisitionLimit} means "limited, count unknown" — not "unlimited".
     */
    readonly matchupAcquisitionLimitEnabled: boolean | null;
    readonly minimumBid: number | null;
    /**
     * Waiver processing days as `Date.prototype.getDay()` numbers (0 = Sunday), de-duplicated and
     * ascending. Empty means the provider schedules no processing day, which is a real answer.
     */
    readonly waiverProcessDays: readonly number[];
    readonly waiverProcessHour: number | null;
    readonly keeperCount: number | null;
    readonly regularSeasonMatchupPeriods: number | null;
    readonly playoffMatchupPeriodLength: number | null;
    readonly playoffSeedingRule: string | null;
    readonly matchupTieRule: string | null;
    readonly playoffMatchupTieRule: string | null;
    readonly scoringType: string | null;
    readonly medianGameEnabled: boolean | null;
    readonly tradeDeadlineAt: string | null;
    readonly tradeReviewHours: number | null;
    readonly vetoVotesRequired: number | null;
    readonly divisions: readonly {
      readonly providerDivisionId: string;
      readonly name: string;
    }[];
  };
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
  /** Null means the provider did not expose a trustworthy current value. */
  readonly faabRemaining?: number | null;
  /** One-based provider waiver priority when available. */
  readonly waiverPriority?: number | null;
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

export type NormalizedAvailabilityStatus = "free-agent" | "waivers";

export interface NormalizedAvailablePlayer {
  /** Complete season-scoped provider key. */
  readonly externalId: string;
  readonly providerPlayerId: string;
  readonly fullName: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: readonly string[];
  readonly proTeamAbbreviation: string | null;
  readonly injuryStatus: string | null;
  readonly availability: NormalizedAvailabilityStatus;
  readonly percentOwned: number | null;
  readonly percentStarted: number | null;
  readonly ownershipTrend: number | null;
}

export interface NormalizedSupplementalContext {
  readonly provider: ProviderId;
  readonly leagueExternalId: string;
  readonly providerLeagueId: string;
  readonly season: number;
  readonly provenance: SyncProvenance;
  readonly warnings: readonly string[];
}

export interface NormalizedAvailablePlayerSnapshot extends NormalizedSupplementalContext {
  readonly kind: "available-players";
  readonly asOfWeek: number;
  readonly availability: NormalizedAvailabilityStatus;
  /**
   * True when the provider response hit the requested result cap. Consumers must treat a
   * truncated observation as a useful ranked candidate pool, never as proof that an omitted
   * player is rostered.
   */
  readonly truncated: boolean;
  readonly players: readonly NormalizedAvailablePlayer[];
}

export interface NormalizedFantasyPlayerWeekScore {
  readonly teamExternalId: string;
  readonly providerTeamId: string;
  readonly playerExternalId: string;
  readonly providerPlayerId: string;
  readonly lineupSlot: string;
  readonly starter: boolean;
  /** Null means ESPN omitted an actual-stat row; it is not silently converted to zero. */
  readonly actualPoints: number | null;
  readonly projectedPoints: number | null;
  /** League-scored contribution by provider stat ID when ESPN supplied it. */
  readonly appliedStats: Readonly<Record<string, number>>;
}

export interface NormalizedFantasyTeamWeekScore {
  readonly teamExternalId: string;
  readonly providerTeamId: string;
  readonly totalPoints: number;
}

export interface NormalizedFantasyMatchupWeekScore {
  readonly externalId: string;
  readonly providerMatchupId: string;
  readonly home: NormalizedFantasyTeamWeekScore;
  readonly away: NormalizedFantasyTeamWeekScore;
}

export interface NormalizedWeeklyBoxScoreSnapshot extends NormalizedSupplementalContext {
  readonly kind: "weekly-box-scores";
  readonly week: number;
  readonly matchups: readonly NormalizedFantasyMatchupWeekScore[];
  readonly playerScores: readonly NormalizedFantasyPlayerWeekScore[];
}

export type NormalizedTransactionType = "free-agent" | "waiver" | "trade" | "lineup" | "draft";

export type NormalizedTransactionStatus =
  "pending" | "executed" | "cancelled" | "failed" | "unknown";

export type NormalizedTransactionItemType = "add" | "drop" | "trade" | "lineup" | "draft";

export interface NormalizedTransactionItem {
  readonly sequence: number;
  readonly type: NormalizedTransactionItemType;
  readonly playerExternalId: string;
  readonly providerPlayerId: string;
  readonly fromTeamExternalId: string | null;
  readonly fromProviderTeamId: string | null;
  readonly toTeamExternalId: string | null;
  readonly toProviderTeamId: string | null;
  readonly fromLineupSlot: string | null;
  readonly toLineupSlot: string | null;
}

export interface NormalizedFantasyTransaction {
  readonly externalId: string;
  readonly providerTransactionId: string;
  readonly scoringPeriodId: number;
  readonly type: NormalizedTransactionType;
  readonly providerType: string;
  readonly status: NormalizedTransactionStatus;
  readonly providerStatus: string | null;
  readonly executionType: string;
  readonly teamExternalId: string | null;
  readonly providerTeamId: string | null;
  readonly bidAmount: number | null;
  readonly proposedAt: string | null;
  readonly processedAt: string | null;
  readonly items: readonly NormalizedTransactionItem[];
}

export interface NormalizedTransactionSnapshot extends NormalizedSupplementalContext {
  readonly kind: "transactions";
  readonly week: number;
  readonly transactions: readonly NormalizedFantasyTransaction[];
}

export interface NormalizedCompletedDraftPick {
  readonly externalId: string;
  readonly providerPickId: string;
  readonly sequence: number;
  readonly round: number;
  readonly roundPick: number;
  readonly teamExternalId: string;
  readonly providerTeamId: string;
  readonly playerExternalId: string;
  readonly providerPlayerId: string;
  readonly nominatingTeamExternalId: string | null;
  readonly nominatingProviderTeamId: string | null;
  readonly amount: number | null;
  readonly keeper: boolean;
}

export interface NormalizedCompletedDraftSnapshot extends NormalizedSupplementalContext {
  readonly kind: "completed-draft";
  readonly draftType: Extract<DraftType, "snake" | "auction">;
  readonly budgetPerTeam: number | null;
  readonly state: "in-progress" | "complete";
  readonly completedAt: string | null;
  readonly picks: readonly NormalizedCompletedDraftPick[];
}

export type LeagueSupplementalBundle =
  | NormalizedAvailablePlayerSnapshot
  | NormalizedWeeklyBoxScoreSnapshot
  | NormalizedTransactionSnapshot
  | NormalizedCompletedDraftSnapshot;
