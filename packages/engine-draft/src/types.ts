import type { DraftEventId, Player, PlayerId, RosterSlot, TeamId } from "@fantasy/domain";

export interface DraftTeamConfig {
  readonly id: TeamId;
  readonly name: string;
  readonly rosterSlots: readonly RosterSlot[];
  /** Required for auction drafts and ignored for snake drafts. */
  readonly budget?: number;
}

interface DraftConfigBase {
  readonly teams: readonly DraftTeamConfig[];
  readonly players: readonly Player[];
}

export interface SnakeDraftConfig extends DraftConfigBase {
  readonly mode: "SNAKE";
  /** Complete overall pick ownership order; supports traded/custom picks. */
  readonly pickOrder: readonly TeamId[];
}

export interface AuctionDraftConfig extends DraftConfigBase {
  readonly mode: "AUCTION";
  readonly minimumBid: number;
}

export type DraftConfig = SnakeDraftConfig | AuctionDraftConfig;

interface DraftEventBase {
  readonly id: DraftEventId;
  readonly occurredAt?: string;
}

export interface SnakePlayerSelectedEvent extends DraftEventBase {
  readonly type: "SNAKE_PLAYER_SELECTED";
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly overallPick: number;
}

export interface SnakeKeeperAssignedEvent extends DraftEventBase {
  readonly type: "SNAKE_KEEPER_ASSIGNED";
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly overallPick: number;
}

export interface AuctionKeeperAssignedEvent extends DraftEventBase {
  readonly type: "AUCTION_KEEPER_ASSIGNED";
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly price: number;
}

export interface AuctionNominationStartedEvent extends DraftEventBase {
  readonly type: "AUCTION_NOMINATION_STARTED";
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly nominationNumber: number;
}

export interface AuctionBidPlacedEvent extends DraftEventBase {
  readonly type: "AUCTION_BID_PLACED";
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly amount: number;
}

export interface AuctionPlayerSoldEvent extends DraftEventBase {
  readonly type: "AUCTION_PLAYER_SOLD";
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly price: number;
}

export interface DraftEventRevertedEvent extends DraftEventBase {
  readonly type: "DRAFT_EVENT_REVERTED";
  readonly targetEventId: DraftEventId;
}

export type DraftEvent =
  | SnakePlayerSelectedEvent
  | SnakeKeeperAssignedEvent
  | AuctionKeeperAssignedEvent
  | AuctionNominationStartedEvent
  | AuctionBidPlacedEvent
  | AuctionPlayerSoldEvent
  | DraftEventRevertedEvent;

export interface DraftedPlayer {
  readonly playerId: PlayerId;
  readonly eventId: DraftEventId;
  readonly acquisition: "SNAKE_PICK" | "SNAKE_KEEPER" | "AUCTION" | "AUCTION_KEEPER";
  readonly overallPick?: number;
  readonly price?: number;
}

export interface DraftTeamState {
  readonly teamId: TeamId;
  readonly name: string;
  readonly roster: readonly DraftedPlayer[];
  readonly openSlots: number;
  readonly spent?: number;
  readonly remainingBudget?: number;
  readonly maximumBid?: number;
}

export interface AuctionNominationState {
  readonly nominationNumber: number;
  readonly playerId: PlayerId;
  readonly nominatorTeamId: TeamId;
  readonly highBidTeamId: TeamId | null;
  readonly highBid: number | null;
}

export interface DraftState {
  readonly mode: DraftConfig["mode"];
  readonly teams: readonly DraftTeamState[];
  readonly draftedPlayerIds: readonly PlayerId[];
  readonly activeEventIds: readonly DraftEventId[];
  readonly revertedEventIds: readonly DraftEventId[];
  readonly nextPick: { readonly overallPick: number; readonly teamId: TeamId } | null;
  readonly activeNomination: AuctionNominationState | null;
  readonly complete: boolean;
}

export type DraftInvariantCode =
  | "INVALID_CONFIG"
  | "DUPLICATE_EVENT_ID"
  | "INVALID_REVERT_TARGET"
  | "WRONG_DRAFT_MODE"
  | "UNKNOWN_TEAM"
  | "UNKNOWN_PLAYER"
  | "PLAYER_ALREADY_DRAFTED"
  | "WRONG_PICK"
  | "ROSTER_ILLEGAL"
  | "INVALID_PRICE"
  | "BUDGET_EXCEEDED"
  | "NOMINATION_CONFLICT"
  | "INVALID_BID";

export class DraftInvariantError extends Error {
  public readonly code: DraftInvariantCode;
  public readonly eventId: DraftEventId | undefined;

  public constructor(code: DraftInvariantCode, message: string, eventId?: DraftEventId) {
    super(message);
    this.name = "DraftInvariantError";
    this.code = code;
    this.eventId = eventId;
  }
}
