import {
  assignPlayersToRosterSlots,
  type DraftEventId,
  type Player,
  type PlayerId,
  type TeamId,
} from "@laces-out/domain";

import { maximumLegalBid } from "./auction.js";
import {
  DraftInvariantError,
  type AuctionNominationState,
  type DraftConfig,
  type DraftEvent,
  type DraftState,
  type DraftTeamConfig,
  type DraftTeamState,
  type DraftedPlayer,
} from "./types.js";

interface MutableTeamState {
  readonly config: DraftTeamConfig;
  readonly roster: DraftedPlayer[];
  spent: number;
}

interface ResolvedEvents {
  readonly active: readonly DraftEvent[];
  readonly revertedIds: readonly DraftEventId[];
}

function resolveActiveEvents(events: readonly DraftEvent[]): ResolvedEvents {
  const indexById = new Map<DraftEventId, number>();
  for (const [index, event] of events.entries()) {
    if (indexById.has(event.id)) {
      throw new DraftInvariantError(
        "DUPLICATE_EVENT_ID",
        `Draft event ID ${event.id} appears more than once`,
        event.id,
      );
    }
    indexById.set(event.id, index);
    if (event.type === "DRAFT_EVENT_REVERTED") {
      const targetIndex = indexById.get(event.targetEventId);
      if (targetIndex === undefined || targetIndex >= index) {
        throw new DraftInvariantError(
          "INVALID_REVERT_TARGET",
          `Revert event ${event.id} must target an earlier event`,
          event.id,
        );
      }
    }
  }

  const suppressed = new Set<DraftEventId>();
  const active: DraftEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (suppressed.has(event.id)) {
      continue;
    }
    active.push(event);
    if (event.type === "DRAFT_EVENT_REVERTED") {
      suppressed.add(event.targetEventId);
    }
  }

  active.reverse();
  return {
    active,
    revertedIds: [...suppressed].sort((left, right) => left.localeCompare(right)),
  };
}

function validateConfig(config: DraftConfig): void {
  if (
    config.teams.length < 2 ||
    new Set(config.teams.map((team) => team.id)).size !== config.teams.length
  ) {
    throw new DraftInvariantError("INVALID_CONFIG", "Draft configuration requires unique teams");
  }
  if (new Set(config.players.map((player) => player.id)).size !== config.players.length) {
    throw new DraftInvariantError("INVALID_CONFIG", "Draft player IDs must be unique");
  }
  for (const team of config.teams) {
    if (team.rosterSlots.length === 0) {
      throw new DraftInvariantError("INVALID_CONFIG", `Team ${team.id} has no roster slots`);
    }
  }
  if (config.mode === "SNAKE") {
    const teamIds = new Set(config.teams.map((team) => team.id));
    if (config.pickOrder.length === 0 || config.pickOrder.some((id) => !teamIds.has(id))) {
      throw new DraftInvariantError("INVALID_CONFIG", "Snake pick order contains an unknown team");
    }
    for (const team of config.teams) {
      const ownedPicks = config.pickOrder.filter((id) => id === team.id).length;
      if (ownedPicks > team.rosterSlots.length) {
        throw new DraftInvariantError(
          "INVALID_CONFIG",
          `Team ${team.id} owns more picks than available roster slots`,
        );
      }
    }
  } else {
    if (!Number.isSafeInteger(config.minimumBid) || config.minimumBid < 0) {
      throw new DraftInvariantError("INVALID_CONFIG", "Auction minimum bid must be non-negative");
    }
    for (const team of config.teams) {
      if (!Number.isSafeInteger(team.budget) || team.budget === undefined || team.budget < 0) {
        throw new DraftInvariantError(
          "INVALID_CONFIG",
          `Auction team ${team.id} requires a non-negative integer budget`,
        );
      }
      if (team.budget < team.rosterSlots.length * config.minimumBid) {
        throw new DraftInvariantError(
          "INVALID_CONFIG",
          `Auction team ${team.id} cannot fund the minimum bid for every slot`,
        );
      }
    }
  }
}

function requireTeam(
  teams: ReadonlyMap<TeamId, MutableTeamState>,
  id: TeamId,
  event: DraftEvent,
): MutableTeamState {
  const team = teams.get(id);
  if (team === undefined) {
    throw new DraftInvariantError("UNKNOWN_TEAM", `Unknown team ${id}`, event.id);
  }
  return team;
}

function requirePlayer(
  players: ReadonlyMap<PlayerId, Player>,
  id: PlayerId,
  event: DraftEvent,
): Player {
  const player = players.get(id);
  if (player === undefined) {
    throw new DraftInvariantError("UNKNOWN_PLAYER", `Unknown player ${id}`, event.id);
  }
  return player;
}

function assertRosterLegal(
  team: MutableTeamState,
  playerById: ReadonlyMap<PlayerId, Player>,
  event: DraftEvent,
): void {
  const players = team.roster.map((item) => playerById.get(item.playerId)!);
  const result = assignPlayersToRosterSlots(players, team.config.rosterSlots);
  if (!result.feasible) {
    throw new DraftInvariantError(
      "ROSTER_ILLEGAL",
      `Adding player ${"playerId" in event ? event.playerId : ""} makes team ${team.config.id}'s roster illegal`,
      event.id,
    );
  }
}

export function reduceDraft(config: DraftConfig, events: readonly DraftEvent[]): DraftState {
  validateConfig(config);
  const resolved = resolveActiveEvents(events);
  const activeActions = resolved.active.filter((event) => event.type !== "DRAFT_EVENT_REVERTED");
  const teamById = new Map<TeamId, MutableTeamState>(
    config.teams.map((team) => [team.id, { config: team, roster: [], spent: 0 }]),
  );
  const playerById = new Map(config.players.map((player) => [player.id, player]));
  const draftedPlayerIds = new Set<PlayerId>();
  const consumedPicks = new Set<number>();
  let activeNomination: AuctionNominationState | null = null;

  const addPlayer = (event: DraftEvent, team: MutableTeamState, drafted: DraftedPlayer): void => {
    requirePlayer(playerById, drafted.playerId, event);
    if (draftedPlayerIds.has(drafted.playerId)) {
      throw new DraftInvariantError(
        "PLAYER_ALREADY_DRAFTED",
        `Player ${drafted.playerId} has already been drafted`,
        event.id,
      );
    }
    team.roster.push(drafted);
    assertRosterLegal(team, playerById, event);
    draftedPlayerIds.add(drafted.playerId);
  };

  const nextOpenPick = (): number | null => {
    for (
      let index = 0;
      index < (config.mode === "SNAKE" ? config.pickOrder.length : 0);
      index += 1
    ) {
      const overallPick = index + 1;
      if (!consumedPicks.has(overallPick)) {
        return overallPick;
      }
    }
    return null;
  };

  const addAuctionPlayer = (
    event: DraftEvent,
    team: MutableTeamState,
    playerId: PlayerId,
    price: number,
    acquisition: "AUCTION" | "AUCTION_KEEPER",
  ): void => {
    if (config.mode !== "AUCTION") {
      throw new DraftInvariantError(
        "WRONG_DRAFT_MODE",
        `${event.type} requires an auction draft`,
        event.id,
      );
    }
    const minimumPrice = acquisition === "AUCTION" ? config.minimumBid : 0;
    if (!Number.isSafeInteger(price) || price < minimumPrice) {
      throw new DraftInvariantError("INVALID_PRICE", `Auction price ${price} is invalid`, event.id);
    }
    const budget = team.config.budget!;
    const openSlotsBefore = team.config.rosterSlots.length - team.roster.length;
    const legalMax = maximumLegalBid(budget - team.spent, openSlotsBefore, config.minimumBid);
    if (price > legalMax) {
      throw new DraftInvariantError(
        "BUDGET_EXCEEDED",
        `Price ${price} exceeds team ${team.config.id}'s legal maximum bid of ${legalMax}`,
        event.id,
      );
    }
    addPlayer(event, team, { playerId, eventId: event.id, acquisition, price });
    team.spent += price;
  };

  for (const event of activeActions) {
    switch (event.type) {
      case "SNAKE_KEEPER_ASSIGNED": {
        if (config.mode !== "SNAKE") {
          throw new DraftInvariantError(
            "WRONG_DRAFT_MODE",
            "Snake keeper requires a snake draft",
            event.id,
          );
        }
        const expectedTeamId = config.pickOrder[event.overallPick - 1];
        if (
          !Number.isSafeInteger(event.overallPick) ||
          expectedTeamId === undefined ||
          expectedTeamId !== event.teamId ||
          consumedPicks.has(event.overallPick)
        ) {
          throw new DraftInvariantError(
            "WRONG_PICK",
            "Keeper does not own the specified pick",
            event.id,
          );
        }
        const team = requireTeam(teamById, event.teamId, event);
        addPlayer(event, team, {
          playerId: event.playerId,
          eventId: event.id,
          acquisition: "SNAKE_KEEPER",
          overallPick: event.overallPick,
        });
        consumedPicks.add(event.overallPick);
        break;
      }
      case "SNAKE_PLAYER_SELECTED": {
        if (config.mode !== "SNAKE") {
          throw new DraftInvariantError(
            "WRONG_DRAFT_MODE",
            "Snake selection requires a snake draft",
            event.id,
          );
        }
        const expectedPick = nextOpenPick();
        const expectedTeamId =
          expectedPick === null ? undefined : config.pickOrder[expectedPick - 1];
        if (event.overallPick !== expectedPick || event.teamId !== expectedTeamId) {
          throw new DraftInvariantError(
            "WRONG_PICK",
            `Expected pick ${expectedPick ?? "none"} by ${expectedTeamId ?? "no team"}`,
            event.id,
          );
        }
        const team = requireTeam(teamById, event.teamId, event);
        addPlayer(event, team, {
          playerId: event.playerId,
          eventId: event.id,
          acquisition: "SNAKE_PICK",
          overallPick: event.overallPick,
        });
        consumedPicks.add(event.overallPick);
        break;
      }
      case "AUCTION_KEEPER_ASSIGNED": {
        const team = requireTeam(teamById, event.teamId, event);
        addAuctionPlayer(event, team, event.playerId, event.price, "AUCTION_KEEPER");
        break;
      }
      case "AUCTION_NOMINATION_STARTED": {
        if (config.mode !== "AUCTION") {
          throw new DraftInvariantError(
            "WRONG_DRAFT_MODE",
            "Nomination requires an auction draft",
            event.id,
          );
        }
        requireTeam(teamById, event.teamId, event);
        requirePlayer(playerById, event.playerId, event);
        if (draftedPlayerIds.has(event.playerId) || activeNomination !== null) {
          throw new DraftInvariantError(
            "NOMINATION_CONFLICT",
            "Cannot nominate a drafted player or start two simultaneous nominations",
            event.id,
          );
        }
        if (!Number.isSafeInteger(event.nominationNumber) || event.nominationNumber <= 0) {
          throw new DraftInvariantError(
            "NOMINATION_CONFLICT",
            "Nomination number must be positive",
            event.id,
          );
        }
        activeNomination = {
          nominationNumber: event.nominationNumber,
          playerId: event.playerId,
          nominatorTeamId: event.teamId,
          highBidTeamId: null,
          highBid: null,
        };
        break;
      }
      case "AUCTION_BID_PLACED": {
        if (config.mode !== "AUCTION") {
          throw new DraftInvariantError(
            "WRONG_DRAFT_MODE",
            "Bid requires an auction draft",
            event.id,
          );
        }
        const team = requireTeam(teamById, event.teamId, event);
        if (
          activeNomination === null ||
          activeNomination.playerId !== event.playerId ||
          !Number.isSafeInteger(event.amount) ||
          event.amount < config.minimumBid ||
          (activeNomination.highBid !== null && event.amount <= activeNomination.highBid)
        ) {
          throw new DraftInvariantError(
            "INVALID_BID",
            "Bid does not advance the active nomination",
            event.id,
          );
        }
        const legalMax = maximumLegalBid(
          team.config.budget! - team.spent,
          team.config.rosterSlots.length - team.roster.length,
          config.minimumBid,
        );
        if (event.amount > legalMax) {
          throw new DraftInvariantError(
            "BUDGET_EXCEEDED",
            "Bid exceeds the team's legal maximum",
            event.id,
          );
        }
        const nominatedPlayer = requirePlayer(playerById, event.playerId, event);
        if (
          !assignPlayersToRosterSlots(
            [...team.roster.map((item) => playerById.get(item.playerId)!), nominatedPlayer],
            team.config.rosterSlots,
          ).feasible
        ) {
          throw new DraftInvariantError(
            "ROSTER_ILLEGAL",
            "Bidder cannot legally roster the player",
            event.id,
          );
        }
        const currentNomination: AuctionNominationState = activeNomination;
        activeNomination = {
          nominationNumber: currentNomination.nominationNumber,
          playerId: currentNomination.playerId,
          nominatorTeamId: currentNomination.nominatorTeamId,
          highBidTeamId: event.teamId,
          highBid: event.amount,
        };
        break;
      }
      case "AUCTION_PLAYER_SOLD": {
        const team = requireTeam(teamById, event.teamId, event);
        if (
          activeNomination !== null &&
          (activeNomination.playerId !== event.playerId ||
            (activeNomination.highBidTeamId !== null &&
              activeNomination.highBidTeamId !== event.teamId) ||
            (activeNomination.highBid !== null && activeNomination.highBid !== event.price))
        ) {
          throw new DraftInvariantError(
            "NOMINATION_CONFLICT",
            "Sale does not match the active nomination and high bid",
            event.id,
          );
        }
        addAuctionPlayer(event, team, event.playerId, event.price, "AUCTION");
        activeNomination = null;
        break;
      }
    }
  }

  const teams: DraftTeamState[] = config.teams.map((teamConfig) => {
    const team = teamById.get(teamConfig.id)!;
    const openSlots = teamConfig.rosterSlots.length - team.roster.length;
    if (config.mode === "SNAKE") {
      return {
        teamId: teamConfig.id,
        name: teamConfig.name,
        roster: team.roster,
        openSlots,
      };
    }
    const remainingBudget = teamConfig.budget! - team.spent;
    return {
      teamId: teamConfig.id,
      name: teamConfig.name,
      roster: team.roster,
      openSlots,
      spent: team.spent,
      remainingBudget,
      maximumBid: maximumLegalBid(remainingBudget, openSlots, config.minimumBid),
    };
  });
  const upcomingPick = config.mode === "SNAKE" ? nextOpenPick() : null;
  const nextPick =
    config.mode === "SNAKE" && upcomingPick !== null
      ? { overallPick: upcomingPick, teamId: config.pickOrder[upcomingPick - 1]! }
      : null;
  const complete =
    config.mode === "SNAKE"
      ? nextPick === null
      : teams.every((team) => team.openSlots === 0) && activeNomination === null;

  return {
    mode: config.mode,
    teams,
    draftedPlayerIds: [...draftedPlayerIds].sort((left, right) => left.localeCompare(right)),
    activeEventIds: resolved.active.map((event) => event.id),
    revertedEventIds: resolved.revertedIds,
    nextPick,
    activeNomination,
    complete,
  };
}

export function latestUndoableEvent(events: readonly DraftEvent[]): DraftEvent | null {
  const resolved = resolveActiveEvents(events);
  for (let index = resolved.active.length - 1; index >= 0; index -= 1) {
    const event = resolved.active[index]!;
    if (event.type !== "DRAFT_EVENT_REVERTED") {
      return event;
    }
  }
  return null;
}
