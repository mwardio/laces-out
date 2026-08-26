import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  draftEvents,
  drafts,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  players,
  rosterSlotRules,
  type Database,
  type DraftEventSource,
  type LeagueMembershipRole,
} from "@laces-out/db";
import type { EspnLiveDraftFeedStatus } from "@laces-out/contracts";
import {
  NFL_POSITIONS,
  NFL_TEAMS,
  PLAYER_STATUSES,
  ROSTER_SLOT_TYPES,
  draftEventId,
  playerId,
  rosterSlotId,
  teamId,
  type DraftEventId,
  type NflTeam,
  type Player,
  type PlayerStatus,
  type Position,
  type RosterSlot,
  type RosterSlotKind,
  type RosterSlotType,
  type TeamId,
} from "@laces-out/domain";
import {
  DraftInvariantError,
  createSnakePickOrder,
  latestUndoableEvent,
  reduceDraft,
  type DraftConfig,
  type DraftEvent,
  type DraftState,
} from "@laces-out/engine-draft";
import { and, asc, eq, gte, inArray, isNull, max, or, sql } from "drizzle-orm";
import { z } from "zod";

import { leagueScopedPlayerCatalogFilter } from "./espn-sync-persistence.js";
import {
  providerCommissionerAuthoritySql,
  publicLeagueAccessRole,
} from "./public-league-access.js";

const uuidSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const correctionIdempotencyKeySchema = z.string().trim().min(8).max(180);
const positiveIntegerSchema = z.number().int().positive().max(1_000_000);
const nonNegativeIntegerSchema = z.number().int().min(0).max(1_000_000);

const appendActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("SNAKE_PLAYER_SELECTED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      overallPick: positiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("SNAKE_KEEPER_ASSIGNED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      overallPick: positiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_KEEPER_ASSIGNED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      price: nonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_NOMINATION_STARTED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      nominationNumber: positiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_BID_PLACED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      amount: nonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("AUCTION_PLAYER_SOLD"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      price: nonNegativeIntegerSchema,
    })
    .strict(),
]);

const createSessionInputSchema = z
  .object({
    leagueSeasonId: uuidSchema,
    mode: z.enum(["snake", "auction"]).optional(),
    teamOrder: z.array(z.string().trim().min(1).max(200)).min(2).optional(),
    thirdRoundReversal: z.boolean().optional(),
    budgetPerTeam: positiveIntegerSchema.optional(),
    minimumBid: positiveIntegerSchema.optional(),
  })
  .strict();

const appendInputSchema = z
  .object({
    expectedSequence: nonNegativeIntegerSchema,
    idempotencyKey: idempotencyKeySchema,
    action: appendActionSchema,
  })
  .strict();

const undoInputSchema = z
  .object({
    expectedSequence: nonNegativeIntegerSchema,
    idempotencyKey: idempotencyKeySchema,
    targetSequence: positiveIntegerSchema.optional(),
  })
  .strict();

const correctionInputSchema = z
  .object({
    expectedSequence: nonNegativeIntegerSchema,
    idempotencyKey: correctionIdempotencyKeySchema,
    targetSequence: positiveIntegerSchema,
    replacement: appendActionSchema,
  })
  .strict();

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
    // Widened in place rather than version-bumped: no field was added or removed, so every
    // already-stored manual session still parses byte for byte.
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
      type: z.literal("SNAKE_PLAYER_SELECTED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      overallPick: positiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("SNAKE_KEEPER_ASSIGNED"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      overallPick: positiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("AUCTION_KEEPER_ASSIGNED"),
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
      type: z.literal("AUCTION_PLAYER_SOLD"),
      teamId: uuidSchema,
      playerId: uuidSchema,
      price: nonNegativeIntegerSchema,
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

const draftEventSources: ReadonlySet<string> = new Set<DraftEventSource>(["manual", "espn"]);

/**
 * Event IDs are derived, not random, so a replayed write reproduces a byte-identical event. The
 * source prefix keeps a provider-observed fact from ever colliding with a manually entered one.
 */
export function draftEventIdFor(
  source: DraftEventSource,
  draftId: string,
  idempotencyKey: string,
): DraftEventId {
  return draftEventId(
    `${source}:${createHash("sha256").update(`${draftId}\0${idempotencyKey}`).digest("hex")}`,
  );
}

export type CreateDraftSessionInput = z.input<typeof createSessionInputSchema>;
export type AppendDraftEventInput = z.input<typeof appendInputSchema>;
export type UndoDraftEventInput = z.input<typeof undoInputSchema>;
export type CorrectDraftEventInput = z.input<typeof correctionInputSchema>;
export type DraftAppendAction = z.input<typeof appendActionSchema>;

export type DraftSessionErrorCode =
  | "DRAFT_NOT_FOUND"
  | "DRAFT_FORBIDDEN"
  | "DRAFT_INVALID_INPUT"
  | "DRAFT_CONFIG_INVALID"
  | "DRAFT_VERSION_CONFLICT"
  | "DRAFT_IDEMPOTENCY_CONFLICT"
  | "DRAFT_INVARIANT"
  | "DRAFT_CORRECTION_TARGET_INVALID"
  | "DRAFT_RECONCILIATION_REQUIRED"
  | "DRAFT_STREAM_CORRUPT";

const errorStatus: Readonly<Record<DraftSessionErrorCode, number>> = {
  DRAFT_NOT_FOUND: 404,
  DRAFT_FORBIDDEN: 403,
  DRAFT_INVALID_INPUT: 400,
  DRAFT_CONFIG_INVALID: 422,
  DRAFT_VERSION_CONFLICT: 409,
  DRAFT_IDEMPOTENCY_CONFLICT: 409,
  DRAFT_INVARIANT: 409,
  DRAFT_CORRECTION_TARGET_INVALID: 422,
  DRAFT_RECONCILIATION_REQUIRED: 409,
  DRAFT_STREAM_CORRUPT: 500,
};

export class DraftSessionError extends Error {
  readonly code: DraftSessionErrorCode;
  readonly statusCode: number;
  readonly currentSequence: number | undefined;
  readonly invariantCode: string | undefined;

  constructor(
    code: DraftSessionErrorCode,
    message: string,
    detail: { readonly currentSequence?: number; readonly invariantCode?: string } = {},
  ) {
    super(message);
    this.name = "DraftSessionError";
    this.code = code;
    this.statusCode = errorStatus[code];
    this.currentSequence = detail.currentSequence;
    this.invariantCode = detail.invariantCode;
  }
}

export interface LeagueDraftSourceTeam {
  readonly id: string;
  readonly externalKey: string;
  readonly name: string;
}

export interface LeagueDraftSourceRosterRule {
  readonly id: string;
  readonly slotCode: string;
  readonly count: number;
  readonly eligiblePositions: readonly string[];
  readonly isStarter: boolean;
}

export interface LeagueDraftSourcePlayer {
  readonly id: string;
  readonly fullName: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: readonly string[];
  readonly nflTeam: string | null;
  readonly status: string | null;
}

export interface LeagueDraftSource {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly provider: "yahoo" | "espn" | "manual";
  readonly draftType: string;
  readonly teamCount: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly archived: boolean;
  readonly accessRole: LeagueMembershipRole;
  readonly teams: readonly LeagueDraftSourceTeam[];
  readonly rosterRules: readonly LeagueDraftSourceRosterRule[];
  readonly players: readonly LeagueDraftSourcePlayer[];
}

export interface StoredDraft {
  readonly id: string;
  readonly leagueSeasonId: string;
  readonly type: string;
  readonly state: string;
  readonly budgetPerTeam: number | null;
  readonly minimumBid: number | null;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly accessRole: LeagueMembershipRole;
  readonly archived: boolean;
}

export interface StoredDraftEvent {
  readonly draftId: string;
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly source: DraftEventSource;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly revertsSequence: number | null;
  readonly createdAt: Date;
}

export interface NewStoredDraft {
  readonly id: string;
  readonly actorUserId: string;
  readonly leagueSeasonId: string;
  readonly type: "snake" | "auction";
  readonly budgetPerTeam: number | null;
  readonly minimumBid: number | null;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly now: Date;
}

export interface PendingDraftEvent {
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly type: DraftEvent["type"];
  readonly occurredAt: Date;
  readonly source: DraftEventSource;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly revertsSequence: number | null;
}

export type CreateStoredDraftResult =
  | { readonly status: "saved"; readonly draft: StoredDraft }
  | { readonly status: "not-found" | "forbidden" | "archived" };

export type AppendStoredEventsResult =
  | { readonly status: "saved" | "idempotent"; readonly events: readonly StoredDraftEvent[] }
  | { readonly status: "not-found" | "forbidden" | "archived" }
  | { readonly status: "version-conflict"; readonly currentSequence: number }
  | { readonly status: "idempotency-conflict" };

export interface DraftSessionRepository {
  loadLeagueDraftSource(
    userId: string,
    leagueSeasonId: string,
  ): Promise<LeagueDraftSource | undefined>;
  createDraft(input: NewStoredDraft): Promise<CreateStoredDraftResult>;
  loadDraft(userId: string, draftId: string): Promise<StoredDraft | undefined>;
  listEvents(draftId: string): Promise<readonly StoredDraftEvent[]>;
  appendEvents(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly expectedSequence: number;
    readonly events: readonly PendingDraftEvent[];
    readonly resultingState: "live" | "complete";
    readonly now: Date;
  }): Promise<AppendStoredEventsResult>;
  /**
   * Optional so manual-only deployments and existing test fakes keep working. A draft with no
   * provider feed simply reports `providerFeed: null`.
   */
  loadProviderFeedStatus?(draftId: string): Promise<EspnLiveDraftFeedStatus | undefined>;
}

export interface DraftSessionEventRecord {
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly source: DraftEventSource;
  readonly occurredAt: string;
  readonly revertsSequence: number | null;
  readonly event: DraftEvent;
}

export interface DraftSessionSnapshot {
  readonly id: string;
  readonly leagueSeasonId: string;
  readonly transport: "manual" | "espn-live";
  /** True only while an accepted provider feed is actually supplying this room. */
  readonly providerPolling: boolean;
  /** Null for a manual room; present whenever an ESPN feed is attached, healthy or not. */
  readonly providerFeed: EspnLiveDraftFeedStatus | null;
  readonly accessRole: LeagueMembershipRole;
  readonly sequence: number;
  readonly persistedState: string;
  /** Immutable creation-time configuration used by clients to rebuild the draft board. */
  readonly config: DraftConfig;
  readonly state: DraftState;
  readonly events: readonly DraftSessionEventRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DraftMutationResult {
  readonly idempotent: boolean;
  readonly appendedSequences: readonly number[];
  readonly session: DraftSessionSnapshot;
}

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The role a user actually has in a league, or `undefined` when they have none.
 *
 * Exported so every draft-scoped reader resolves access the same way; a caller that gets
 * `undefined` must answer 404, never 403, so a stranger cannot learn that a room exists.
 */
export function effectiveRole(
  ownerUserId: string,
  requestedUserId: string,
  membershipRole: LeagueMembershipRole | null,
  explicitCommissioner = false,
  providerCommissioner = false,
): LeagueMembershipRole | undefined {
  const storedRole = membershipRole ?? (ownerUserId === requestedUserId ? "owner" : undefined);
  return storedRole === undefined
    ? undefined
    : publicLeagueAccessRole({
        role: storedRole,
        explicitCommissioner,
        providerCommissioner,
      });
}

/** Shared-state writes require product commissioner authority, not canonical record ownership. */
export function mayMutate(role: LeagueMembershipRole): boolean {
  return role === "commissioner";
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function storedDraftFromRow(
  row: typeof drafts.$inferSelect,
  accessRole: LeagueMembershipRole,
  archived: boolean,
): StoredDraft {
  return { ...row, accessRole, archived };
}

function storedEventFromRow(row: typeof draftEvents.$inferSelect): StoredDraftEvent {
  return row;
}

function eventPayloadMatches(row: StoredDraftEvent, pending: PendingDraftEvent): boolean {
  return (
    row.sequence === pending.sequence &&
    row.type === pending.type &&
    row.source === pending.source &&
    row.revertsSequence === pending.revertsSequence &&
    isDeepStrictEqual(row.payload, pending.payload)
  );
}

function validatePendingBatch(
  expectedSequence: number,
  events: readonly PendingDraftEvent[],
): void {
  if (events.length === 0 || !Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
    throw new TypeError("Draft append requires an expected sequence and at least one event");
  }
  if (new Set(events.map((event) => event.idempotencyKey)).size !== events.length) {
    throw new TypeError("Draft append idempotency keys must be unique within a batch");
  }
  for (const [index, event] of events.entries()) {
    const parsed = storedEventSchema.safeParse(event.payload);
    if (
      event.sequence !== expectedSequence + index + 1 ||
      !draftEventSources.has(event.source) ||
      !idempotencyKeySchema.safeParse(event.idempotencyKey).success ||
      !parsed.success ||
      parsed.data.type !== event.type ||
      (event.type === "DRAFT_EVENT_REVERTED") !== (event.revertsSequence !== null)
    ) {
      throw new TypeError("Draft append batch is not ordered or internally consistent");
    }
  }
}

/** Injected so the draft session layer never has to know how provider feeds are stored. */
export interface ProviderFeedStatusSource {
  loadFeedStatus(draftId: string): Promise<EspnLiveDraftFeedStatus | undefined>;
}

export class DrizzleDraftSessionRepository implements DraftSessionRepository {
  readonly #database: Database;
  readonly #providerFeeds: ProviderFeedStatusSource | undefined;

  constructor(database: Database, providerFeeds?: ProviderFeedStatusSource) {
    this.#database = database;
    this.#providerFeeds = providerFeeds;
  }

  async loadProviderFeedStatus(draftId: string): Promise<EspnLiveDraftFeedStatus | undefined> {
    return this.#providerFeeds?.loadFeedStatus(draftId);
  }

  async loadLeagueDraftSource(
    userId: string,
    leagueSeasonId: string,
  ): Promise<LeagueDraftSource | undefined> {
    const [scope] = await this.#database
      .select({
        leagueId: leagues.id,
        ownerUserId: leagues.ownerUserId,
        archived: leagues.archived,
        leagueSeasonId: leagueSeasons.id,
        season: leagueSeasons.season,
        provider: leagueSeasons.provider,
        draftType: leagueSeasons.draftType,
        teamCount: leagueSeasons.teamCount,
        settings: leagueSeasons.settings,
        membershipRole: leagueMemberships.role,
        explicitCommissioner: leagueMemberships.explicitCommissioner,
        providerCommissioner: providerCommissionerAuthoritySql(userId, leagueSeasons.id),
      })
      .from(leagueSeasons)
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .leftJoin(
        leagueMemberships,
        and(eq(leagueMemberships.leagueId, leagues.id), eq(leagueMemberships.userId, userId)),
      )
      .where(eq(leagueSeasons.id, leagueSeasonId))
      .limit(1);
    if (!scope) return undefined;
    const accessRole = effectiveRole(
      scope.ownerUserId,
      userId,
      scope.membershipRole,
      scope.explicitCommissioner ?? false,
      scope.providerCommissioner,
    );
    if (accessRole === undefined) return undefined;

    const [teamRows, rosterRows, playerRows] = await Promise.all([
      this.#database
        .select({
          id: fantasyTeams.id,
          externalKey: fantasyTeams.externalKey,
          name: fantasyTeams.name,
        })
        .from(fantasyTeams)
        .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
        .orderBy(asc(fantasyTeams.externalKey), asc(fantasyTeams.id)),
      this.#database
        .select({
          id: rosterSlotRules.id,
          slotCode: rosterSlotRules.slotCode,
          count: rosterSlotRules.count,
          eligiblePositions: rosterSlotRules.eligiblePositions,
          isStarter: rosterSlotRules.isStarter,
        })
        .from(rosterSlotRules)
        .where(eq(rosterSlotRules.leagueSeasonId, leagueSeasonId))
        .orderBy(asc(rosterSlotRules.id)),
      this.#database
        .select({
          id: players.id,
          fullName: players.fullName,
          primaryPosition: players.primaryPosition,
          eligiblePositions: players.eligiblePositions,
          nflTeam: players.nflTeam,
          status: players.status,
        })
        .from(players)
        .where(
          and(
            or(
              gte(players.lastSeason, scope.season - 1),
              gte(players.rookieSeason, scope.season - 1),
              isNull(players.gsisId),
            ),
            leagueScopedPlayerCatalogFilter(leagueSeasonId),
          ),
        )
        .orderBy(asc(players.id))
        .limit(5_000),
    ]);

    return {
      leagueId: scope.leagueId,
      leagueSeasonId: scope.leagueSeasonId,
      provider: scope.provider,
      draftType: scope.draftType,
      teamCount: scope.teamCount,
      settings: scope.settings,
      archived: scope.archived,
      accessRole,
      teams: teamRows,
      rosterRules: rosterRows,
      players: playerRows,
    };
  }

  async createDraft(input: NewStoredDraft): Promise<CreateStoredDraftResult> {
    return this.#database.transaction(async (transaction) => {
      const [scope] = await transaction
        .select({
          ownerUserId: leagues.ownerUserId,
          archived: leagues.archived,
          membershipRole: leagueMemberships.role,
          explicitCommissioner: leagueMemberships.explicitCommissioner,
          providerCommissioner: providerCommissionerAuthoritySql(
            input.actorUserId,
            leagueSeasons.id,
          ),
        })
        .from(leagueSeasons)
        .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
        .leftJoin(
          leagueMemberships,
          and(
            eq(leagueMemberships.leagueId, leagues.id),
            eq(leagueMemberships.userId, input.actorUserId),
          ),
        )
        .where(eq(leagueSeasons.id, input.leagueSeasonId))
        .limit(1);
      if (!scope) return { status: "not-found" };
      const accessRole = effectiveRole(
        scope.ownerUserId,
        input.actorUserId,
        scope.membershipRole,
        scope.explicitCommissioner ?? false,
        scope.providerCommissioner,
      );
      if (accessRole === undefined) return { status: "not-found" };
      if (!mayMutate(accessRole)) return { status: "forbidden" };
      if (scope.archived) return { status: "archived" };

      const [created] = await transaction
        .insert(drafts)
        .values({
          id: input.id,
          leagueSeasonId: input.leagueSeasonId,
          type: input.type,
          state: "created",
          budgetPerTeam: input.budgetPerTeam,
          minimumBid: input.minimumBid,
          settings: input.settings,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (!created) throw new Error("Draft insert returned no row");
      return { status: "saved", draft: storedDraftFromRow(created, accessRole, false) };
    });
  }

  async loadDraft(userId: string, draftId: string): Promise<StoredDraft | undefined> {
    const [row] = await this.#database
      .select({
        draft: drafts,
        ownerUserId: leagues.ownerUserId,
        archived: leagues.archived,
        membershipRole: leagueMemberships.role,
        explicitCommissioner: leagueMemberships.explicitCommissioner,
        providerCommissioner: providerCommissionerAuthoritySql(userId, leagueSeasons.id),
      })
      .from(drafts)
      .innerJoin(leagueSeasons, eq(drafts.leagueSeasonId, leagueSeasons.id))
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .leftJoin(
        leagueMemberships,
        and(eq(leagueMemberships.leagueId, leagues.id), eq(leagueMemberships.userId, userId)),
      )
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!row) return undefined;
    const accessRole = effectiveRole(
      row.ownerUserId,
      userId,
      row.membershipRole,
      row.explicitCommissioner ?? false,
      row.providerCommissioner,
    );
    return accessRole === undefined
      ? undefined
      : storedDraftFromRow(row.draft, accessRole, row.archived);
  }

  async listEvents(draftId: string): Promise<readonly StoredDraftEvent[]> {
    const rows = await this.#database
      .select()
      .from(draftEvents)
      .where(eq(draftEvents.draftId, draftId))
      .orderBy(asc(draftEvents.sequence));
    return rows.map(storedEventFromRow);
  }

  async appendEvents(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly expectedSequence: number;
    readonly events: readonly PendingDraftEvent[];
    readonly resultingState: "live" | "complete";
    readonly now: Date;
  }): Promise<AppendStoredEventsResult> {
    validatePendingBatch(input.expectedSequence, input.events);
    return this.#database.transaction(async (transaction) =>
      this.#appendInsideTransaction(transaction, input),
    );
  }

  async #appendInsideTransaction(
    transaction: DatabaseTransaction,
    input: {
      readonly actorUserId: string;
      readonly draftId: string;
      readonly expectedSequence: number;
      readonly events: readonly PendingDraftEvent[];
      readonly resultingState: "live" | "complete";
      readonly now: Date;
    },
  ): Promise<AppendStoredEventsResult> {
    await transaction.execute(sql`select id from drafts where id = ${input.draftId} for update`);
    const [scope] = await transaction
      .select({
        ownerUserId: leagues.ownerUserId,
        archived: leagues.archived,
        membershipRole: leagueMemberships.role,
        explicitCommissioner: leagueMemberships.explicitCommissioner,
        providerCommissioner: providerCommissionerAuthoritySql(input.actorUserId, leagueSeasons.id),
      })
      .from(drafts)
      .innerJoin(leagueSeasons, eq(drafts.leagueSeasonId, leagueSeasons.id))
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .leftJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagues.id),
          eq(leagueMemberships.userId, input.actorUserId),
        ),
      )
      .where(eq(drafts.id, input.draftId))
      .limit(1);
    if (!scope) return { status: "not-found" };
    const accessRole = effectiveRole(
      scope.ownerUserId,
      input.actorUserId,
      scope.membershipRole,
      scope.explicitCommissioner ?? false,
      scope.providerCommissioner,
    );
    if (accessRole === undefined) return { status: "not-found" };
    if (!mayMutate(accessRole)) return { status: "forbidden" };
    if (scope.archived) return { status: "archived" };

    const keys = input.events.map((event) => event.idempotencyKey);
    const existing =
      keys.length === 0
        ? []
        : await transaction
            .select()
            .from(draftEvents)
            .where(
              and(
                eq(draftEvents.draftId, input.draftId),
                inArray(draftEvents.idempotencyKey, keys),
              ),
            )
            .orderBy(asc(draftEvents.sequence));
    if (existing.length > 0) {
      const byKey = new Map(existing.map((event) => [event.idempotencyKey, event]));
      const completeMatch = input.events.every((event) => {
        const row = byKey.get(event.idempotencyKey);
        return row !== undefined && eventPayloadMatches(storedEventFromRow(row), event);
      });
      return completeMatch && existing.length === input.events.length
        ? { status: "idempotent", events: existing.map(storedEventFromRow) }
        : { status: "idempotency-conflict" };
    }

    const [latest] = await transaction
      .select({ sequence: max(draftEvents.sequence) })
      .from(draftEvents)
      .where(eq(draftEvents.draftId, input.draftId));
    const currentSequence = latest?.sequence ?? 0;
    if (currentSequence !== input.expectedSequence) {
      return { status: "version-conflict", currentSequence };
    }

    try {
      const inserted = await transaction
        .insert(draftEvents)
        .values(
          input.events.map((event) => ({
            draftId: input.draftId,
            sequence: event.sequence,
            idempotencyKey: event.idempotencyKey,
            type: event.type,
            occurredAt: event.occurredAt,
            source: event.source,
            payload: event.payload,
            revertsSequence: event.revertsSequence,
          })),
        )
        .returning();
      await transaction
        .update(drafts)
        .set({ state: input.resultingState, updatedAt: input.now })
        .where(eq(drafts.id, input.draftId));
      return { status: "saved", events: inserted.map(storedEventFromRow) };
    } catch (error) {
      if (isUniqueViolation(error)) return { status: "idempotency-conflict" };
      throw error;
    }
  }
}

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

function jsonRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function uniquePositions(values: readonly string[]): readonly Position[] {
  const normalized = values.map((value) => {
    const position = value.trim().toUpperCase();
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
    return aliases[position] ?? position;
  });
  return [...new Set(normalized.filter(isPosition))];
}

function normalizedSlotCode(value: string): string {
  return value.trim().toUpperCase().replaceAll(" ", "_");
}

function rosterSlotTypeForRule(rule: LeagueDraftSourceRosterRule): RosterSlotType {
  const slotCode = normalizedSlotCode(rule.slotCode);
  if (!rule.isStarter) {
    if (slotCode === "IR") return "IR";
    if (["TAXI", "TAXI_SQUAD"].includes(slotCode)) return "TAXI";
    return "BENCH";
  }

  const direct: Readonly<Record<string, RosterSlotType>> = {
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
  const known = direct[slotCode];
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
  throw new DraftSessionError(
    "DRAFT_CONFIG_INVALID",
    `Roster slot ${rule.slotCode} cannot be mapped to a supported draft slot.`,
  );
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

function buildRosterSlots(rules: readonly LeagueDraftSourceRosterRule[]): {
  readonly slots: readonly RosterSlot[];
  readonly excludedCodes: readonly string[];
} {
  const slots: RosterSlot[] = [];
  const excludedCodes: string[] = [];
  for (const rule of rules) {
    if (!Number.isSafeInteger(rule.count) || rule.count < 0) {
      throw new DraftSessionError(
        "DRAFT_CONFIG_INVALID",
        `Roster slot ${rule.slotCode} has an invalid count.`,
      );
    }
    const code = normalizedSlotCode(rule.slotCode);
    if (["IR", "TAXI", "TAXI_SQUAD"].includes(code)) {
      if (rule.count > 0) excludedCodes.push(rule.slotCode);
      continue;
    }
    if (rule.count === 0) continue;
    const type = rosterSlotTypeForRule(rule);
    const configuredEligibility = uniquePositions(rule.eligiblePositions);
    const eligiblePositions =
      configuredEligibility.length > 0 ? configuredEligibility : defaultSlotEligibility(type);
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
  if (slots.length === 0) {
    throw new DraftSessionError(
      "DRAFT_CONFIG_INVALID",
      "The league has no configured draftable roster slots.",
    );
  }
  return { slots, excludedCodes };
}

function buildPlayers(
  rows: readonly LeagueDraftSourcePlayer[],
  slots: readonly RosterSlot[],
): readonly Player[] {
  const starterSlots = slots.filter((slot) => slot.kind === "STARTER");
  const eligiblePool = new Set(
    (starterSlots.length > 0 ? starterSlots : slots).flatMap((slot) => slot.eligiblePositions),
  );
  const result: Player[] = [];
  for (const row of rows) {
    const positions = uniquePositions([row.primaryPosition, ...row.eligiblePositions]);
    if (
      positions.length === 0 ||
      !positions.some((position) => eligiblePool.has(position)) ||
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
  if (result.length === 0) {
    throw new DraftSessionError(
      "DRAFT_CONFIG_INVALID",
      "The player catalog has no players with supported fantasy positions.",
    );
  }
  return result;
}

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

function firstSetting(
  settings: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
): unknown {
  for (const path of paths) {
    const value = nestedSetting(settings, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function configuredPositiveInteger(
  explicit: number | undefined,
  settings: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
  fallback?: number,
): number | undefined {
  const candidate = explicit ?? firstSetting(settings, paths) ?? fallback;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : undefined;
}

function configuredBoolean(
  explicit: boolean | undefined,
  settings: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
): boolean {
  if (explicit !== undefined) return explicit;
  const candidate = firstSetting(settings, paths);
  return candidate === true;
}

function configuredTeamOrder(
  explicit: readonly string[] | undefined,
  settings: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  if (explicit !== undefined) return explicit;
  const value = firstSetting(settings, [
    ["draftOrder"],
    ["snakeDraftOrder"],
    ["draftSettings", "teamOrder"],
  ]);
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function resolveTeamOrder(
  requestedOrder: readonly string[] | undefined,
  teams: readonly LeagueDraftSourceTeam[],
): readonly TeamId[] {
  if (requestedOrder === undefined) {
    throw new DraftSessionError(
      "DRAFT_CONFIG_INVALID",
      "Snake drafts require the actual team order, supplied manually or stored in league settings.",
    );
  }
  const byIdentifier = new Map<string, string>();
  for (const team of teams) {
    byIdentifier.set(team.id, team.id);
    byIdentifier.set(team.externalKey, team.id);
  }
  const resolved = requestedOrder.map((identifier) => byIdentifier.get(identifier));
  if (resolved.some((id) => id === undefined)) {
    throw new DraftSessionError(
      "DRAFT_CONFIG_INVALID",
      "Snake team order references a team that is not in this league season.",
    );
  }
  const ids = resolved as string[];
  const leagueTeamIds = new Set(teams.map((team) => team.id));
  if (
    ids.length !== teams.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !leagueTeamIds.has(id))
  ) {
    throw new DraftSessionError(
      "DRAFT_CONFIG_INVALID",
      "Snake team order must contain every league team exactly once.",
    );
  }
  return ids.map(teamId);
}

function storedConfigToDomain(input: z.infer<typeof storedConfigSchema>): DraftConfig {
  const roster = (slot: z.infer<typeof storedRosterSlotSchema>): RosterSlot => ({
    id: rosterSlotId(slot.id),
    type: slot.type,
    label: slot.label,
    kind: slot.kind,
    eligiblePositions: slot.eligiblePositions,
  });
  const player = (item: z.infer<typeof storedPlayerSchema>): Player => ({
    id: playerId(item.id),
    name: item.name,
    positions: item.positions,
    ...(item.nflTeam === undefined ? {} : { nflTeam: item.nflTeam }),
    ...(item.status === undefined ? {} : { status: item.status }),
  });
  const teams = input.teams.map((team) => ({
    id: teamId(team.id),
    name: team.name,
    rosterSlots: team.rosterSlots.map(roster),
    ...(team.budget === undefined ? {} : { budget: team.budget }),
  }));
  const playerPool = input.players.map(player);
  return input.mode === "SNAKE"
    ? {
        mode: "SNAKE",
        teams,
        players: playerPool,
        pickOrder: input.pickOrder.map(teamId),
      }
    : { mode: "AUCTION", teams, players: playerPool, minimumBid: input.minimumBid };
}

function actionToEvent(
  draftId: string,
  idempotencyKey: string,
  input: z.infer<typeof appendActionSchema>,
  occurredAt: Date,
): DraftEvent {
  const id = draftEventIdFor("manual", draftId, idempotencyKey);
  const timestamp = occurredAt.toISOString();
  switch (input.type) {
    case "SNAKE_PLAYER_SELECTED":
    case "SNAKE_KEEPER_ASSIGNED":
      return {
        id,
        type: input.type,
        teamId: teamId(input.teamId),
        playerId: playerId(input.playerId),
        overallPick: input.overallPick,
        occurredAt: timestamp,
      };
    case "AUCTION_KEEPER_ASSIGNED":
    case "AUCTION_PLAYER_SOLD":
      return {
        id,
        type: input.type,
        teamId: teamId(input.teamId),
        playerId: playerId(input.playerId),
        price: input.price,
        occurredAt: timestamp,
      };
    case "AUCTION_NOMINATION_STARTED":
      return {
        id,
        type: input.type,
        teamId: teamId(input.teamId),
        playerId: playerId(input.playerId),
        nominationNumber: input.nominationNumber,
        occurredAt: timestamp,
      };
    case "AUCTION_BID_PLACED":
      return {
        id,
        type: input.type,
        teamId: teamId(input.teamId),
        playerId: playerId(input.playerId),
        amount: input.amount,
        occurredAt: timestamp,
      };
  }
}

function revertEvent(
  draftId: string,
  idempotencyKey: string,
  targetEventId: DraftEventId,
  occurredAt: Date,
): DraftEvent {
  return {
    id: draftEventIdFor("manual", draftId, idempotencyKey),
    type: "DRAFT_EVENT_REVERTED",
    targetEventId,
    occurredAt: occurredAt.toISOString(),
  };
}

function eventPayload(event: DraftEvent): Record<string, unknown> {
  const payload = jsonRecord(event);
  delete payload.occurredAt;
  return payload;
}

function parsedStoredEvent(row: StoredDraftEvent): DraftEvent {
  const parsed = storedEventSchema.parse(row.payload);
  const occurredAt = row.occurredAt.toISOString();
  let event: DraftEvent;
  switch (parsed.type) {
    case "SNAKE_PLAYER_SELECTED":
    case "SNAKE_KEEPER_ASSIGNED":
      event = {
        id: draftEventId(parsed.id),
        type: parsed.type,
        teamId: teamId(parsed.teamId),
        playerId: playerId(parsed.playerId),
        overallPick: parsed.overallPick,
        occurredAt,
      };
      break;
    case "AUCTION_KEEPER_ASSIGNED":
    case "AUCTION_PLAYER_SOLD":
      event = {
        id: draftEventId(parsed.id),
        type: parsed.type,
        teamId: teamId(parsed.teamId),
        playerId: playerId(parsed.playerId),
        price: parsed.price,
        occurredAt,
      };
      break;
    case "AUCTION_NOMINATION_STARTED":
      event = {
        id: draftEventId(parsed.id),
        type: parsed.type,
        teamId: teamId(parsed.teamId),
        playerId: playerId(parsed.playerId),
        nominationNumber: parsed.nominationNumber,
        occurredAt,
      };
      break;
    case "AUCTION_BID_PLACED":
      event = {
        id: draftEventId(parsed.id),
        type: parsed.type,
        teamId: teamId(parsed.teamId),
        playerId: playerId(parsed.playerId),
        amount: parsed.amount,
        occurredAt,
      };
      break;
    case "DRAFT_EVENT_REVERTED":
      event = {
        id: draftEventId(parsed.id),
        type: parsed.type,
        targetEventId: draftEventId(parsed.targetEventId),
        occurredAt,
      };
      break;
  }
  if (event.type !== row.type || !draftEventSources.has(row.source)) {
    throw new Error("Draft event metadata does not match its payload");
  }
  return event;
}

function pendingEvent(
  sequence: number,
  idempotencyKey: string,
  event: DraftEvent,
  occurredAt: Date,
  revertsSequence: number | null = null,
): PendingDraftEvent {
  return {
    sequence,
    idempotencyKey,
    type: event.type,
    occurredAt,
    source: "manual",
    payload: eventPayload(event),
    revertsSequence,
  };
}

function parseFailure(message: string): DraftSessionError {
  return new DraftSessionError("DRAFT_INVALID_INPUT", message);
}

function invariantFailure(error: DraftInvariantError): DraftSessionError {
  return new DraftSessionError("DRAFT_INVARIANT", error.message, {
    invariantCode: error.code,
  });
}

function reduceOrThrow(
  config: DraftConfig,
  events: readonly DraftEvent[],
  corrupt: boolean,
): DraftState {
  try {
    return reduceDraft(config, events);
  } catch (error) {
    if (error instanceof DraftInvariantError) {
      if (corrupt) {
        throw new DraftSessionError(
          "DRAFT_STREAM_CORRUPT",
          `Stored draft event stream violates ${error.code}: ${error.message}`,
          { invariantCode: error.code },
        );
      }
      throw invariantFailure(error);
    }
    throw error;
  }
}

function validateNewDraftConfig(config: DraftConfig): void {
  try {
    reduceDraft(config, []);
  } catch (error) {
    if (error instanceof DraftInvariantError) {
      throw new DraftSessionError("DRAFT_CONFIG_INVALID", error.message, {
        invariantCode: error.code,
      });
    }
    throw error;
  }
}

function eventRecordMatches(record: DraftSessionEventRecord, pending: PendingDraftEvent): boolean {
  return (
    record.sequence === pending.sequence &&
    record.idempotencyKey === pending.idempotencyKey &&
    record.source === pending.source &&
    record.revertsSequence === pending.revertsSequence &&
    record.event.type === pending.type &&
    isDeepStrictEqual(eventPayload(record.event), pending.payload)
  );
}

function activeCorrectionTarget(
  session: DraftSessionSnapshot,
  sequence: number,
): DraftSessionEventRecord {
  const target = session.events.find((record) => record.sequence === sequence);
  if (
    target === undefined ||
    target.event.type === "DRAFT_EVENT_REVERTED" ||
    !session.state.activeEventIds.includes(target.event.id)
  ) {
    throw new DraftSessionError(
      "DRAFT_CORRECTION_TARGET_INVALID",
      `Sequence ${sequence} is not an active draft action and cannot be reverted.`,
    );
  }
  return target;
}

export class DraftSessionService {
  readonly #repository: DraftSessionRepository;
  readonly #now: () => Date;

  constructor(repository: DraftSessionRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async createSession(
    actorUserId: string,
    unsafeInput: CreateDraftSessionInput,
  ): Promise<DraftSessionSnapshot> {
    const result = createSessionInputSchema.safeParse(unsafeInput);
    if (!result.success) throw parseFailure("Draft session settings are invalid.");
    const input = result.data;
    const source = await this.#repository.loadLeagueDraftSource(actorUserId, input.leagueSeasonId);
    if (source === undefined) {
      throw new DraftSessionError(
        "DRAFT_NOT_FOUND",
        "The league season was not found for this account.",
      );
    }
    if (!mayMutate(source.accessRole)) {
      throw new DraftSessionError(
        "DRAFT_FORBIDDEN",
        "Only a league commissioner can create a shared draft session.",
      );
    }
    if (source.archived) {
      throw new DraftSessionError(
        "DRAFT_FORBIDDEN",
        "Archived leagues cannot start a new draft session.",
      );
    }
    if (source.teams.length !== source.teamCount || source.teams.length < 2) {
      throw new DraftSessionError(
        "DRAFT_CONFIG_INVALID",
        `League settings expect ${source.teamCount} teams, but ${source.teams.length} are available.`,
      );
    }

    const normalizedDraftType = source.draftType.trim().toLowerCase();
    const configuredMode = ["snake", "auction"].includes(normalizedDraftType)
      ? (normalizedDraftType as "snake" | "auction")
      : undefined;
    if (input.mode !== undefined && configuredMode !== undefined && input.mode !== configuredMode) {
      throw new DraftSessionError(
        "DRAFT_CONFIG_INVALID",
        `Requested ${input.mode} mode conflicts with the league's ${configuredMode} draft setting.`,
      );
    }
    const mode = input.mode ?? configuredMode;
    if (mode === undefined) {
      throw new DraftSessionError(
        "DRAFT_CONFIG_INVALID",
        "Choose snake or auction mode because the league draft type is not recognized.",
      );
    }

    const { slots, excludedCodes } = buildRosterSlots(source.rosterRules);
    const playerPool = buildPlayers(source.players, slots);
    const baseTeams = source.teams.map((team) => ({
      id: teamId(team.id),
      name: team.name.trim(),
      rosterSlots: slots,
    }));
    if (baseTeams.some((team) => team.name.length === 0)) {
      throw new DraftSessionError(
        "DRAFT_CONFIG_INVALID",
        "Every fantasy team needs a name before a draft can start.",
      );
    }
    let config: DraftConfig;
    let budgetPerTeam: number | null = null;
    let minimumBid: number | null = null;
    if (mode === "snake") {
      const teamOrder = resolveTeamOrder(
        configuredTeamOrder(input.teamOrder, source.settings),
        source.teams,
      );
      const thirdRoundReversal = configuredBoolean(input.thirdRoundReversal, source.settings, [
        ["thirdRoundReversal"],
        ["draftSettings", "thirdRoundReversal"],
      ]);
      config = {
        mode: "SNAKE",
        teams: baseTeams,
        players: playerPool,
        pickOrder: createSnakePickOrder(teamOrder, slots.length, { thirdRoundReversal }),
      };
    } else {
      budgetPerTeam =
        configuredPositiveInteger(input.budgetPerTeam, source.settings, [
          ["auctionBudget"],
          ["draftBudget"],
          ["draftSettings", "auctionBudget"],
        ]) ?? null;
      minimumBid =
        configuredPositiveInteger(
          input.minimumBid,
          source.settings,
          [["minimumBid"], ["draftSettings", "minimumBid"]],
          1,
        ) ?? null;
      if (budgetPerTeam === null || minimumBid === null) {
        throw new DraftSessionError(
          "DRAFT_CONFIG_INVALID",
          "Auction drafts require a positive per-team budget and minimum bid.",
        );
      }
      const auctionBudget = budgetPerTeam;
      config = {
        mode: "AUCTION",
        teams: baseTeams.map((team) => ({ ...team, budget: auctionBudget })),
        players: playerPool,
        minimumBid,
      };
    }
    validateNewDraftConfig(config);

    const now = this.#now();
    const id = randomUUID();
    const settings = jsonRecord({
      schemaVersion: 1,
      transport: "manual",
      providerPolling: false,
      source: {
        leagueSeasonId: source.leagueSeasonId,
        provider: source.provider,
        sourceDraftType: source.draftType,
        excludedRosterSlotCodes: excludedCodes,
      },
      config,
    });
    const created = await this.#repository.createDraft({
      id,
      actorUserId,
      leagueSeasonId: source.leagueSeasonId,
      type: mode,
      budgetPerTeam,
      minimumBid,
      settings,
      now,
    });
    switch (created.status) {
      case "not-found":
        throw new DraftSessionError(
          "DRAFT_NOT_FOUND",
          "The league season is no longer available to this account.",
        );
      case "forbidden":
        throw new DraftSessionError(
          "DRAFT_FORBIDDEN",
          "Only a league commissioner can create a shared draft session.",
        );
      case "archived":
        throw new DraftSessionError(
          "DRAFT_FORBIDDEN",
          "Archived leagues cannot start a new draft session.",
        );
      case "saved":
        return this.getSession(actorUserId, created.draft.id);
    }
  }

  async getSession(userId: string, draftId: string): Promise<DraftSessionSnapshot> {
    const parsedDraftId = uuidSchema.safeParse(draftId);
    if (!parsedDraftId.success) throw parseFailure("Draft session ID is invalid.");
    const draft = await this.#repository.loadDraft(userId, parsedDraftId.data);
    if (draft === undefined) {
      throw new DraftSessionError(
        "DRAFT_NOT_FOUND",
        "The draft session was not found for this account.",
      );
    }
    const rows = await this.#repository.listEvents(draft.id);
    const providerFeed = (await this.#repository.loadProviderFeedStatus?.(draft.id)) ?? null;
    return this.#hydrate(draft, rows, providerFeed);
  }

  async appendEvent(
    actorUserId: string,
    draftId: string,
    unsafeInput: AppendDraftEventInput,
  ): Promise<DraftMutationResult> {
    const result = appendInputSchema.safeParse(unsafeInput);
    if (!result.success) throw parseFailure("Draft event input is invalid.");
    const input = result.data;
    const session = await this.getSession(actorUserId, draftId);
    this.#assertMutable(session);
    const now = this.#now();
    const event = actionToEvent(draftId, input.idempotencyKey, input.action, now);
    const pending = pendingEvent(input.expectedSequence + 1, input.idempotencyKey, event, now);
    const existing = session.events.find(
      (record) => record.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (!eventRecordMatches(existing, pending)) this.#idempotencyConflict();
      return { idempotent: true, appendedSequences: [existing.sequence], session };
    }
    if (session.state.complete) {
      throw new DraftSessionError(
        "DRAFT_INVARIANT",
        "The draft is complete; undo or correct an event before adding another action.",
        { invariantCode: "DRAFT_COMPLETE" },
      );
    }
    this.#assertExpectedSequence(session, input.expectedSequence);
    const resultingState = reduceOrThrow(
      this.#config(session),
      [...session.events.map((record) => record.event), event],
      false,
    );
    return this.#persist(actorUserId, session, [pending], resultingState);
  }

  async undoEvent(
    actorUserId: string,
    draftId: string,
    unsafeInput: UndoDraftEventInput,
  ): Promise<DraftMutationResult> {
    const result = undoInputSchema.safeParse(unsafeInput);
    if (!result.success) throw parseFailure("Draft undo input is invalid.");
    const input = result.data;
    const session = await this.getSession(actorUserId, draftId);
    this.#assertMutable(session);
    const existing = session.events.find(
      (record) => record.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (
        existing.event.type !== "DRAFT_EVENT_REVERTED" ||
        (input.targetSequence !== undefined && existing.revertsSequence !== input.targetSequence)
      ) {
        this.#idempotencyConflict();
      }
      return { idempotent: true, appendedSequences: [existing.sequence], session };
    }
    this.#assertExpectedSequence(session, input.expectedSequence);
    let target: DraftSessionEventRecord;
    if (input.targetSequence !== undefined) {
      target = activeCorrectionTarget(session, input.targetSequence);
    } else {
      const latest = latestUndoableEvent(session.events.map((record) => record.event));
      if (latest === null) {
        throw new DraftSessionError(
          "DRAFT_CORRECTION_TARGET_INVALID",
          "There is no active draft action to undo.",
        );
      }
      const latestRecord = session.events.find((record) => record.event.id === latest.id);
      if (latestRecord === undefined) {
        throw new DraftSessionError(
          "DRAFT_STREAM_CORRUPT",
          "Latest active draft event is missing from the stored stream.",
        );
      }
      target = activeCorrectionTarget(session, latestRecord.sequence);
    }
    const now = this.#now();
    const event = revertEvent(draftId, input.idempotencyKey, target.event.id, now);
    const pending = pendingEvent(
      input.expectedSequence + 1,
      input.idempotencyKey,
      event,
      now,
      target.sequence,
    );
    const resultingState = reduceOrThrow(
      this.#config(session),
      [...session.events.map((record) => record.event), event],
      false,
    );
    return this.#persist(actorUserId, session, [pending], resultingState);
  }

  async correctEvent(
    actorUserId: string,
    draftId: string,
    unsafeInput: CorrectDraftEventInput,
  ): Promise<DraftMutationResult> {
    const result = correctionInputSchema.safeParse(unsafeInput);
    if (!result.success) throw parseFailure("Draft correction input is invalid.");
    const input = result.data;
    const session = await this.getSession(actorUserId, draftId);
    this.#assertMutable(session);
    const revertKey = input.idempotencyKey;
    const replacementKey = `${input.idempotencyKey}:replacement`;
    const now = this.#now();
    const storedRevert = session.events.find((record) => record.idempotencyKey === revertKey);
    const storedReplacement = session.events.find(
      (record) => record.idempotencyKey === replacementKey,
    );
    if (storedRevert !== undefined || storedReplacement !== undefined) {
      if (storedRevert === undefined || storedReplacement === undefined) {
        this.#idempotencyConflict();
      }
      const expectedReplacement = actionToEvent(draftId, replacementKey, input.replacement, now);
      const replacementMatches =
        storedReplacement.sequence === input.expectedSequence + 2 &&
        storedReplacement.event.type === expectedReplacement.type &&
        isDeepStrictEqual(eventPayload(storedReplacement.event), eventPayload(expectedReplacement));
      const revertMatches =
        storedRevert.sequence === input.expectedSequence + 1 &&
        storedRevert.event.type === "DRAFT_EVENT_REVERTED" &&
        storedRevert.revertsSequence === input.targetSequence;
      if (!replacementMatches || !revertMatches) this.#idempotencyConflict();
      return {
        idempotent: true,
        appendedSequences: [storedRevert.sequence, storedReplacement.sequence],
        session,
      };
    }
    this.#assertExpectedSequence(session, input.expectedSequence);
    const target = activeCorrectionTarget(session, input.targetSequence);
    const revert = revertEvent(draftId, revertKey, target.event.id, now);
    const replacement = actionToEvent(draftId, replacementKey, input.replacement, now);
    const pending = [
      pendingEvent(input.expectedSequence + 1, revertKey, revert, now, target.sequence),
      pendingEvent(input.expectedSequence + 2, replacementKey, replacement, now),
    ];
    const resultingState = reduceOrThrow(
      this.#config(session),
      [...session.events.map((record) => record.event), revert, replacement],
      false,
    );
    return this.#persist(actorUserId, session, pending, resultingState);
  }

  #hydrate(
    draft: StoredDraft,
    rows: readonly StoredDraftEvent[],
    providerFeed: EspnLiveDraftFeedStatus | null = null,
  ): DraftSessionSnapshot {
    try {
      const settings = storedSettingsSchema.parse(draft.settings);
      if (
        settings.source.leagueSeasonId !== draft.leagueSeasonId ||
        (settings.config.mode === "SNAKE" ? "snake" : "auction") !== draft.type
      ) {
        throw new Error("Stored draft configuration does not match its database row");
      }
      const config = storedConfigToDomain(settings.config);
      if (
        (config.mode === "SNAKE" && (draft.budgetPerTeam !== null || draft.minimumBid !== null)) ||
        (config.mode === "AUCTION" &&
          (draft.minimumBid !== config.minimumBid ||
            config.teams.some((team) => team.budget !== draft.budgetPerTeam)))
      ) {
        throw new Error("Stored draft budget columns do not match the immutable configuration");
      }
      const records: DraftSessionEventRecord[] = [];
      const idBySequence = new Map<number, DraftEventId>();
      for (const [index, row] of rows.entries()) {
        const expectedSequence = index + 1;
        if (row.draftId !== draft.id || row.sequence !== expectedSequence) {
          throw new Error("Draft event sequence is not contiguous");
        }
        const event = parsedStoredEvent(row);
        if (event.type === "DRAFT_EVENT_REVERTED") {
          if (
            row.revertsSequence === null ||
            idBySequence.get(row.revertsSequence) !== event.targetEventId
          ) {
            throw new Error("Draft revert metadata does not match its target event");
          }
        } else if (row.revertsSequence !== null) {
          throw new Error("Only revert events may set revertsSequence");
        }
        idBySequence.set(row.sequence, event.id);
        records.push({
          sequence: row.sequence,
          idempotencyKey: row.idempotencyKey,
          source: row.source,
          occurredAt: row.occurredAt.toISOString(),
          revertsSequence: row.revertsSequence,
          event,
        });
      }
      const state = reduceOrThrow(
        config,
        records.map((record) => record.event),
        true,
      );
      return {
        id: draft.id,
        leagueSeasonId: draft.leagueSeasonId,
        transport: settings.transport,
        // Honest liveness: a feed row that has gone stale, degraded, or complete is no longer
        // polling, so the UI must not keep asserting a live provider connection.
        providerPolling:
          providerFeed !== null &&
          (providerFeed.state === "live" ||
            providerFeed.state === "waiting" ||
            providerFeed.state === "paused"),
        providerFeed,
        accessRole: draft.accessRole,
        sequence: records.length,
        persistedState: draft.state,
        config,
        state,
        events: records,
        createdAt: draft.createdAt.toISOString(),
        updatedAt: draft.updatedAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof DraftSessionError) throw error;
      throw new DraftSessionError(
        "DRAFT_STREAM_CORRUPT",
        error instanceof Error ? error.message : "Stored draft stream is invalid.",
      );
    }
  }

  #config(session: DraftSessionSnapshot): DraftConfig {
    return session.config;
  }

  #assertMutable(session: DraftSessionSnapshot): void {
    if (!mayMutate(session.accessRole)) {
      throw new DraftSessionError(
        "DRAFT_FORBIDDEN",
        "Only a league commissioner can record shared draft events.",
      );
    }
  }

  #assertExpectedSequence(session: DraftSessionSnapshot, expectedSequence: number): void {
    if (session.sequence !== expectedSequence) {
      throw new DraftSessionError(
        "DRAFT_VERSION_CONFLICT",
        `Draft is at sequence ${session.sequence}; reconnect before writing.`,
        { currentSequence: session.sequence },
      );
    }
  }

  #idempotencyConflict(): never {
    throw new DraftSessionError(
      "DRAFT_IDEMPOTENCY_CONFLICT",
      "That idempotency key was already used for a different draft mutation.",
    );
  }

  async #persist(
    actorUserId: string,
    session: DraftSessionSnapshot,
    events: readonly PendingDraftEvent[],
    resultingState: DraftState,
  ): Promise<DraftMutationResult> {
    const result = await this.#repository.appendEvents({
      actorUserId,
      draftId: session.id,
      expectedSequence: session.sequence,
      events,
      resultingState: resultingState.complete ? "complete" : "live",
      now: this.#now(),
    });
    switch (result.status) {
      case "not-found":
        throw new DraftSessionError(
          "DRAFT_NOT_FOUND",
          "The draft session is no longer available to this account.",
        );
      case "forbidden":
        throw new DraftSessionError(
          "DRAFT_FORBIDDEN",
          "Only a league commissioner can record shared draft events.",
        );
      case "archived":
        throw new DraftSessionError(
          "DRAFT_FORBIDDEN",
          "Archived leagues cannot accept draft events.",
        );
      case "version-conflict":
        throw new DraftSessionError(
          "DRAFT_VERSION_CONFLICT",
          `Draft is at sequence ${result.currentSequence}; reconnect before writing.`,
          { currentSequence: result.currentSequence },
        );
      case "idempotency-conflict":
        return this.#idempotencyConflict();
      case "saved":
      case "idempotent": {
        const reconnected = await this.getSession(actorUserId, session.id);
        return {
          idempotent: result.status === "idempotent",
          appendedSequences: result.events.map((event) => event.sequence),
          session: reconnected,
        };
      }
    }
  }
}
