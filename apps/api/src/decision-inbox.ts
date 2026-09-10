import {
  inSeasonDecisionSnapshotSchema,
  type DecisionInboxItemState,
  type DecisionInboxResponse,
} from "@laces-out/contracts";
import {
  decisionInboxReceipts,
  fantasyTeams,
  leagueMemberships,
  leagueSeasons,
  type Database,
} from "@laces-out/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { buildDecisionInboxSummary } from "./decision-inbox-summary.js";

export interface DecisionInboxAccess {
  readonly membershipId: string;
  readonly teamId: string | null;
  /** Membership, latest season/week and sync changes invalidate a cached summary immediately. */
  readonly revision: string;
}

export interface DecisionInboxReceipt {
  readonly itemId: string;
  readonly state: DecisionInboxItemState;
  readonly updatedAt: string;
}

interface ReceiptScope {
  readonly userId: string;
  readonly leagueId: string;
  readonly membershipId: string;
  readonly teamId: string;
}

export interface DecisionInboxRepository {
  findAccess(userId: string, leagueId: string): Promise<DecisionInboxAccess | undefined>;
  listReceipts(
    scope: ReceiptScope,
    itemIds: readonly string[],
  ): Promise<readonly DecisionInboxReceipt[]>;
  saveReceipt(
    scope: ReceiptScope,
    itemId: string,
    state: DecisionInboxItemState,
    now: Date,
  ): Promise<DecisionInboxReceipt | undefined>;
}

const latestSeasonPredicate = sql`${leagueSeasons.id} = (
  select id from league_seasons
  where league_id = ${leagueMemberships.leagueId}
  order by season desc, updated_at desc limit 1
)`;

export class DrizzleDecisionInboxRepository implements DecisionInboxRepository {
  constructor(readonly database: Database) {}

  async findAccess(userId: string, leagueId: string): Promise<DecisionInboxAccess | undefined> {
    const [row] = await this.database
      .select({
        membershipId: leagueMemberships.id,
        membershipUpdatedAt: leagueMemberships.updatedAt,
        teamId: fantasyTeams.id,
        seasonId: leagueSeasons.id,
        week: leagueSeasons.currentWeek,
        seasonUpdatedAt: leagueSeasons.updatedAt,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
      })
      .from(leagueMemberships)
      .leftJoin(
        leagueSeasons,
        and(eq(leagueSeasons.leagueId, leagueMemberships.leagueId), latestSeasonPredicate),
      )
      .leftJoin(
        fantasyTeams,
        and(
          eq(fantasyTeams.id, leagueMemberships.claimedFantasyTeamId),
          eq(fantasyTeams.leagueSeasonId, leagueSeasons.id),
        ),
      )
      .where(and(eq(leagueMemberships.userId, userId), eq(leagueMemberships.leagueId, leagueId)))
      .limit(1);
    if (!row) return undefined;
    return {
      membershipId: row.membershipId,
      teamId: row.teamId,
      revision: JSON.stringify([
        row.membershipUpdatedAt,
        row.seasonId,
        row.week,
        row.seasonUpdatedAt,
        row.lastSyncedAt,
      ]),
    };
  }

  async listReceipts(
    scope: ReceiptScope,
    itemIds: readonly string[],
  ): Promise<readonly DecisionInboxReceipt[]> {
    if (itemIds.length === 0) return [];
    const rows = await this.database
      .select({
        itemId: decisionInboxReceipts.itemId,
        state: decisionInboxReceipts.state,
        updatedAt: decisionInboxReceipts.updatedAt,
      })
      .from(decisionInboxReceipts)
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.id, decisionInboxReceipts.membershipId),
          eq(leagueMemberships.id, scope.membershipId),
          eq(leagueMemberships.claimedFantasyTeamId, scope.teamId),
        ),
      )
      .where(
        and(
          eq(decisionInboxReceipts.userId, scope.userId),
          eq(decisionInboxReceipts.leagueId, scope.leagueId),
          eq(decisionInboxReceipts.teamId, scope.teamId),
          inArray(decisionInboxReceipts.itemId, [...itemIds]),
        ),
      );
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
  }

  async saveReceipt(
    scope: ReceiptScope,
    itemId: string,
    state: DecisionInboxItemState,
    now: Date,
  ): Promise<DecisionInboxReceipt | undefined> {
    // The insert itself checks the current claim, latest season and membership. A stale request
    // cannot write a receipt for a team another member has since claimed.
    const rows = await this.database.execute<{
      itemId: string;
      state: DecisionInboxItemState;
      updatedAt: string;
    }>(sql`
      insert into ${decisionInboxReceipts} (user_id, league_id, team_id, item_id, membership_id, state, updated_at)
      select ${scope.userId}::uuid, ${scope.leagueId}::uuid, ${scope.teamId}::uuid,
        ${itemId}, ${scope.membershipId}::uuid, ${state}, ${now.toISOString()}::timestamptz
      from ${leagueMemberships}
      inner join ${leagueSeasons} on ${leagueSeasons.leagueId} = ${leagueMemberships.leagueId} and ${latestSeasonPredicate}
      inner join ${fantasyTeams} on ${fantasyTeams.id} = ${leagueMemberships.claimedFantasyTeamId}
        and ${fantasyTeams.leagueSeasonId} = ${leagueSeasons.id}
      where ${leagueMemberships.id} = ${scope.membershipId}::uuid
        and ${leagueMemberships.userId} = ${scope.userId}::uuid
        and ${leagueMemberships.leagueId} = ${scope.leagueId}::uuid
        and ${fantasyTeams.id} = ${scope.teamId}::uuid
      on conflict (user_id, league_id, team_id, item_id) do update
        set state = excluded.state, updated_at = excluded.updated_at, membership_id = excluded.membership_id
      returning item_id as "itemId", state, updated_at as "updatedAt"
    `);
    const row = rows[0];
    return row ? { ...row, updatedAt: new Date(row.updatedAt).toISOString() } : undefined;
  }
}

interface CachedSummary {
  readonly promise: Promise<DecisionInboxResponse | undefined>;
  readonly expiresAt: number;
  pending: boolean;
}

export class DecisionInboxService {
  readonly #cache = new Map<string, CachedSummary>();

  constructor(
    readonly repository: DecisionInboxRepository,
    readonly decisions: { getSnapshot(userId: string, leagueId: string): Promise<unknown> },
    readonly now: () => Date = () => new Date(),
    readonly cacheTtlMs = 60_000,
    readonly maxCacheEntries = 128,
  ) {}

  #key(userId: string, leagueId: string, access: DecisionInboxAccess): string {
    return JSON.stringify([userId, leagueId, access.membershipId, access.teamId, access.revision]);
  }

  async #summary(
    userId: string,
    leagueId: string,
    access: DecisionInboxAccess,
    refresh: boolean,
  ): Promise<DecisionInboxResponse | undefined> {
    const key = this.#key(userId, leagueId, access);
    const cached = this.#cache.get(key);
    // Coalesce concurrent opens/refreshes, but an explicit refresh never reuses a completed result.
    if (cached && (cached.pending || (!refresh && cached.expiresAt > this.now().getTime()))) {
      return cached.promise;
    }
    this.#cache.delete(key);
    const promise = this.decisions.getSnapshot(userId, leagueId).then((snapshot) => {
      if (!snapshot) return undefined;
      const parsed = inSeasonDecisionSnapshotSchema.parse(snapshot);
      if (parsed.league.id !== leagueId || (parsed.team && parsed.team.id !== access.teamId))
        return undefined;
      if (
        !parsed.team &&
        [parsed.lineup, parsed.waivers, parsed.trades].some(
          (section) => section.state === "available",
        )
      )
        return undefined;
      return buildDecisionInboxSummary(parsed);
    });
    const entry: CachedSummary = {
      promise,
      expiresAt: this.now().getTime() + this.cacheTtlMs,
      pending: true,
    };
    this.#cache.set(key, entry);
    while (this.#cache.size > this.maxCacheEntries)
      this.#cache.delete(this.#cache.keys().next().value!);
    try {
      const summary = await promise;
      if (!summary && this.#cache.get(key) === entry) this.#cache.delete(key);
      return summary;
    } catch (error) {
      if (this.#cache.get(key) === entry) this.#cache.delete(key);
      throw error;
    } finally {
      entry.pending = false;
    }
  }

  async getInbox(
    userId: string,
    leagueId: string,
    options: { refresh?: boolean } = {},
  ): Promise<DecisionInboxResponse | undefined> {
    const access = await this.repository.findAccess(userId, leagueId);
    if (!access) return undefined;
    const summary = await this.#summary(userId, leagueId, access, options.refresh === true);
    if (!summary) return undefined;
    const receipts = access.teamId
      ? await this.repository.listReceipts(
          { userId, leagueId, membershipId: access.membershipId, teamId: access.teamId },
          summary.items.map((item) => item.id),
        )
      : [];
    const currentAccess = await this.repository.findAccess(userId, leagueId);
    // Recheck after asynchronous work as well as on every cache hit.
    if (
      !currentAccess ||
      this.#key(userId, leagueId, currentAccess) !== this.#key(userId, leagueId, access)
    )
      return undefined;
    const stateById = new Map(receipts.map((receipt) => [receipt.itemId, receipt.state]));
    return {
      ...summary,
      items: summary.items.map((item) => ({ ...item, state: stateById.get(item.id) ?? "open" })),
    };
  }

  async setState(
    userId: string,
    leagueId: string,
    itemId: string,
    state: DecisionInboxItemState,
  ): Promise<DecisionInboxReceipt | undefined> {
    const inbox = await this.getInbox(userId, leagueId);
    if (!inbox?.team || !inbox.items.some((item) => item.id === itemId)) return undefined;
    const access = await this.repository.findAccess(userId, leagueId);
    if (!access || access.teamId !== inbox.team.id) return undefined;
    return this.repository.saveReceipt(
      { userId, leagueId, membershipId: access.membershipId, teamId: inbox.team.id },
      itemId,
      state,
      this.now(),
    );
  }
}
