import {
  assignPlayersToRosterSlots,
  draftEventId,
  type Player,
  type PlayerId,
  type Position,
  type TeamId,
} from "@laces-out/domain";

import { maximumLegalBid } from "./auction.js";
import { reduceDraft } from "./reducer.js";
import type {
  AuctionDraftConfig,
  DraftEvent,
  DraftState,
  DraftTeamConfig,
  SnakeDraftConfig,
} from "./types.js";

export interface MockPlayerMarket {
  readonly playerId: PlayerId;
  /** Overall average draft position. Lower is selected earlier. */
  readonly adp: number;
  /** Baseline auction value in whole draft dollars. */
  readonly auctionValue?: number;
}

export type MockDraftStopReason =
  | "COMPLETE"
  | "CONTROLLED_PICK"
  | "CONTROLLED_NOMINATION"
  | "EVENT_LIMIT"
  | "PLAYER_POOL_EXHAUSTED";

export interface MockDraftSimulationResult {
  readonly seed: string;
  readonly events: readonly DraftEvent[];
  readonly generatedEvents: readonly DraftEvent[];
  readonly state: DraftState;
  readonly stopReason: MockDraftStopReason;
}

interface MockDraftInputBase {
  readonly seed: string;
  readonly market: readonly MockPlayerMarket[];
  /** Existing immutable event stream. Simulation resumes from its reduced state. */
  readonly events?: readonly DraftEvent[];
  /** These teams are never controlled by the simulator. */
  readonly controlledTeamIds?: readonly TeamId[];
  /** Maximum newly generated events. Useful for stepping and replay tests. */
  readonly eventLimit?: number;
}

export interface SnakeMockDraftInput extends MockDraftInputBase {
  readonly config: SnakeDraftConfig;
  /** Maximum random movement around ADP, measured in overall-pick equivalents. */
  readonly adpNoise?: number;
  /** Recent picks inspected for a position run. */
  readonly positionRunWindow?: number;
  /** ADP-equivalent boost for each recent player at the same position. */
  readonly positionRunStrength?: number;
}

export interface AuctionMockDraftInput extends MockDraftInputBase {
  readonly config: AuctionDraftConfig;
  /** Maximum proportional variation in an opponent's private value. */
  readonly valueNoiseFraction?: number;
  /**
   * Keep nomination turns user-controlled while allowing the model to resolve
   * bidding for the focus team. Useful for an interactive auction mock where
   * the user practices nominations without manually clicking every bid.
   */
  readonly automateControlledTeamBids?: boolean;
}

interface SnakeCandidate {
  readonly player: Player;
  readonly market: MockPlayerMarket;
  readonly score: number;
}

interface AuctionBidder {
  readonly team: DraftTeamConfig;
  readonly willingness: number;
}

const DEFAULT_EVENT_LIMIT = 10_000;
const DEFAULT_ADP_NOISE = 8;
const DEFAULT_RUN_WINDOW = 6;
const DEFAULT_RUN_STRENGTH = 1.75;
const DEFAULT_AUCTION_NOISE = 0.12;

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable across processes and independent of call order. */
export function seededUnitInterval(seed: string, eventKey: string): number {
  if (seed.trim().length === 0) {
    throw new RangeError("Mock-draft seed must not be empty");
  }
  return hash32(`${seed}\u001f${eventKey}`) / 0x1_0000_0000;
}

/** Deterministic noise in the closed interval [-maximumMagnitude, +maximumMagnitude). */
export function boundedSeededNoise(
  seed: string,
  eventKey: string,
  maximumMagnitude: number,
): number {
  if (!Number.isFinite(maximumMagnitude) || maximumMagnitude < 0) {
    throw new RangeError("Noise magnitude must be a non-negative finite number");
  }
  return (seededUnitInterval(seed, eventKey) * 2 - 1) * maximumMagnitude;
}

function validateInput(input: MockDraftInputBase): number {
  if (input.seed.trim().length === 0) {
    throw new RangeError("Mock-draft seed must not be empty");
  }
  const eventLimit = input.eventLimit ?? DEFAULT_EVENT_LIMIT;
  if (!Number.isSafeInteger(eventLimit) || eventLimit <= 0) {
    throw new RangeError("Mock-draft event limit must be a positive integer");
  }
  const marketIds = new Set<PlayerId>();
  for (const row of input.market) {
    if (marketIds.has(row.playerId)) {
      throw new Error(`Mock-draft market contains duplicate player ${row.playerId}`);
    }
    marketIds.add(row.playerId);
    if (!Number.isFinite(row.adp) || row.adp <= 0) {
      throw new RangeError(`ADP for ${row.playerId} must be positive and finite`);
    }
    if (
      row.auctionValue !== undefined &&
      (!Number.isFinite(row.auctionValue) || row.auctionValue < 0)
    ) {
      throw new RangeError(`Auction value for ${row.playerId} must be non-negative and finite`);
    }
  }
  return eventLimit;
}

function validateModelNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}

function validateReferences(
  teams: readonly DraftTeamConfig[],
  players: readonly Player[],
  market: readonly MockPlayerMarket[],
  controlledTeamIds: readonly TeamId[],
): void {
  const teamIds = new Set(teams.map((team) => team.id));
  const playerIds = new Set(players.map((player) => player.id));
  for (const id of controlledTeamIds) {
    if (!teamIds.has(id)) {
      throw new Error(`Unknown controlled mock-draft team ${id}`);
    }
  }
  for (const row of market) {
    if (!playerIds.has(row.playerId)) {
      throw new Error(`Mock-draft market references unknown player ${row.playerId}`);
    }
  }
}

function rosterIsLegal(
  config: DraftTeamConfig,
  rosterPlayerIds: readonly PlayerId[],
  candidate: Player,
  playerById: ReadonlyMap<PlayerId, Player>,
): boolean {
  const players = rosterPlayerIds.map((id) => playerById.get(id));
  if (players.some((player) => player === undefined)) {
    return false;
  }
  return assignPlayersToRosterSlots([...(players as Player[]), candidate], config.rosterSlots)
    .feasible;
}

function primaryPosition(player: Player): Position {
  return player.positions[0] ?? "IDP";
}

function directStarterNeed(
  team: DraftTeamConfig,
  rosterPlayerIds: readonly PlayerId[],
  candidate: Player,
  playerById: ReadonlyMap<PlayerId, Player>,
): number {
  const position = primaryPosition(candidate);
  const directSlots = team.rosterSlots.filter(
    (slot) => slot.kind === "STARTER" && slot.type === position,
  ).length;
  const positionCount = rosterPlayerIds.reduce((count, id) => {
    const player = playerById.get(id);
    return count + (player !== undefined && primaryPosition(player) === position ? 1 : 0);
  }, 0);
  if (positionCount < directSlots) {
    return 1;
  }
  if ((position === "QB" || position === "K" || position === "DST") && directSlots > 0) {
    return -1;
  }
  return 0;
}

function activeActionEvents(
  events: readonly DraftEvent[],
  state: DraftState,
): readonly DraftEvent[] {
  const active = new Set(state.activeEventIds);
  return events.filter((event) => active.has(event.id) && event.type !== "DRAFT_EVENT_REVERTED");
}

function eventStreamFingerprint(events: readonly DraftEvent[]): string {
  return events.map((event) => event.id).join("|");
}

function makeEventId(seed: string, eventKey: string, events: readonly DraftEvent[]) {
  const branch = eventStreamFingerprint(events);
  const a = hash32(`${seed}|${eventKey}`).toString(36);
  const b = hash32(`${branch}|${eventKey}|${seed}`).toString(36);
  return draftEventId(`mock-${a}-${b}`);
}

function finish(
  seed: string,
  originalCount: number,
  events: readonly DraftEvent[],
  state: DraftState,
  stopReason: MockDraftStopReason,
): MockDraftSimulationResult {
  return {
    seed,
    events,
    generatedEvents: events.slice(originalCount),
    state,
    stopReason,
  };
}

function selectSnakePlayer(
  input: SnakeMockDraftInput,
  events: readonly DraftEvent[],
  state: DraftState,
  playerById: ReadonlyMap<PlayerId, Player>,
  marketById: ReadonlyMap<PlayerId, MockPlayerMarket>,
  team: DraftTeamConfig,
  adpNoise: number,
  runWindow: number,
  runStrength: number,
): Player | null {
  const teamState = state.teams.find((item) => item.teamId === team.id)!;
  const drafted = new Set(state.draftedPlayerIds);
  const recentPositions = activeActionEvents(events, state)
    .filter(
      (event) => event.type === "SNAKE_PLAYER_SELECTED" || event.type === "SNAKE_KEEPER_ASSIGNED",
    )
    .slice(-runWindow)
    .map((event) => playerById.get(event.playerId))
    .filter((player): player is Player => player !== undefined)
    .map(primaryPosition);
  const runCounts = new Map<Position, number>();
  for (const position of recentPositions) {
    runCounts.set(position, (runCounts.get(position) ?? 0) + 1);
  }

  const candidates: SnakeCandidate[] = [];
  for (const [id, market] of marketById) {
    const player = playerById.get(id);
    if (
      player === undefined ||
      drafted.has(id) ||
      !rosterIsLegal(
        team,
        teamState.roster.map((item) => item.playerId),
        player,
        playerById,
      )
    ) {
      continue;
    }
    const position = primaryPosition(player);
    const noise = boundedSeededNoise(
      input.seed,
      `snake:${state.nextPick?.overallPick ?? 0}:${team.id}:${id}`,
      adpNoise,
    );
    const runBoost = (runCounts.get(position) ?? 0) * runStrength;
    const need = directStarterNeed(
      team,
      teamState.roster.map((item) => item.playerId),
      player,
      playerById,
    );
    const needAdjustment = need > 0 ? -6 : need < 0 ? 10 : 0;
    candidates.push({ player, market, score: market.adp + noise - runBoost + needAdjustment });
  }

  candidates.sort(
    (left, right) =>
      left.score - right.score ||
      left.market.adp - right.market.adp ||
      left.player.id.localeCompare(right.player.id),
  );
  return candidates[0]?.player ?? null;
}

/**
 * Simulates unattended snake teams until completion, a controlled pick, the
 * event limit, or an exhausted legal player pool. The random choice for a pick
 * is keyed by seed + pick + team + player, so one-shot, stepped, and redo runs
 * make the same selection.
 */
export function simulateSnakeMockDraft(input: SnakeMockDraftInput): MockDraftSimulationResult {
  const eventLimit = validateInput(input);
  const adpNoise = input.adpNoise ?? DEFAULT_ADP_NOISE;
  const runWindow = input.positionRunWindow ?? DEFAULT_RUN_WINDOW;
  const runStrength = input.positionRunStrength ?? DEFAULT_RUN_STRENGTH;
  validateModelNumber(adpNoise, "Snake ADP noise");
  validateModelNumber(runStrength, "Snake position-run strength");
  if (!Number.isSafeInteger(runWindow) || runWindow < 0) {
    throw new RangeError("Snake position-run window must be a non-negative integer");
  }
  validateReferences(
    input.config.teams,
    input.config.players,
    input.market,
    input.controlledTeamIds ?? [],
  );

  const original = input.events ?? [];
  const events = [...original];
  const controlled = new Set(input.controlledTeamIds ?? []);
  const teamById = new Map(input.config.teams.map((team) => [team.id, team]));
  const playerById = new Map(input.config.players.map((player) => [player.id, player]));
  const marketById = new Map(input.market.map((row) => [row.playerId, row]));

  while (events.length - original.length < eventLimit) {
    const state = reduceDraft(input.config, events);
    if (state.complete) {
      return finish(input.seed, original.length, events, state, "COMPLETE");
    }
    const nextPick = state.nextPick!;
    if (controlled.has(nextPick.teamId)) {
      return finish(input.seed, original.length, events, state, "CONTROLLED_PICK");
    }
    const team = teamById.get(nextPick.teamId)!;
    const player = selectSnakePlayer(
      input,
      events,
      state,
      playerById,
      marketById,
      team,
      adpNoise,
      runWindow,
      runStrength,
    );
    if (player === null) {
      return finish(input.seed, original.length, events, state, "PLAYER_POOL_EXHAUSTED");
    }
    const eventKey = `snake-pick:${nextPick.overallPick}:${nextPick.teamId}:${player.id}`;
    events.push({
      id: makeEventId(input.seed, eventKey, events),
      type: "SNAKE_PLAYER_SELECTED",
      teamId: nextPick.teamId,
      playerId: player.id,
      overallPick: nextPick.overallPick,
    });
  }

  const state = reduceDraft(input.config, events);
  const reachedControlledPick = state.nextPick !== null && controlled.has(state.nextPick.teamId);
  return finish(
    input.seed,
    original.length,
    events,
    state,
    state.complete ? "COMPLETE" : reachedControlledPick ? "CONTROLLED_PICK" : "EVENT_LIMIT",
  );
}

function nextNominator(
  config: AuctionDraftConfig,
  events: readonly DraftEvent[],
  state: DraftState,
) {
  const lastNomination = activeActionEvents(events, state)
    .filter((event) => event.type === "AUCTION_NOMINATION_STARTED")
    .at(-1);
  const previousIndex =
    lastNomination === undefined
      ? -1
      : config.teams.findIndex((team) => team.id === lastNomination.teamId);
  for (let offset = 0; offset < config.teams.length; offset += 1) {
    const index = (previousIndex + 1 + offset) % config.teams.length;
    const team = config.teams[index]!;
    const teamState = state.teams.find((item) => item.teamId === team.id)!;
    if (teamState.openSlots > 0) {
      return team;
    }
  }
  return null;
}

function auctionNominationNumber(events: readonly DraftEvent[], state: DraftState): number {
  const latest = activeActionEvents(events, state)
    .filter((event) => event.type === "AUCTION_NOMINATION_STARTED")
    .reduce((maximum, event) => Math.max(maximum, event.nominationNumber), 0);
  return latest + 1;
}

function auctionCandidateIsLegalForAnyTeam(
  config: AuctionDraftConfig,
  state: DraftState,
  candidate: Player,
  playerById: ReadonlyMap<PlayerId, Player>,
): boolean {
  return config.teams.some((team) => {
    const teamState = state.teams.find((item) => item.teamId === team.id)!;
    return (
      teamState.openSlots > 0 &&
      rosterIsLegal(
        team,
        teamState.roster.map((item) => item.playerId),
        candidate,
        playerById,
      )
    );
  });
}

function selectAuctionNominee(
  input: AuctionMockDraftInput,
  state: DraftState,
  nominationNumber: number,
  nominator: DraftTeamConfig,
  playerById: ReadonlyMap<PlayerId, Player>,
  marketById: ReadonlyMap<PlayerId, MockPlayerMarket>,
): Player | null {
  const drafted = new Set(state.draftedPlayerIds);
  const teamState = state.teams.find((item) => item.teamId === nominator.id)!;
  const drainNomination =
    seededUnitInterval(input.seed, `auction-style:${nominationNumber}:${nominator.id}`) < 0.3;
  const candidates: { player: Player; score: number; adp: number }[] = [];
  for (const [id, market] of marketById) {
    const player = playerById.get(id);
    if (
      player === undefined ||
      drafted.has(id) ||
      market.auctionValue === undefined ||
      !auctionCandidateIsLegalForAnyTeam(input.config, state, player, playerById)
    ) {
      continue;
    }
    const need = directStarterNeed(
      nominator,
      teamState.roster.map((item) => item.playerId),
      player,
      playerById,
    );
    const noise = boundedSeededNoise(
      input.seed,
      `auction-nomination:${nominationNumber}:${nominator.id}:${id}`,
      Math.max(1, market.auctionValue * 0.08),
    );
    const needAdjustment = drainNomination ? (need < 0 ? 6 : -2) : need > 0 ? 7 : 0;
    candidates.push({
      player,
      score: market.auctionValue + noise + needAdjustment,
      adp: market.adp,
    });
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.adp - right.adp ||
      left.player.id.localeCompare(right.player.id),
  );
  return candidates[0]?.player ?? null;
}

function rankAuctionBidders(
  input: AuctionMockDraftInput,
  state: DraftState,
  player: Player,
  market: MockPlayerMarket,
  playerById: ReadonlyMap<PlayerId, Player>,
  controlled: ReadonlySet<TeamId>,
  noiseFraction: number,
): readonly AuctionBidder[] {
  const bidders: AuctionBidder[] = [];
  for (const team of input.config.teams) {
    if (controlled.has(team.id)) {
      continue;
    }
    const teamState = state.teams.find((item) => item.teamId === team.id)!;
    if (
      teamState.openSlots <= 0 ||
      !rosterIsLegal(
        team,
        teamState.roster.map((item) => item.playerId),
        player,
        playerById,
      )
    ) {
      continue;
    }
    const legalMaximum = maximumLegalBid(
      teamState.remainingBudget!,
      teamState.openSlots,
      input.config.minimumBid,
    );
    const need = directStarterNeed(
      team,
      teamState.roster.map((item) => item.playerId),
      player,
      playerById,
    );
    const needMultiplier = need > 0 ? 1.08 : need < 0 ? 0.88 : 1;
    const privateNoise = boundedSeededNoise(
      input.seed,
      `auction-value:${state.activeNomination?.nominationNumber ?? 0}:${team.id}:${player.id}`,
      noiseFraction,
    );
    const modeledValue = Math.max(
      input.config.minimumBid,
      Math.round((market.auctionValue ?? 0) * (1 + privateNoise) * needMultiplier),
    );
    const willingness = Math.min(legalMaximum, modeledValue);
    if (willingness >= input.config.minimumBid) {
      bidders.push({ team, willingness });
    }
  }
  bidders.sort(
    (left, right) =>
      right.willingness - left.willingness || left.team.id.localeCompare(right.team.id),
  );
  return bidders;
}

function nextAuctionEvent(
  input: AuctionMockDraftInput,
  events: readonly DraftEvent[],
  state: DraftState,
  playerById: ReadonlyMap<PlayerId, Player>,
  marketById: ReadonlyMap<PlayerId, MockPlayerMarket>,
  controlled: ReadonlySet<TeamId>,
  noiseFraction: number,
): DraftEvent | MockDraftStopReason {
  const nomination = state.activeNomination;
  if (nomination === null) {
    const number = auctionNominationNumber(events, state);
    const nominator = nextNominator(input.config, events, state);
    if (nominator === null) {
      return "PLAYER_POOL_EXHAUSTED";
    }
    if (controlled.has(nominator.id)) {
      return "CONTROLLED_NOMINATION";
    }
    const player = selectAuctionNominee(input, state, number, nominator, playerById, marketById);
    if (player === null) {
      return "PLAYER_POOL_EXHAUSTED";
    }
    const key = `auction-nomination:${number}:${nominator.id}:${player.id}`;
    return {
      id: makeEventId(input.seed, key, events),
      type: "AUCTION_NOMINATION_STARTED",
      teamId: nominator.id,
      playerId: player.id,
      nominationNumber: number,
    };
  }

  const player = playerById.get(nomination.playerId)!;
  const market = marketById.get(nomination.playerId);
  if (market === undefined || market.auctionValue === undefined) {
    return "PLAYER_POOL_EXHAUSTED";
  }
  const bidders = rankAuctionBidders(
    input,
    state,
    player,
    market,
    playerById,
    input.automateControlledTeamBids === true ? new Set<TeamId>() : controlled,
    noiseFraction,
  );
  const currentHighBid = nomination.highBid;
  const currentHighTeam = nomination.highBidTeamId;

  if (currentHighBid === null) {
    const leader = bidders[0];
    if (leader === undefined) {
      return "PLAYER_POOL_EXHAUSTED";
    }
    const challenger = bidders[1];
    const bidder = challenger ?? leader;
    const amount = challenger === undefined ? input.config.minimumBid : challenger.willingness;
    const key = `auction-bid:${nomination.nominationNumber}:${bidder.team.id}:${player.id}:${amount}`;
    return {
      id: makeEventId(input.seed, key, events),
      type: "AUCTION_BID_PLACED",
      teamId: bidder.team.id,
      playerId: player.id,
      amount,
    };
  }

  const leader = bidders.find(
    (bidder) => bidder.team.id !== currentHighTeam && bidder.willingness > currentHighBid,
  );
  if (leader !== undefined) {
    const amount = currentHighBid + 1;
    const key = `auction-bid:${nomination.nominationNumber}:${leader.team.id}:${player.id}:${amount}`;
    return {
      id: makeEventId(input.seed, key, events),
      type: "AUCTION_BID_PLACED",
      teamId: leader.team.id,
      playerId: player.id,
      amount,
    };
  }

  const key = `auction-sale:${nomination.nominationNumber}:${currentHighTeam}:${player.id}:${currentHighBid}`;
  return {
    id: makeEventId(input.seed, key, events),
    type: "AUCTION_PLAYER_SOLD",
    teamId: currentHighTeam!,
    playerId: player.id,
    price: currentHighBid,
  };
}

/**
 * Simulates auction nominations, private valuations, bids, and sales. The
 * reducer validates every emitted event, including roster legality and the
 * minimum-dollar reserve, so an opponent cannot overspend or strand slots.
 */
export function simulateAuctionMockDraft(input: AuctionMockDraftInput): MockDraftSimulationResult {
  const eventLimit = validateInput(input);
  const noiseFraction = input.valueNoiseFraction ?? DEFAULT_AUCTION_NOISE;
  validateModelNumber(noiseFraction, "Auction value-noise fraction");
  if (noiseFraction > 1) {
    throw new RangeError("Auction value-noise fraction must not exceed one");
  }
  validateReferences(
    input.config.teams,
    input.config.players,
    input.market,
    input.controlledTeamIds ?? [],
  );

  const original = input.events ?? [];
  const events = [...original];
  const controlled = new Set(input.controlledTeamIds ?? []);
  const playerById = new Map(input.config.players.map((player) => [player.id, player]));
  const marketById = new Map(input.market.map((row) => [row.playerId, row]));

  while (events.length - original.length < eventLimit) {
    const state = reduceDraft(input.config, events);
    if (state.complete) {
      return finish(input.seed, original.length, events, state, "COMPLETE");
    }
    const next = nextAuctionEvent(
      input,
      events,
      state,
      playerById,
      marketById,
      controlled,
      noiseFraction,
    );
    if (typeof next === "string") {
      return finish(input.seed, original.length, events, state, next);
    }
    events.push(next);
  }

  const state = reduceDraft(input.config, events);
  const pendingNominator =
    state.activeNomination === null ? nextNominator(input.config, events, state) : null;
  const reachedControlledNomination =
    pendingNominator !== null && controlled.has(pendingNominator.id);
  return finish(
    input.seed,
    original.length,
    events,
    state,
    state.complete
      ? "COMPLETE"
      : reachedControlledNomination
        ? "CONTROLLED_NOMINATION"
        : "EVENT_LIMIT",
  );
}
