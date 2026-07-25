/**
 * Drizzle persistence for the ESPN live draft feed.
 *
 * This module is the only place provider observations touch the database. Two invariants shape
 * everything below:
 *
 *   1. No column written here may hold an ESPN credential, cookie, SWID, `espn_s2` value, draft
 *      token, WebSocket URL, chat message, or raw page markup. The observation contract is already
 *      strict and bounded; `normalizedPayload` stores that sanitized object and nothing else.
 *   2. One observation is one transaction. The audit row, the appended provider events, the draft
 *      state, and the feed row either all land or none do, so a half-applied board can never be
 *      read back as truth.
 *
 * A note on duplication: `draft-session.ts` owns the canonical stored-settings schema and the
 * league-season to `DraftConfig` builders, but they are module-private there. The minimum needed to
 * create and rehydrate an ESPN-live session is mirrored below and marked as such. The stored
 * settings this module writes must satisfy `storedSettingsSchema` in that file exactly, because it
 * is `.strict()`-parsed on every hydrate.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  ESPN_LIVE_DRAFT_LIMITS,
  espnLiveDraftIssueCodeSchema,
  espnLiveDraftTransientAuctionSchema,
  type EspnLiveDraftFeedStatus,
  type EspnLiveDraftObservation,
  type EspnLiveDraftPickOwnership,
} from "@fantasy/contracts";
import {
  bridgeDeviceLeagues,
  bridgeDevices,
  draftEvents,
  draftProviderFeeds,
  draftProviderObservations,
  drafts,
  fantasyTeams,
  leagueMemberships,
  leagueSeasons,
  leagues,
  playerExternalIds,
  players,
  type Database,
  type DraftProviderFeedState,
  type DraftProviderFeedVerification,
} from "@fantasy/db";
import {
  NFL_POSITIONS,
  NFL_TEAMS,
  PLAYER_STATUSES,
  ROSTER_SLOT_TYPES,
  draftEventId,
  playerId,
  rosterSlotId,
  teamId,
  type NflTeam,
  type Player,
  type PlayerStatus,
  type Position,
  type RosterSlot,
  type RosterSlotKind,
  type RosterSlotType,
} from "@fantasy/domain";
import {
  DraftInvariantError,
  reduceDraft,
  type DraftConfig,
  type DraftEvent,
} from "@fantasy/engine-draft";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  max,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import {
  DrizzleDraftSessionRepository,
  effectiveRole,
  type DraftSessionEventRecord,
  type LeagueDraftSourcePlayer,
  type LeagueDraftSourceRosterRule,
} from "./draft-session.js";
import {
  ProviderTeamResolver,
  type ProviderPlayerCandidate,
  type ProviderTeamCandidate,
} from "./espn-live-draft-identity.js";
import type {
  CommitProviderEventsInput,
  EspnLiveDraftRepository,
  LiveDraftDeviceScope,
  LiveDraftFeedRow,
  LiveDraftSessionContext,
  ManualBackupContext,
  SetManualBackupInput,
  SetManualBackupResult,
} from "./espn-live-draft-service.js";
import {
  ESPN_SELF_ASSERTED_PLAYER_SOURCE,
  espnSelfAssertedPlayerKey,
} from "./espn-sync-persistence.js";

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const uuidSchema = z.string().uuid();
const positiveIntegerSchema = z.number().int().positive().max(1_000_000);
const nonNegativeIntegerSchema = z.number().int().min(0).max(1_000_000);

/** Mirrors `tokenHash` in espn-bridge.ts. Bridge bearer material is only ever compared as a hash. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
  return JSON.parse(serialized) as Record<string, unknown>;
}

/** Local reimplementation of the same guard in draft-session.ts; that one is module-private. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Duplicated from draft-session.ts: stored draft settings and event payloads.
//
// These must stay byte-compatible with the originals. Anything this module writes is re-parsed by
// the manual draft service on every hydrate, and any extra or missing key there surfaces as
// DRAFT_STREAM_CORRUPT for a live room.
// ---------------------------------------------------------------------------------------------

const storedRosterSlotSchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.enum(ROSTER_SLOT_TYPES),
    label: z.string().trim().min(1),
    kind: z.enum(["STARTER", "BENCH", "INJURED_RESERVE", "TAXI"]),
    eligiblePositions: z.array(z.enum(NFL_POSITIONS)).min(1),
  })
  .strict();

const storedPlayerSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(1),
    positions: z.array(z.enum(NFL_POSITIONS)).min(1),
    nflTeam: z.enum(NFL_TEAMS).optional(),
    status: z.enum(PLAYER_STATUSES).optional(),
  })
  .strict();

const storedTeamSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(1),
    rosterSlots: z.array(storedRosterSlotSchema).min(1),
    budget: nonNegativeIntegerSchema.optional(),
  })
  .strict();

const storedConfigSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("SNAKE"),
      teams: z.array(storedTeamSchema).min(2),
      players: z.array(storedPlayerSchema).min(1),
      pickOrder: z.array(uuidSchema).min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("AUCTION"),
      teams: z.array(storedTeamSchema).min(2),
      players: z.array(storedPlayerSchema).min(1),
      minimumBid: nonNegativeIntegerSchema,
    })
    .strict(),
]);

const storedSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    transport: z.enum(["manual", "espn-live"]),
    providerPolling: z.boolean(),
    source: z
      .object({
        leagueSeasonId: uuidSchema,
        provider: z.enum(["yahoo", "espn", "manual"]),
        sourceDraftType: z.string(),
        excludedRosterSlotCodes: z.array(z.string()),
      })
      .strict(),
    config: storedConfigSchema,
  })
  .strict();

const storedEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.string().min(1),
      type: z.enum(["SNAKE_PLAYER_SELECTED", "SNAKE_KEEPER_ASSIGNED"]),
      teamId: uuidSchema,
      playerId: uuidSchema,
      overallPick: positiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.enum(["AUCTION_KEEPER_ASSIGNED", "AUCTION_PLAYER_SOLD"]),
      teamId: uuidSchema,
      playerId: uuidSchema,
      price: nonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("AUCTION_NOMINATION_STARTED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      nominationNumber: positiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("AUCTION_BID_PLACED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      amount: nonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("DRAFT_EVENT_REVERTED"),
      targetEventId: z.string().min(1),
    })
    .strict(),
]);

/** Duplicated from draft-session.ts: `occurred_at` is its own column, never part of the payload. */
function eventPayload(event: DraftEvent): Record<string, unknown> {
  const payload = jsonRecord(event);
  delete payload.occurredAt;
  return payload;
}

/** Duplicated from draft-session.ts (`storedConfigToDomain`). */
function storedConfigToDomain(input: z.infer<typeof storedConfigSchema>): DraftConfig {
  const slot = (stored: z.infer<typeof storedRosterSlotSchema>): RosterSlot => ({
    id: rosterSlotId(stored.id),
    type: stored.type,
    label: stored.label,
    kind: stored.kind,
    eligiblePositions: stored.eligiblePositions,
  });
  const player = (stored: z.infer<typeof storedPlayerSchema>): Player => ({
    id: playerId(stored.id),
    name: stored.name,
    positions: stored.positions,
    ...(stored.nflTeam === undefined ? {} : { nflTeam: stored.nflTeam }),
    ...(stored.status === undefined ? {} : { status: stored.status }),
  });
  const teams = input.teams.map((team) => ({
    id: teamId(team.id),
    name: team.name,
    rosterSlots: team.rosterSlots.map(slot),
    ...(team.budget === undefined ? {} : { budget: team.budget }),
  }));
  const pool = input.players.map(player);
  return input.mode === "SNAKE"
    ? { mode: "SNAKE", teams, players: pool, pickOrder: input.pickOrder.map(teamId) }
    : { mode: "AUCTION", teams, players: pool, minimumBid: input.minimumBid };
}

/** Duplicated from draft-session.ts (`parsedStoredEvent`), minus its manual-only cross-checks. */
function storedEventToDomain(payload: unknown, occurredAt: Date): DraftEvent | undefined {
  const parsed = storedEventSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const stored = parsed.data;
  const id = draftEventId(stored.id);
  const timestamp = occurredAt.toISOString();
  switch (stored.type) {
    case "SNAKE_PLAYER_SELECTED":
    case "SNAKE_KEEPER_ASSIGNED":
      return {
        id,
        type: stored.type,
        teamId: teamId(stored.teamId),
        playerId: playerId(stored.playerId),
        overallPick: stored.overallPick,
        occurredAt: timestamp,
      };
    case "AUCTION_KEEPER_ASSIGNED":
    case "AUCTION_PLAYER_SOLD":
      return {
        id,
        type: stored.type,
        teamId: teamId(stored.teamId),
        playerId: playerId(stored.playerId),
        price: stored.price,
        occurredAt: timestamp,
      };
    case "AUCTION_NOMINATION_STARTED":
      return {
        id,
        type: stored.type,
        teamId: teamId(stored.teamId),
        playerId: playerId(stored.playerId),
        nominationNumber: stored.nominationNumber,
        occurredAt: timestamp,
      };
    case "AUCTION_BID_PLACED":
      return {
        id,
        type: stored.type,
        teamId: teamId(stored.teamId),
        playerId: playerId(stored.playerId),
        amount: stored.amount,
        occurredAt: timestamp,
      };
    case "DRAFT_EVENT_REVERTED":
      return {
        id,
        type: stored.type,
        targetEventId: draftEventId(stored.targetEventId),
        occurredAt: timestamp,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Duplicated from draft-session.ts: league season to DraftConfig builders.
//
// These return `undefined` instead of throwing, because an incomplete league configuration is not
// an error for the live feed — it simply means the room is not ready and the service should answer
// SESSION_NOT_READY.
// ---------------------------------------------------------------------------------------------

const positionValues = new Set<string>(NFL_POSITIONS);
const nflTeamValues = new Set<string>(NFL_TEAMS);
const playerStatusValues = new Set<string>(PLAYER_STATUSES);

function isPosition(value: string): value is Position {
  return positionValues.has(value);
}

function isNflTeam(value: string | null): value is NflTeam {
  return value !== null && nflTeamValues.has(value);
}

function isPlayerStatus(value: string | null): value is PlayerStatus {
  return value !== null && playerStatusValues.has(value);
}

function uniquePositions(values: readonly string[]): readonly Position[] {
  const aliases: Readonly<Record<string, Position>> = {
    "D/ST": "DST",
    DEF: "DST",
    DT: "DL",
    DE: "DL",
    CB: "DB",
    S: "DB",
    DP: "IDP",
    TQB: "QB",
  };
  const normalized = values.map((value) => {
    const position = value.trim().toUpperCase();
    return aliases[position] ?? position;
  });
  return [...new Set(normalized.filter(isPosition))];
}

function normalizedSlotCode(value: string): string {
  return value.trim().toUpperCase().replaceAll(" ", "_");
}

const directSlotTypes: Readonly<Record<string, RosterSlotType>> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  FLEX: "FLEX",
  "RB/WR/TE": "FLEX",
  REC_FLEX: "REC_FLEX",
  "WR/TE": "REC_FLEX",
  SUPER_FLEX: "SUPER_FLEX",
  SUPERFLEX: "SUPER_FLEX",
  OP: "OP",
  TQB: "OP",
  K: "K",
  DST: "DST",
  "D/ST": "DST",
  DL: "DL",
  DT: "DL",
  DE: "DL",
  LB: "LB",
  DB: "DB",
  CB: "DB",
  S: "DB",
  IDP: "IDP_FLEX",
  DP: "IDP_FLEX",
  IDP_FLEX: "IDP_FLEX",
};

function rosterSlotTypeForRule(rule: LeagueDraftSourceRosterRule): RosterSlotType | undefined {
  const slotCode = normalizedSlotCode(rule.slotCode);
  if (!rule.isStarter) {
    if (slotCode === "IR") return "IR";
    if (["TAXI", "TAXI_SQUAD"].includes(slotCode)) return "TAXI";
    return "BENCH";
  }
  const known = directSlotTypes[slotCode];
  if (known !== undefined) return known;

  const eligibility = uniquePositions(rule.eligiblePositions);
  if (eligibility.length === 1) {
    const [only] = eligibility;
    if (only !== undefined && ROSTER_SLOT_TYPES.includes(only as RosterSlotType)) {
      return only as RosterSlotType;
    }
  }
  const keys = new Set(eligibility);
  if (keys.has("QB") && ["RB", "WR", "TE"].some((position) => keys.has(position as Position))) {
    return "SUPER_FLEX";
  }
  if (eligibility.length > 0 && eligibility.every((position) => ["WR", "TE"].includes(position))) {
    return "REC_FLEX";
  }
  if (
    eligibility.length > 0 &&
    eligibility.every((position) => ["RB", "WR", "TE"].includes(position))
  ) {
    return "FLEX";
  }
  if (
    eligibility.length > 0 &&
    eligibility.every((position) => ["DL", "LB", "DB", "IDP"].includes(position))
  ) {
    return "IDP_FLEX";
  }
  return undefined;
}

function rosterSlotKind(type: RosterSlotType): RosterSlotKind {
  if (type === "BENCH") return "BENCH";
  if (type === "IR") return "INJURED_RESERVE";
  if (type === "TAXI") return "TAXI";
  return "STARTER";
}

function defaultSlotEligibility(type: RosterSlotType): readonly Position[] {
  switch (type) {
    case "QB":
      return ["QB"];
    case "RB":
      return ["RB"];
    case "WR":
      return ["WR"];
    case "TE":
      return ["TE"];
    case "FLEX":
      return ["RB", "WR", "TE"];
    case "REC_FLEX":
      return ["WR", "TE"];
    case "SUPER_FLEX":
    case "OP":
      return ["QB", "RB", "WR", "TE"];
    case "K":
      return ["K"];
    case "DST":
      return ["DST"];
    case "DL":
      return ["DL"];
    case "LB":
      return ["LB"];
    case "DB":
      return ["DB"];
    case "IDP_FLEX":
      return ["DL", "LB", "DB", "IDP"];
    case "BENCH":
    case "IR":
    case "TAXI":
      return NFL_POSITIONS;
  }
}

function buildRosterSlots(rules: readonly LeagueDraftSourceRosterRule[]):
  | {
      readonly slots: readonly RosterSlot[];
      readonly excludedCodes: readonly string[];
    }
  | undefined {
  const slots: RosterSlot[] = [];
  const excludedCodes: string[] = [];
  for (const rule of rules) {
    if (!Number.isSafeInteger(rule.count) || rule.count < 0) return undefined;
    const code = normalizedSlotCode(rule.slotCode);
    if (["IR", "TAXI", "TAXI_SQUAD"].includes(code)) {
      if (rule.count > 0) excludedCodes.push(rule.slotCode);
      continue;
    }
    if (rule.count === 0) continue;
    const type = rosterSlotTypeForRule(rule);
    if (type === undefined) return undefined;
    const configured = uniquePositions(rule.eligiblePositions);
    const eligiblePositions = configured.length > 0 ? configured : defaultSlotEligibility(type);
    for (let index = 1; index <= rule.count; index += 1) {
      slots.push({
        id: rosterSlotId(`${rule.id}:${index}`),
        type,
        label: `${rule.slotCode} ${index}`,
        kind: rosterSlotKind(type),
        eligiblePositions,
      });
    }
  }
  return slots.length === 0 ? undefined : { slots, excludedCodes };
}

function buildPlayers(
  rows: readonly LeagueDraftSourcePlayer[],
  slots: readonly RosterSlot[],
): readonly Player[] | undefined {
  const starters = slots.filter((slot) => slot.kind === "STARTER");
  const pool = new Set(
    (starters.length > 0 ? starters : slots).flatMap((slot) => slot.eligiblePositions),
  );
  const result: Player[] = [];
  for (const row of rows) {
    const positions = uniquePositions([row.primaryPosition, ...row.eligiblePositions]);
    if (
      positions.length === 0 ||
      !positions.some((position) => pool.has(position)) ||
      row.fullName.trim().length === 0
    ) {
      continue;
    }
    result.push({
      id: playerId(row.id),
      name: row.fullName,
      positions,
      ...(isNflTeam(row.nflTeam) ? { nflTeam: row.nflTeam } : {}),
      ...(isPlayerStatus(row.status) ? { status: row.status } : {}),
    });
  }
  return result.length === 0 ? undefined : result;
}

/** Duplicated from draft-session.ts (`nestedSetting`/`firstSetting`/`configuredPositiveInteger`). */
function nestedSetting(
  settings: Readonly<Record<string, unknown>>,
  path: readonly string[],
): unknown {
  let value: unknown = settings;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !(key in value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function configuredPositiveInteger(
  settings: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
  fallback?: number,
): number | undefined {
  for (const path of paths) {
    const value = nestedSetting(settings, path);
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers. Everything below this line is database-free and unit tested.
// ---------------------------------------------------------------------------------------------

/**
 * Feed row fields the viewer-facing status is derived from.
 *
 * Deliberately narrow: the active device ID, its lease, and its page session are absent so a
 * projection cannot leak the identity of whoever happens to be supplying the board.
 */
export interface EspnLiveDraftFeedProjection {
  readonly providerLeagueId: string;
  readonly season: number;
  readonly state: DraftProviderFeedState;
  /** Capture time of the last board accepted as truth. */
  readonly lastObservedAt: Date | null;
  /** Server receipt time of the most recent upload or lease heartbeat. Drives freshness. */
  readonly lastReceivedAt: Date | null;
  readonly lastMaterialEventAt: Date | null;
  readonly lastPickCount: number;
  readonly manualBackupActive: boolean;
  readonly verification: DraftProviderFeedVerification;
  readonly lastErrorCode: string | null;
  readonly currentAuctionState: Record<string, unknown> | null;
  readonly unresolvedTeams: number;
  readonly unresolvedPlayers: number;
  readonly pendingReconciliation: number;
  readonly standbySources: number;
}

/**
 * Projects a feed row onto the shared status contract.
 *
 * Freshness uses server receipt time only — a browser clock is never trusted for ordering. A feed
 * that has gone quiet past the disconnect window reports `stale` regardless of the last state it
 * claimed, because "live" for a feed nobody is feeding is a lie. `complete` is terminal: a finished
 * draft does not decay into staleness.
 */
export function projectEspnLiveDraftFeedStatus(
  feed: EspnLiveDraftFeedProjection,
  now: Date,
): EspnLiveDraftFeedStatus {
  const ageMs =
    feed.lastReceivedAt === null
      ? null
      : Math.max(0, now.getTime() - feed.lastReceivedAt.getTime());
  const disconnected = ageMs !== null && ageMs > ESPN_LIVE_DRAFT_LIMITS.disconnectedMs;
  const state: EspnLiveDraftFeedStatus["state"] =
    feed.state === "complete" ? "complete" : disconnected ? "stale" : feed.state;
  const auction = espnLiveDraftTransientAuctionSchema.safeParse(feed.currentAuctionState);
  const issue = espnLiveDraftIssueCodeSchema.safeParse(feed.lastErrorCode);
  return {
    provider: "espn",
    state,
    providerLeagueId: feed.providerLeagueId,
    season: feed.season,
    fresh: ageMs !== null && ageMs <= ESPN_LIVE_DRAFT_LIMITS.freshWindowMs,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 100) / 10,
    lastAcceptedAt: feed.lastObservedAt?.toISOString() ?? null,
    lastMaterialEventAt: feed.lastMaterialEventAt?.toISOString() ?? null,
    pickCount: feed.lastPickCount,
    unresolvedTeams: feed.unresolvedTeams,
    unresolvedPlayers: feed.unresolvedPlayers,
    manualBackupActive: feed.manualBackupActive,
    pendingReconciliation: feed.pendingReconciliation,
    standbySources: feed.standbySources,
    verification: feed.verification,
    lastIssueCode: issue.success ? issue.data : null,
    currentAuction: auction.success ? auction.data : null,
  };
}

/**
 * Builds the `drafts.settings` document for an ESPN-live session.
 *
 * The shape is fixed by `storedSettingsSchema` in draft-session.ts, which strict-parses it on every
 * hydrate. `transport` and `providerPolling` are the only fields that differ from a manual session.
 */
export function espnLiveDraftSessionSettings(input: {
  readonly leagueSeasonId: string;
  readonly sourceDraftType: string;
  readonly excludedRosterSlotCodes: readonly string[];
  readonly config: DraftConfig;
}): Record<string, unknown> {
  return jsonRecord({
    schemaVersion: 1,
    transport: "espn-live",
    providerPolling: true,
    source: {
      leagueSeasonId: input.leagueSeasonId,
      provider: "espn",
      sourceDraftType: input.sourceDraftType,
      excludedRosterSlotCodes: input.excludedRosterSlotCodes,
    },
    config: input.config,
  });
}

/**
 * Resolves ESPN's rendered pick ownership into a complete snake pick order.
 *
 * Returns `undefined` unless ownership is known for every slot, contiguously from pick one, and
 * every owner resolves to exactly one league team. Plan §12.4 is explicit that a traded or
 * reordered pick must never be inferred from a standard snake pattern, so a partial board yields no
 * session at all rather than a plausible-looking wrong one.
 */
export function providerSnakePickOrder(
  pickOwnership: readonly EspnLiveDraftPickOwnership[],
  teams: readonly ProviderTeamCandidate[],
  expectedPicks: number,
): readonly string[] | undefined {
  if (expectedPicks <= 0 || pickOwnership.length !== expectedPicks) return undefined;
  const resolver = new ProviderTeamResolver(teams);
  const bySlot = new Map<number, string>();
  for (const entry of pickOwnership) {
    const resolved = resolver.resolve({
      providerTeamId: entry.providerTeamId,
      teamName: entry.teamName,
    });
    if (resolved.status === "unresolved") return undefined;
    bySlot.set(entry.overallPick, resolved.id);
  }
  const order: string[] = [];
  for (let slot = 1; slot <= expectedPicks; slot += 1) {
    const owner = bySlot.get(slot);
    if (owner === undefined) return undefined;
    order.push(owner);
  }
  return order;
}

export interface PlayerCrosswalkRow {
  readonly source: string;
  readonly externalId: string;
  readonly playerId: string;
}

/**
 * Merges the verified global ESPN crosswalk with this league's self-asserted observations.
 *
 * The global mapping wins where both exist, matching how `espn-sync-persistence.ts` resolves roster
 * players. Entries outside the session's immutable player pool are dropped: resolving to a player
 * the draft configuration has never heard of would fail the reducer mid-commit instead of surfacing
 * as an honest mapping gap. ESPN encodes D/ST as negative player IDs, so nothing here assumes the
 * provider ID is unsigned.
 */
export function espnPlayerCrosswalk(input: {
  readonly leagueSeasonId: string;
  readonly rows: readonly PlayerCrosswalkRow[];
  readonly poolPlayerIds: ReadonlySet<string>;
}): ReadonlyMap<string, string> {
  const prefix = espnSelfAssertedPlayerKey(input.leagueSeasonId, "");
  const crosswalk = new Map<string, string>();
  const scoped = new Map<string, string>();
  for (const row of input.rows) {
    if (!input.poolPlayerIds.has(row.playerId)) continue;
    if (row.source === "espn") {
      crosswalk.set(row.externalId, row.playerId);
      continue;
    }
    if (row.source === ESPN_SELF_ASSERTED_PLAYER_SOURCE && row.externalId.startsWith(prefix)) {
      const providerPlayerId = row.externalId.slice(prefix.length);
      if (providerPlayerId.length > 0) scoped.set(providerPlayerId, row.playerId);
    }
  }
  for (const [providerPlayerId, internalId] of scoped) {
    if (!crosswalk.has(providerPlayerId)) crosswalk.set(providerPlayerId, internalId);
  }
  return crosswalk;
}

// ---------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------

const feedRowColumns = {
  id: draftProviderFeeds.id,
  draftId: draftProviderFeeds.draftId,
  leagueSeasonId: draftProviderFeeds.leagueSeasonId,
  state: draftProviderFeeds.state,
  activeDeviceId: draftProviderFeeds.activeDeviceId,
  activePageSessionId: draftProviderFeeds.activePageSessionId,
  lastPageRevision: draftProviderFeeds.lastPageRevision,
  leaseExpiresAt: draftProviderFeeds.leaseExpiresAt,
  leaseGeneration: draftProviderFeeds.leaseGeneration,
  lastChecksum: draftProviderFeeds.lastChecksum,
  pendingDestructiveChecksum: draftProviderFeeds.pendingDestructiveChecksum,
  pendingDestructiveSeenCount: draftProviderFeeds.pendingDestructiveSeenCount,
  manualBackupActive: draftProviderFeeds.manualBackupActive,
} as const;

type SelectedFeedRow = {
  readonly id: string;
  readonly draftId: string;
  readonly leagueSeasonId: string;
  readonly state: DraftProviderFeedState;
  readonly activeDeviceId: string | null;
  readonly activePageSessionId: string | null;
  readonly lastPageRevision: number | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseGeneration: number;
  readonly lastChecksum: string | null;
  readonly pendingDestructiveChecksum: string | null;
  readonly pendingDestructiveSeenCount: number;
  readonly manualBackupActive: boolean;
};

function liveDraftFeedRow(row: SelectedFeedRow): LiveDraftFeedRow {
  return {
    id: row.id,
    draftId: row.draftId,
    state: row.state,
    activeDeviceId: row.activeDeviceId,
    activePageSessionId: row.activePageSessionId,
    lastPageRevision: row.lastPageRevision,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseGeneration: row.leaseGeneration,
    lastChecksum: row.lastChecksum,
    pendingDestructiveChecksum: row.pendingDestructiveChecksum,
    pendingDestructiveSeenCount: row.pendingDestructiveSeenCount,
    manualBackupActive: row.manualBackupActive,
  };
}

const issueSummarySchema = z.object({
  unresolvedTeams: nonNegativeIntegerSchema.optional(),
  unresolvedPlayers: nonNegativeIntegerSchema.optional(),
});

/**
 * Provider snapshots validated but withheld since the ledger last moved.
 *
 * One definition, shared by the viewer-facing feed status and the manual backup decision, so the
 * number of differences an operator is asked to reconcile is the same number the server enforces on.
 */
function pendingReconciliationCount(heldSince: Date): SQL<number> {
  return sql`count(*) filter (
          where ${draftProviderObservations.result} = 'held'
            and ${draftProviderObservations.receivedAt} > ${heldSince}
        )`.mapWith(Number);
}

export class DrizzleEspnLiveDraftRepository implements EspnLiveDraftRepository {
  readonly #database: Database;
  readonly #draftSessions: DrizzleDraftSessionRepository;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#draftSessions = new DrizzleDraftSessionRepository(database);
    this.#now = now;
  }

  /**
   * Bridge device authorization for a live observation.
   *
   * Mirrors `EspnBridgeService.acceptSnapshot` for the token and scope checks, then adds the plan's
   * §10.1 requirements: the league season must already exist from an accepted ESPN core snapshot,
   * the league must not be archived, and the device owner must still be an authorized member of it.
   * Every failure is a silent `undefined`; the service turns that into one 403 so a probe cannot
   * distinguish "wrong token" from "league not synced".
   */
  async authorizeDevice(
    deviceToken: string,
    providerLeagueId: string,
    season: number,
  ): Promise<LiveDraftDeviceScope | undefined> {
    const now = this.#now();
    const [device] = await this.#database
      .select({ id: bridgeDevices.id, userId: bridgeDevices.userId })
      .from(bridgeDevices)
      .where(
        and(
          eq(bridgeDevices.tokenHash, tokenHash(deviceToken)),
          eq(bridgeDevices.provider, "espn"),
          isNull(bridgeDevices.revokedAt),
          or(isNull(bridgeDevices.expiresAt), gt(bridgeDevices.expiresAt, now)),
        ),
      )
      .limit(1);
    if (!device) return undefined;

    const [scope] = await this.#database
      .select({
        leagueSeasonId: leagueSeasons.id,
        ownerUserId: leagues.ownerUserId,
        archived: leagues.archived,
        membershipRole: leagueMemberships.role,
      })
      .from(bridgeDeviceLeagues)
      .innerJoin(
        leagueSeasons,
        and(
          eq(leagueSeasons.provider, "espn"),
          eq(leagueSeasons.externalKey, bridgeDeviceLeagues.externalLeagueId),
          eq(leagueSeasons.season, season),
        ),
      )
      .innerJoin(leagues, eq(leagues.id, leagueSeasons.leagueId))
      .leftJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagues.id),
          eq(leagueMemberships.userId, device.userId),
        ),
      )
      .where(
        and(
          eq(bridgeDeviceLeagues.bridgeDeviceId, device.id),
          eq(bridgeDeviceLeagues.externalLeagueId, providerLeagueId),
          or(isNull(bridgeDeviceLeagues.season), eq(bridgeDeviceLeagues.season, season)),
        ),
      )
      .limit(1);
    if (!scope || scope.archived) return undefined;
    const authorized = scope.ownerUserId === device.userId || scope.membershipRole !== null;
    if (!authorized) return undefined;

    return {
      deviceId: device.id,
      userId: device.userId,
      leagueSeasonId: scope.leagueSeasonId,
      providerLeagueId,
      season,
    };
  }

  /**
   * Finds, or first creates, the shared ESPN-live session for this provider league season.
   *
   * The hot path is the find: an existing feed rehydrates its immutable configuration from stored
   * settings and never re-runs the readiness gate. Creation happens once, under an advisory lock,
   * and only when every §15.3 precondition holds.
   */
  async loadSessionContext(
    scope: LiveDraftDeviceScope,
    observation: EspnLiveDraftObservation,
  ): Promise<LiveDraftSessionContext | undefined> {
    const existing = await this.#feedForLeagueSeason(scope.providerLeagueId, scope.season);
    const feed = existing ?? (await this.#createSession(scope, observation));
    if (!feed) return undefined;
    return this.#contextForFeed(feed);
  }

  /**
   * Acquires or renews the single source lease (plan §13).
   *
   * One conditional `UPDATE` decides the winner: two devices racing on the same expired lease
   * cannot both match the `WHERE`, because the first commit rewrites `active_device_id` and
   * `lease_expires_at` before the second is evaluated. Read-then-write would let both win.
   */
  async claimLease(input: {
    readonly feedId: string;
    readonly deviceId: string;
    readonly pageSessionId: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<{ readonly granted: boolean; readonly expiresAt: Date | null }> {
    const [granted] = await this.#database
      .update(draftProviderFeeds)
      .set({
        activeDeviceId: input.deviceId,
        activePageSessionId: input.pageSessionId,
        leaseExpiresAt: input.expiresAt,
        // A takeover, or the same device reloading its page, is a new generation. A plain renewal
        // is not, so downstream consumers can tell "still the same source" from "source changed".
        leaseGeneration: sql<number>`case
          when ${draftProviderFeeds.activeDeviceId} = ${input.deviceId}
           and ${draftProviderFeeds.activePageSessionId} = ${input.pageSessionId}
          then ${draftProviderFeeds.leaseGeneration}
          else ${draftProviderFeeds.leaseGeneration} + 1
        end`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(draftProviderFeeds.id, input.feedId),
          or(
            isNull(draftProviderFeeds.activeDeviceId),
            eq(draftProviderFeeds.activeDeviceId, input.deviceId),
            isNull(draftProviderFeeds.leaseExpiresAt),
            lte(draftProviderFeeds.leaseExpiresAt, input.now),
          ),
        ),
      )
      .returning({ expiresAt: draftProviderFeeds.leaseExpiresAt });
    if (granted) return { granted: true, expiresAt: granted.expiresAt };

    const [holder] = await this.#database
      .select({ expiresAt: draftProviderFeeds.leaseExpiresAt })
      .from(draftProviderFeeds)
      .where(eq(draftProviderFeeds.id, input.feedId))
      .limit(1);
    return { granted: false, expiresAt: holder?.expiresAt ?? null };
  }

  /**
   * Records one observation. Audit row, provider events, draft state, and feed state are one
   * transaction; there is no interleaving in which the ledger has moved but the feed has not.
   */
  async commitObservation(
    input: CommitProviderEventsInput,
  ): Promise<{ readonly sequence: number }> {
    const { observation, now } = input;
    return this.#database.transaction(async (transaction) => {
      // Same lock the manual append path takes, so provider and human writes to one room serialize.
      await transaction.execute(sql`select id from drafts where id = ${input.draftId} for update`);

      await transaction
        .insert(draftProviderObservations)
        .values({
          feedId: input.feedId,
          deviceId: input.deviceId,
          pageSessionId: observation.pageSessionId,
          pageRevision: observation.revision,
          checksum: observation.checksumSha256,
          providerState: observation.state,
          pickCount: observation.picks.length,
          capturedAt: new Date(observation.capturedAt),
          receivedAt: now,
          // Already sanitized and bounded by the strict observation contract.
          normalizedPayload: jsonRecord(observation),
          result: input.result,
          issueSummary: {
            issue: input.issue,
            unresolvedTeams: input.unresolvedTeams,
            unresolvedPlayers: input.unresolvedPlayers,
            appended: input.append.length,
          },
        })
        // A re-posted page revision is the same immutable observation, not a second one.
        .onConflictDoNothing({
          target: [
            draftProviderObservations.feedId,
            draftProviderObservations.pageSessionId,
            draftProviderObservations.pageRevision,
          ],
        });

      const appendResult = await this.#appendProviderEvents(transaction, input);

      await transaction
        .update(drafts)
        .set({
          state: input.feedState === "complete" ? "complete" : "live",
          updatedAt: now,
        })
        .where(eq(drafts.id, input.draftId));

      const accepted = input.result === "accepted" || input.result === "idempotent";
      await transaction
        .update(draftProviderFeeds)
        .set({
          state: input.feedState,
          activePageSessionId: observation.pageSessionId,
          lastPageRevision: observation.revision,
          lastReceivedAt: now,
          lastPickCount: observation.picks.length,
          currentAuctionState:
            input.transientAuction === null ? null : jsonRecord(input.transientAuction),
          pendingDestructiveChecksum: input.pendingDestructiveChecksum,
          pendingDestructiveSeenCount: input.pendingDestructiveSeenCount,
          lastErrorCode: input.issue,
          updatedAt: now,
          ...(accepted
            ? {
                lastChecksum: observation.checksumSha256,
                lastObservedAt: new Date(observation.capturedAt),
              }
            : {}),
          ...(appendResult.appended ? { lastMaterialEventAt: now } : {}),
        })
        .where(eq(draftProviderFeeds.id, input.feedId));

      return { sequence: appendResult.sequence };
    });
  }

  /**
   * Renews the lease for the device that already holds it.
   *
   * A heartbeat never acquires a lease — plan §13.1 gives that to the first valid *observation* —
   * and never marks the feed fresh on behalf of a standby source. A non-holder gets `undefined`,
   * which the service answers as `standby`.
   */
  async recordHeartbeat(input: {
    readonly scope: LiveDraftDeviceScope;
    readonly pageSessionId: string;
    readonly state: EspnLiveDraftObservation["state"];
    readonly now: Date;
  }): Promise<EspnLiveDraftFeedStatus | undefined> {
    const feed = await this.#feedForLeagueSeason(input.scope.providerLeagueId, input.scope.season);
    if (!feed) return undefined;

    const [renewed] = await this.#database
      .update(draftProviderFeeds)
      .set({
        leaseExpiresAt: new Date(input.now.getTime() + ESPN_LIVE_DRAFT_LIMITS.failoverEligibleMs),
        lastReceivedAt: input.now,
        updatedAt: input.now,
        // A heartbeat may report the room paused or finished, but it must not clear a degraded
        // feed: only a material observation can prove the mapping gap is gone.
        ...(feed.state === "degraded" ? {} : { state: input.state }),
      })
      .where(
        and(
          eq(draftProviderFeeds.id, feed.id),
          eq(draftProviderFeeds.activeDeviceId, input.scope.deviceId),
          eq(draftProviderFeeds.activePageSessionId, input.pageSessionId),
        ),
      )
      .returning({ id: draftProviderFeeds.id });
    if (!renewed) return undefined;

    return this.#feedStatus(feed.id, input.now);
  }

  async loadFeedStatus(draftId: string): Promise<EspnLiveDraftFeedStatus | undefined> {
    const [feed] = await this.#database
      .select({ id: draftProviderFeeds.id })
      .from(draftProviderFeeds)
      .where(eq(draftProviderFeeds.draftId, draftId))
      .limit(1);
    return feed ? this.#feedStatus(feed.id, this.#now()) : undefined;
  }

  /**
   * Everything one manual backup decision needs, resolved for the calling user.
   *
   * Access is resolved exactly like `DrizzleDraftSessionRepository.loadDraft`: league owner, else
   * membership role, else `undefined` so the caller answers 404 rather than confirming the room
   * exists. The feed join is a left join because a manual room legitimately has no feed, and no
   * device, lease, or page-session column is selected, so this projection cannot leak the identity
   * of whoever is supplying the board.
   */
  async loadManualBackupContext(
    actorUserId: string,
    draftId: string,
  ): Promise<ManualBackupContext | undefined> {
    const [row] = await this.#database
      .select({
        ownerUserId: leagues.ownerUserId,
        archived: leagues.archived,
        membershipRole: leagueMemberships.role,
        feedId: draftProviderFeeds.id,
        manualBackupActive: draftProviderFeeds.manualBackupActive,
        lastMaterialEventAt: draftProviderFeeds.lastMaterialEventAt,
        feedCreatedAt: draftProviderFeeds.createdAt,
      })
      .from(drafts)
      .innerJoin(leagueSeasons, eq(drafts.leagueSeasonId, leagueSeasons.id))
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .leftJoin(
        leagueMemberships,
        and(eq(leagueMemberships.leagueId, leagues.id), eq(leagueMemberships.userId, actorUserId)),
      )
      .leftJoin(draftProviderFeeds, eq(draftProviderFeeds.draftId, drafts.id))
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!row) return undefined;
    const accessRole = effectiveRole(row.ownerUserId, actorUserId, row.membershipRole);
    if (accessRole === undefined) return undefined;

    const [latest] = await this.#database
      .select({ sequence: max(draftEvents.sequence) })
      .from(draftEvents)
      .where(eq(draftEvents.draftId, draftId));
    const sequence = latest?.sequence ?? 0;

    if (row.feedId === null || row.feedCreatedAt === null) {
      return {
        feedId: null,
        accessRole,
        archived: row.archived,
        manualBackupActive: false,
        sequence,
        pendingReconciliation: 0,
      };
    }

    const [counts] = await this.#database
      .select({
        pendingReconciliation: pendingReconciliationCount(
          row.lastMaterialEventAt ?? row.feedCreatedAt,
        ),
      })
      .from(draftProviderObservations)
      .where(eq(draftProviderObservations.feedId, row.feedId));

    return {
      feedId: row.feedId,
      accessRole,
      archived: row.archived,
      manualBackupActive: row.manualBackupActive ?? false,
      sequence,
      pendingReconciliation: counts?.pendingReconciliation ?? 0,
    };
  }

  /**
   * Flips the freeze under the same row lock the provider commit path takes, so a toggle and an
   * arriving observation can never interleave.
   *
   * Only the boolean and the destructive-confirmation counters move. No draft event is written,
   * reverted, or deleted here, which is what makes returning to provider control incapable of
   * rewriting a manual entry (plan §14.4); a genuinely divergent provider board is still held by
   * the reconciler on its next observation. Resetting the counters means a destructive rewrite must
   * re-earn its confirmations after the freeze instead of resuming a count taken before a human
   * took over.
   */
  async setManualBackupActive(input: SetManualBackupInput): Promise<SetManualBackupResult> {
    return this.#database.transaction(async (transaction) => {
      await transaction.execute(sql`select id from drafts where id = ${input.draftId} for update`);
      const [latest] = await transaction
        .select({ sequence: max(draftEvents.sequence) })
        .from(draftEvents)
        .where(eq(draftEvents.draftId, input.draftId));
      const sequence = latest?.sequence ?? 0;
      if (sequence !== input.expectedSequence) {
        return { status: "version-conflict", currentSequence: sequence };
      }

      const [updated] = await transaction
        .update(draftProviderFeeds)
        .set({
          manualBackupActive: input.active,
          pendingDestructiveChecksum: null,
          pendingDestructiveSeenCount: 0,
          updatedAt: input.now,
        })
        .where(eq(draftProviderFeeds.id, input.feedId))
        .returning({ id: draftProviderFeeds.id });
      return updated ? { status: "updated" } : { status: "not-found" };
    });
  }

  async #feedForLeagueSeason(
    providerLeagueId: string,
    season: number,
  ): Promise<SelectedFeedRow | undefined> {
    const [feed] = await this.#database
      .select(feedRowColumns)
      .from(draftProviderFeeds)
      .where(
        and(
          eq(draftProviderFeeds.provider, "espn"),
          eq(draftProviderFeeds.providerLeagueId, providerLeagueId),
          eq(draftProviderFeeds.season, season),
        ),
      )
      .limit(1);
    return feed;
  }

  /** Rehydrates a session from its immutable stored configuration and its accepted ledger. */
  async #contextForFeed(feed: SelectedFeedRow): Promise<LiveDraftSessionContext | undefined> {
    const [draft] = await this.#database
      .select({ settings: drafts.settings })
      .from(drafts)
      .where(eq(drafts.id, feed.draftId))
      .limit(1);
    if (!draft) return undefined;
    const settings = storedSettingsSchema.safeParse(draft.settings);
    if (!settings.success || settings.data.transport !== "espn-live") return undefined;
    const config = storedConfigToDomain(settings.data.config);

    const eventRows = await this.#database
      .select({
        sequence: draftEvents.sequence,
        idempotencyKey: draftEvents.idempotencyKey,
        source: draftEvents.source,
        occurredAt: draftEvents.occurredAt,
        revertsSequence: draftEvents.revertsSequence,
        payload: draftEvents.payload,
      })
      .from(draftEvents)
      .where(eq(draftEvents.draftId, feed.draftId))
      .orderBy(asc(draftEvents.sequence));

    const events: DraftSessionEventRecord[] = [];
    for (const [index, row] of eventRows.entries()) {
      // A non-contiguous ledger is corrupt. Refusing the context is safer than appending onto it.
      if (row.sequence !== index + 1) return undefined;
      const event = storedEventToDomain(row.payload, row.occurredAt);
      if (event === undefined) return undefined;
      events.push({
        sequence: row.sequence,
        idempotencyKey: row.idempotencyKey,
        source: row.source,
        occurredAt: row.occurredAt.toISOString(),
        revertsSequence: row.revertsSequence,
        event,
      });
    }

    const teamRows = await this.#database
      .select({ id: fantasyTeams.id, externalKey: fantasyTeams.externalKey })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, feed.leagueSeasonId));
    const externalKeys = new Map(teamRows.map((row) => [row.id, row.externalKey]));

    // Identity resolution runs against the immutable configuration, never a freshly queried
    // catalog: a resolved ID that the stored config does not contain would fail the reducer.
    const teams: readonly ProviderTeamCandidate[] = config.teams.map((team) => ({
      id: team.id,
      name: team.name,
      externalKey: externalKeys.get(team.id) ?? null,
    }));
    const candidates: readonly ProviderPlayerCandidate[] = config.players.map((player) => ({
      id: player.id,
      name: player.name,
      positions: player.positions,
      nflTeam: player.nflTeam ?? null,
    }));

    const playerCrosswalk = await this.#playerCrosswalk(
      feed.leagueSeasonId,
      new Set(config.players.map((player) => String(player.id))),
    );

    return {
      feed: liveDraftFeedRow(feed),
      draftId: feed.draftId,
      config,
      events,
      sequence: events.length,
      teams,
      players: candidates,
      playerCrosswalk,
    };
  }

  async #playerCrosswalk(
    leagueSeasonId: string,
    poolPlayerIds: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, string>> {
    const rows = await this.#database
      .select({
        source: playerExternalIds.source,
        externalId: playerExternalIds.externalId,
        playerId: playerExternalIds.playerId,
      })
      .from(playerExternalIds)
      .innerJoin(players, eq(players.id, playerExternalIds.playerId))
      .where(
        or(
          // The global ESPN crosswalk is canonical only once a trusted catalog source verifies it.
          and(
            eq(playerExternalIds.source, "espn"),
            eq(playerExternalIds.verified, true),
            isNotNull(players.gsisId),
          ),
          and(
            eq(playerExternalIds.source, ESPN_SELF_ASSERTED_PLAYER_SOURCE),
            like(playerExternalIds.externalId, `${espnSelfAssertedPlayerKey(leagueSeasonId, "")}%`),
          ),
        ),
      );
    return espnPlayerCrosswalk({ leagueSeasonId, rows, poolPlayerIds });
  }

  /**
   * Creates the shared ESPN-live session, once, when the room is provably ready (plan §15.3).
   *
   * Any unmet precondition returns `undefined` rather than a partially configured session: the
   * configuration is immutable after creation, so a wrong one would have to be deleted by hand.
   */
  async #createSession(
    scope: LiveDraftDeviceScope,
    observation: EspnLiveDraftObservation,
  ): Promise<SelectedFeedRow | undefined> {
    const source = await this.#draftSessions.loadLeagueDraftSource(
      scope.userId,
      scope.leagueSeasonId,
    );
    if (!source || source.archived) return undefined;
    if (source.teams.length !== source.teamCount || source.teams.length < 2) return undefined;
    if (source.draftType.trim().toLowerCase() !== observation.draftType) return undefined;

    const roster = buildRosterSlots(source.rosterRules);
    if (!roster) return undefined;
    const pool = buildPlayers(source.players, roster.slots);
    if (!pool) return undefined;

    const baseTeams = source.teams.map((team) => ({
      id: teamId(team.id),
      name: team.name.trim(),
      rosterSlots: roster.slots,
    }));
    if (baseTeams.some((team) => team.name.length === 0)) return undefined;

    let config: DraftConfig;
    let budgetPerTeam: number | null = null;
    let minimumBid: number | null = null;
    if (observation.draftType === "snake") {
      const order = providerSnakePickOrder(
        observation.pickOwnership,
        source.teams.map((team) => ({
          id: team.id,
          name: team.name,
          externalKey: team.externalKey,
        })),
        baseTeams.length * roster.slots.length,
      );
      if (!order) return undefined;
      config = {
        mode: "SNAKE",
        teams: baseTeams,
        players: pool,
        pickOrder: order.map(teamId),
      };
    } else {
      budgetPerTeam =
        configuredPositiveInteger(source.settings, [
          ["auctionBudget"],
          ["draftBudget"],
          ["draftSettings", "auctionBudget"],
        ]) ?? null;
      minimumBid =
        configuredPositiveInteger(
          source.settings,
          [["minimumBid"], ["draftSettings", "minimumBid"]],
          1,
        ) ?? null;
      if (budgetPerTeam === null || minimumBid === null) return undefined;
      const budget = budgetPerTeam;
      config = {
        mode: "AUCTION",
        teams: baseTeams.map((team) => ({ ...team, budget })),
        players: pool,
        minimumBid,
      };
    }

    // Prove the configuration is legal before it becomes immutable.
    try {
      reduceDraft(config, []);
    } catch (error) {
      if (error instanceof DraftInvariantError) return undefined;
      throw error;
    }

    const now = this.#now();
    const settings = espnLiveDraftSessionSettings({
      leagueSeasonId: source.leagueSeasonId,
      sourceDraftType: source.draftType,
      excludedRosterSlotCodes: roster.excludedCodes,
      config,
    });

    try {
      return await this.#database.transaction(async (transaction) => {
        const lockKey = `espn-live-draft:${scope.providerLeagueId}:${scope.season}`;
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
        );
        const [raced] = await transaction
          .select(feedRowColumns)
          .from(draftProviderFeeds)
          .where(
            and(
              eq(draftProviderFeeds.provider, "espn"),
              eq(draftProviderFeeds.providerLeagueId, scope.providerLeagueId),
              eq(draftProviderFeeds.season, scope.season),
            ),
          )
          .limit(1);
        if (raced) return raced;

        const draftId = randomUUID();
        await transaction.insert(drafts).values({
          id: draftId,
          leagueSeasonId: source.leagueSeasonId,
          type: observation.draftType,
          state: "created",
          budgetPerTeam,
          minimumBid,
          settings,
          createdAt: now,
          updatedAt: now,
        });
        const [feed] = await transaction
          .insert(draftProviderFeeds)
          .values({
            draftId,
            leagueSeasonId: source.leagueSeasonId,
            provider: "espn",
            providerLeagueId: scope.providerLeagueId,
            season: scope.season,
            state: "waiting",
            verification: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .returning(feedRowColumns);
        return feed;
      });
    } catch (error) {
      // Another writer won the unique provider/league-season index between the lock and the
      // insert. Its session is just as valid as the one this call would have built.
      if (isUniqueViolation(error)) {
        return this.#feedForLeagueSeason(scope.providerLeagueId, scope.season);
      }
      throw error;
    }
  }

  /**
   * Appends the reconciled provider events, or nothing at all.
   *
   * Refusing to write on a sequence or idempotency mismatch is safe by construction: every material
   * upload is a full cumulative snapshot, so the next observation re-reconciles against whatever
   * the ledger actually became.
   */
  async #appendProviderEvents(
    transaction: DatabaseTransaction,
    input: CommitProviderEventsInput,
  ): Promise<{ readonly sequence: number; readonly appended: boolean }> {
    const currentSequence = async (): Promise<number> => {
      const [latest] = await transaction
        .select({ sequence: max(draftEvents.sequence) })
        .from(draftEvents)
        .where(eq(draftEvents.draftId, input.draftId));
      return latest?.sequence ?? 0;
    };
    if (input.append.length === 0) return { sequence: await currentSequence(), appended: false };

    const keys = input.append.map((pending) => pending.idempotencyKey);
    const existing = await transaction
      .select({ sequence: draftEvents.sequence })
      .from(draftEvents)
      .where(
        and(eq(draftEvents.draftId, input.draftId), inArray(draftEvents.idempotencyKey, keys)),
      );
    if (existing.length > 0) return { sequence: await currentSequence(), appended: false };

    const sequence = await currentSequence();
    if (sequence !== input.expectedSequence) return { sequence, appended: false };

    const inserted = await transaction
      .insert(draftEvents)
      .values(
        input.append.map((pending, index) => ({
          draftId: input.draftId,
          sequence: input.expectedSequence + index + 1,
          idempotencyKey: pending.idempotencyKey,
          type: pending.event.type,
          // The reconciler always stamps this from the ingest clock; the domain type leaves it
          // optional, and the server's own `now` is the only defensible substitute.
          occurredAt:
            pending.event.occurredAt === undefined ? input.now : new Date(pending.event.occurredAt),
          source: pending.source,
          payload: eventPayload(pending.event),
          revertsSequence: pending.revertsSequence,
        })),
      )
      // Belt and braces under the row lock: a conflict returns fewer rows instead of poisoning the
      // surrounding transaction the way a raised unique violation would.
      .onConflictDoNothing()
      .returning({ sequence: draftEvents.sequence });
    return {
      sequence: inserted.reduce((highest, row) => Math.max(highest, row.sequence), sequence),
      appended: inserted.length === input.append.length,
    };
  }

  async #feedStatus(feedId: string, now: Date): Promise<EspnLiveDraftFeedStatus | undefined> {
    const [feed] = await this.#database
      .select({
        id: draftProviderFeeds.id,
        providerLeagueId: draftProviderFeeds.providerLeagueId,
        season: draftProviderFeeds.season,
        state: draftProviderFeeds.state,
        activeDeviceId: draftProviderFeeds.activeDeviceId,
        lastObservedAt: draftProviderFeeds.lastObservedAt,
        lastReceivedAt: draftProviderFeeds.lastReceivedAt,
        lastMaterialEventAt: draftProviderFeeds.lastMaterialEventAt,
        lastPickCount: draftProviderFeeds.lastPickCount,
        manualBackupActive: draftProviderFeeds.manualBackupActive,
        verification: draftProviderFeeds.verification,
        lastErrorCode: draftProviderFeeds.lastErrorCode,
        currentAuctionState: draftProviderFeeds.currentAuctionState,
        createdAt: draftProviderFeeds.createdAt,
      })
      .from(draftProviderFeeds)
      .where(eq(draftProviderFeeds.id, feedId))
      .limit(1);
    if (!feed) return undefined;

    const [latest] = await this.#database
      .select({ issueSummary: draftProviderObservations.issueSummary })
      .from(draftProviderObservations)
      .where(eq(draftProviderObservations.feedId, feedId))
      .orderBy(desc(draftProviderObservations.receivedAt))
      .limit(1);
    const summary = issueSummarySchema.safeParse(latest?.issueSummary ?? {});

    const heldSince = feed.lastMaterialEventAt ?? feed.createdAt;
    const standbySince = new Date(now.getTime() - ESPN_LIVE_DRAFT_LIMITS.disconnectedMs);
    const [counts] = await this.#database
      .select({
        pendingReconciliation: pendingReconciliationCount(heldSince),
        standbySources: sql`count(distinct ${draftProviderObservations.deviceId}) filter (
          where ${draftProviderObservations.receivedAt} >= ${standbySince}
            and ${draftProviderObservations.deviceId} is distinct from ${feed.activeDeviceId}::uuid
        )`.mapWith(Number),
      })
      .from(draftProviderObservations)
      .where(eq(draftProviderObservations.feedId, feedId));

    return projectEspnLiveDraftFeedStatus(
      {
        providerLeagueId: feed.providerLeagueId,
        season: feed.season,
        state: feed.state,
        lastObservedAt: feed.lastObservedAt,
        lastReceivedAt: feed.lastReceivedAt,
        lastMaterialEventAt: feed.lastMaterialEventAt,
        lastPickCount: feed.lastPickCount,
        manualBackupActive: feed.manualBackupActive,
        verification: feed.verification,
        lastErrorCode: feed.lastErrorCode,
        currentAuctionState: feed.currentAuctionState,
        unresolvedTeams: summary.success ? (summary.data.unresolvedTeams ?? 0) : 0,
        unresolvedPlayers: summary.success ? (summary.data.unresolvedPlayers ?? 0) : 0,
        pendingReconciliation: counts?.pendingReconciliation ?? 0,
        standbySources: counts?.standbySources ?? 0,
      },
      now,
    );
  }
}
