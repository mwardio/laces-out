import type { LeagueId, PlayerId, TeamId } from "./ids.js";
import type { NflTeam, PlayerStatus, Position } from "./football.js";
import type { RosterSlot, RosterSlotType } from "./roster.js";

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  readonly positions: readonly Position[];
  readonly nflTeam?: NflTeam;
  readonly byeWeek?: number;
  readonly status?: PlayerStatus;
  /** Provider-normalized overrides for unusual dual eligibility. */
  readonly eligibleSlotTypes?: readonly RosterSlotType[];
}

export interface FantasyTeam {
  readonly id: TeamId;
  readonly leagueId: LeagueId;
  readonly name: string;
  readonly managerName?: string;
  readonly isManagedByUser?: boolean;
}

export interface League {
  readonly id: LeagueId;
  readonly name: string;
  readonly season: number;
  readonly teamIds: readonly TeamId[];
  readonly rosterSlots: readonly RosterSlot[];
  readonly scoringType?: "STANDARD" | "HALF_PPR" | "PPR" | "CUSTOM";
}

export interface RosteredPlayer {
  readonly player: Player;
  readonly acquiredAt?: string;
  readonly acquisitionType?: "DRAFT" | "WAIVER" | "FREE_AGENT" | "TRADE" | "KEEPER";
}

export interface TeamRoster {
  readonly teamId: TeamId;
  readonly players: readonly RosteredPlayer[];
}
