import {
  draftEventId,
  playerId,
  rosterSlotId,
  teamId,
  type Player,
  type TeamId,
} from "@laces-out/domain";
import {
  reduceDraft,
  simulateAuctionMockDraft,
  simulateSnakeMockDraft,
  type AuctionDraftConfig,
  type DraftConfig,
  type DraftEvent,
  type DraftState,
  type MockDraftStopReason,
  type MockPlayerMarket,
  type SnakeDraftConfig,
} from "@laces-out/engine-draft";

import type { DraftSessionSnapshot } from "./api-client";
import type { DraftBoardValue } from "./draft-board";

export interface DraftMockAvailability {
  readonly available: boolean;
  readonly coveredPlayers: number;
  readonly requiredPlayers: number;
  readonly message: string;
}

export interface LocalDraftMock {
  readonly sourceSessionId: string;
  readonly seed: string;
  readonly controlledTeamId: TeamId;
  readonly baseEventCount: number;
  readonly baseSequence: number;
  readonly config: DraftConfig;
  readonly market: readonly MockPlayerMarket[];
  readonly events: readonly DraftEvent[];
  readonly state: DraftState;
  readonly stopReason: MockDraftStopReason;
}

export type DraftMockAdvanceTarget = "event" | "controlled-turn";

function toPlayer(source: DraftSessionSnapshot["config"]["players"][number]): Player {
  return {
    id: playerId(source.id),
    name: source.name,
    positions: source.positions,
    ...(source.nflTeam === undefined ? {} : { nflTeam: source.nflTeam }),
    ...(source.status === undefined ? {} : { status: source.status }),
  };
}

function toTeam(source: DraftSessionSnapshot["config"]["teams"][number]) {
  return {
    id: teamId(source.id),
    name: source.name,
    rosterSlots: source.rosterSlots.map((slot) => ({
      id: rosterSlotId(slot.id),
      type: slot.type,
      label: slot.label,
      kind: slot.kind,
      eligiblePositions: slot.eligiblePositions,
    })),
    ...(source.budget === undefined ? {} : { budget: source.budget }),
  };
}

function toConfig(source: DraftSessionSnapshot["config"]): DraftConfig {
  const teams = source.teams.map(toTeam);
  const players = source.players.map(toPlayer);
  if (source.mode === "SNAKE") {
    return {
      mode: "SNAKE",
      teams,
      players,
      pickOrder: source.pickOrder.map(teamId),
    } satisfies SnakeDraftConfig;
  }
  return {
    mode: "AUCTION",
    teams,
    players,
    minimumBid: source.minimumBid,
  } satisfies AuctionDraftConfig;
}

function toDraftEvent(source: DraftSessionSnapshot["events"][number]["event"]): DraftEvent {
  const base = {
    id: draftEventId(source.id),
    ...(source.occurredAt === undefined ? {} : { occurredAt: source.occurredAt }),
  };
  switch (source.type) {
    case "SNAKE_PLAYER_SELECTED":
    case "SNAKE_KEEPER_ASSIGNED":
      return {
        ...base,
        type: source.type,
        teamId: teamId(source.teamId),
        playerId: playerId(source.playerId),
        overallPick: source.overallPick,
      };
    case "AUCTION_KEEPER_ASSIGNED":
      return {
        ...base,
        type: source.type,
        teamId: teamId(source.teamId),
        playerId: playerId(source.playerId),
        price: source.price,
      };
    case "AUCTION_NOMINATION_STARTED":
      return {
        ...base,
        type: source.type,
        teamId: teamId(source.teamId),
        playerId: playerId(source.playerId),
        nominationNumber: source.nominationNumber,
      };
    case "AUCTION_BID_PLACED":
      return {
        ...base,
        type: source.type,
        teamId: teamId(source.teamId),
        playerId: playerId(source.playerId),
        amount: source.amount,
      };
    case "AUCTION_PLAYER_SOLD":
      return {
        ...base,
        type: source.type,
        teamId: teamId(source.teamId),
        playerId: playerId(source.playerId),
        price: source.price,
      };
    case "DRAFT_EVENT_REVERTED":
      return {
        ...base,
        type: source.type,
        targetEventId: draftEventId(source.targetEventId),
      };
  }
}

function marketRows(
  session: DraftSessionSnapshot,
  values: readonly DraftBoardValue[],
): readonly MockPlayerMarket[] {
  const drafted = new Set(session.state.draftedPlayerIds);
  const playerPool = new Set(session.config.players.map((player) => player.id));
  return values.flatMap((value) => {
    if (!playerPool.has(value.playerId) || drafted.has(value.playerId) || value.adp === null) {
      return [];
    }
    const row: MockPlayerMarket = {
      playerId: playerId(value.playerId),
      adp: value.adp,
      ...(session.config.mode === "AUCTION" && value.aav !== null
        ? { auctionValue: value.aav }
        : {}),
    };
    return [row];
  });
}

export function draftMockAvailability(
  session: DraftSessionSnapshot,
  values: readonly DraftBoardValue[],
): DraftMockAvailability {
  const requiredPlayers = session.state.teams.reduce((sum, team) => sum + team.openSlots, 0);
  const rows = marketRows(session, values);
  const coveredPlayers =
    session.config.mode === "AUCTION"
      ? rows.filter((row) => row.auctionValue !== undefined).length
      : rows.length;
  if (session.state.complete) {
    return {
      available: false,
      coveredPlayers,
      requiredPlayers,
      message: "This room is already complete. Start from an open draft room to practice.",
    };
  }
  if (
    session.config.mode === "AUCTION" &&
    session.config.teams.some((team) => team.budget === undefined)
  ) {
    return {
      available: false,
      coveredPlayers,
      requiredPlayers,
      message: "Auction budgets are missing from this room, so legal mock bidding is unavailable.",
    };
  }
  if (coveredPlayers < requiredPlayers) {
    return {
      available: false,
      coveredPlayers,
      requiredPlayers,
      message:
        session.config.mode === "AUCTION"
          ? `Add AAV and ADP to at least ${requiredPlayers} available players; ${coveredPlayers} are ready.`
          : `ADP is needed for at least ${requiredPlayers} available players; ${coveredPlayers} are ready.`,
    };
  }
  return {
    available: true,
    coveredPlayers,
    requiredPlayers,
    message:
      session.config.mode === "AUCTION"
        ? `${coveredPlayers} available players have both ADP and AAV.`
        : `${coveredPlayers} available players have ADP.`,
  };
}

export function createLocalDraftMock(
  session: DraftSessionSnapshot,
  values: readonly DraftBoardValue[],
  seed: string,
  controlledTeamId: string,
): LocalDraftMock {
  const normalizedSeed = seed.trim();
  if (!normalizedSeed) throw new Error("Enter a seed before starting the mock.");
  if (!session.config.teams.some((team) => team.id === controlledTeamId)) {
    throw new Error("Choose a team from this draft room.");
  }
  const availability = draftMockAvailability(session, values);
  if (!availability.available) throw new Error(availability.message);
  const config = toConfig(session.config);
  const events = session.events.map((record) => toDraftEvent(record.event));
  return {
    sourceSessionId: session.id,
    seed: normalizedSeed,
    controlledTeamId: teamId(controlledTeamId),
    baseEventCount: events.length,
    baseSequence: session.sequence,
    config,
    market: marketRows(session, values),
    events,
    state: reduceDraft(config, events),
    stopReason: "EVENT_LIMIT",
  };
}

function fromSimulation(mock: LocalDraftMock, result: ReturnType<typeof simulateSnakeMockDraft>) {
  return {
    ...mock,
    events: result.events,
    state: result.state,
    stopReason: result.stopReason,
  } satisfies LocalDraftMock;
}

export function advanceLocalDraftMock(
  mock: LocalDraftMock,
  target: DraftMockAdvanceTarget,
): LocalDraftMock {
  const eventLimit = target === "event" ? 1 : 10_000;
  if (mock.config.mode === "SNAKE") {
    return fromSimulation(
      mock,
      simulateSnakeMockDraft({
        config: mock.config,
        seed: mock.seed,
        market: mock.market,
        events: mock.events,
        controlledTeamIds: [mock.controlledTeamId],
        eventLimit,
      }),
    );
  }
  return fromSimulation(
    mock,
    simulateAuctionMockDraft({
      config: mock.config,
      seed: mock.seed,
      market: mock.market,
      events: mock.events,
      controlledTeamIds: [mock.controlledTeamId],
      automateControlledTeamBids: true,
      eventLimit,
    }),
  );
}

export function recordLocalControlledSelection(
  mock: LocalDraftMock,
  selectedPlayerId: string,
  localEventId: string,
): LocalDraftMock {
  const selected = playerId(selectedPlayerId);
  if (mock.state.draftedPlayerIds.includes(selected)) {
    throw new Error("That player is no longer available in this mock.");
  }
  let event: DraftEvent;
  if (mock.config.mode === "SNAKE") {
    const nextPick = mock.state.nextPick;
    if (!nextPick || nextPick.teamId !== mock.controlledTeamId) {
      throw new Error("Run the mock to your next pick before making a selection.");
    }
    event = {
      id: draftEventId(localEventId),
      type: "SNAKE_PLAYER_SELECTED",
      teamId: mock.controlledTeamId,
      playerId: selected,
      overallPick: nextPick.overallPick,
    };
  } else {
    if (mock.stopReason !== "CONTROLLED_NOMINATION" || mock.state.activeNomination !== null) {
      throw new Error("Run the mock to your next nomination before choosing a player.");
    }
    const nominationNumber =
      mock.events.reduce(
        (maximum, item) =>
          item.type === "AUCTION_NOMINATION_STARTED"
            ? Math.max(maximum, item.nominationNumber)
            : maximum,
        0,
      ) + 1;
    event = {
      id: draftEventId(localEventId),
      type: "AUCTION_NOMINATION_STARTED",
      teamId: mock.controlledTeamId,
      playerId: selected,
      nominationNumber,
    };
  }
  const events = [...mock.events, event];
  return {
    ...mock,
    events,
    state: reduceDraft(mock.config, events),
    stopReason: "EVENT_LIMIT",
  };
}

export function undoLatestLocalDraftEvent(
  mock: LocalDraftMock,
  localEventId: string,
): LocalDraftMock {
  const activeIds = new Set(mock.state.activeEventIds);
  const target = mock.events
    .slice(mock.baseEventCount)
    .findLast((event) => event.type !== "DRAFT_EVENT_REVERTED" && activeIds.has(event.id));
  if (target === undefined) return mock;
  const events: readonly DraftEvent[] = [
    ...mock.events,
    {
      id: draftEventId(localEventId),
      type: "DRAFT_EVENT_REVERTED",
      targetEventId: target.id,
    },
  ];
  return {
    ...mock,
    events,
    state: reduceDraft(mock.config, events),
    stopReason: "EVENT_LIMIT",
  };
}

export function replayLocalDraftFromEvent(mock: LocalDraftMock, eventId: string): LocalDraftMock {
  const targetIndex = mock.events.findIndex((event) => event.id === eventId);
  if (targetIndex < mock.baseEventCount) {
    throw new Error("Choose a local mock event as the replay point.");
  }
  const events = mock.events.slice(0, targetIndex + 1);
  const rewound = {
    ...mock,
    events,
    state: reduceDraft(mock.config, events),
    stopReason: "EVENT_LIMIT" as const,
  };
  return advanceLocalDraftMock(rewound, "controlled-turn");
}

export function localMockEvents(mock: LocalDraftMock): readonly DraftEvent[] {
  return mock.events.slice(mock.baseEventCount);
}
