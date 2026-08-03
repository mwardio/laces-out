import {
  decodeChangeEventCursor,
  encodeChangeEventCursor,
  parseChangeEventPayload,
  type ChangeEvent,
  type ChangeEventFeedResponse,
  type ChangeEventReceiptResponse,
  type ChangeEventSeverity,
  type ChangeEventVisibility,
} from "@fantasy/contracts";
import type { Database } from "@fantasy/db";
import { sql } from "drizzle-orm";

/**
 * The authorized read side of the change-event feed.
 *
 * **Visibility is the whole security model and it lives in SQL.** The service never widens the
 * repository's predicate and never filters in TypeScript, because a filter applied after the rows
 * have been fetched is one refactor away from being forgotten. Concretely:
 *
 * - a `private` event is visible only when the writer created a receipt for this caller — there is
 *   no other path to one;
 * - a `league` event is gated on *live* membership, so a removed member stops seeing it immediately
 *   rather than at the next sweep;
 * - a `global` event is visible to every authenticated caller and carries no private league payload.
 *
 * **Retention is a read window, not a purge.** `change_events` is append-only at the database level
 * (`change_events_append_only_trigger`), so there is no DELETE path at all. Every read is bounded by
 * `CHANGE_EVENT_RETENTION_DAYS` as well as by `limit`. See `docs/operations.md`.
 */

/** Nothing older than this is served or counted. Deliberately a read window; see the note above. */
export const CHANGE_EVENT_RETENTION_DAYS = 45;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
/** Caps the unread scan so an unbounded backlog cannot produce an unbounded count query. */
const MAX_UNREAD_COUNT = 999;

export interface ChangeEventFeedQuery {
  readonly limit: number | null;
  readonly cursor: string | null;
  readonly leagueId: string | null;
}

export interface ChangeEventRepositoryQuery {
  readonly limit: number;
  readonly leagueId: string | null;
  readonly cursorOccurredAt: Date | null;
  readonly cursorId: string | null;
  readonly retentionFloor: Date;
}

export interface ChangeEventRow {
  readonly id: string;
  readonly eventType: string;
  readonly severity: ChangeEventSeverity;
  readonly visibility: ChangeEventVisibility;
  readonly leagueId: string | null;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
  readonly firstSeenAt: Date | null;
  readonly readAt: Date | null;
  readonly dismissedAt: Date | null;
}

export type ChangeEventReceiptField = "read" | "dismissed";

export interface ChangeEventRepository {
  listVisibleEvents(
    userId: string,
    query: ChangeEventRepositoryQuery,
  ): Promise<readonly ChangeEventRow[]>;
  /**
   * Scoped by `leagueId` for the same reason `listVisibleEvents` is: the badge sits on a feed the
   * caller is already reading, and a count drawn from a wider set than the rows below it reads as a
   * bug — "4 unread" over "Nothing new since your last sync."
   */
  countUnread(userId: string, leagueId: string | null, retentionFloor: Date): Promise<number>;
  findVisibleEvent(
    userId: string,
    eventId: string,
    retentionFloor: Date,
  ): Promise<ChangeEventRow | undefined>;
  /** `league` and `global` events may not have a receipt yet, so the first mark creates one. */
  upsertReceipt(
    userId: string,
    eventId: string,
    field: ChangeEventReceiptField,
    now: Date,
  ): Promise<Date | undefined>;
  /** `private` events always already have a receipt — that is how they became visible. */
  updateReceipt(
    userId: string,
    eventId: string,
    field: ChangeEventReceiptField,
    now: Date,
  ): Promise<Date | undefined>;
}

interface RawEventRow {
  // `execute<T>` requires an index signature; the named fields below are what the query projects.
  readonly [column: string]: unknown;
  readonly id: string;
  readonly event_type: string;
  readonly severity: string;
  readonly visibility: string;
  readonly league_id: string | null;
  readonly occurred_at: string | Date;
  readonly payload: Record<string, unknown>;
  readonly first_seen_at: string | Date | null;
  readonly read_at: string | Date | null;
  readonly dismissed_at: string | Date | null;
}

function toDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function toRow(raw: RawEventRow): ChangeEventRow {
  return {
    id: raw.id,
    eventType: raw.event_type,
    severity: raw.severity as ChangeEventSeverity,
    visibility: raw.visibility as ChangeEventVisibility,
    leagueId: raw.league_id,
    occurredAt: toDate(raw.occurred_at) ?? new Date(0),
    payload: raw.payload,
    firstSeenAt: toDate(raw.first_seen_at),
    readAt: toDate(raw.read_at),
    dismissedAt: toDate(raw.dismissed_at),
  };
}

export class DrizzleChangeEventRepository implements ChangeEventRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listVisibleEvents(
    userId: string,
    query: ChangeEventRepositoryQuery,
  ): Promise<readonly ChangeEventRow[]> {
    const rows = await this.#database.execute<RawEventRow>(sql`
      select e.id, e.event_type, e.severity, e.visibility, e.league_id, e.occurred_at, e.payload,
             r.first_seen_at, r.read_at, r.dismissed_at
        from change_events e
        left join change_event_receipts r
               on r.event_id = e.id and r.user_id = ${userId}::uuid
       where e.occurred_at > ${query.retentionFloor.toISOString()}::timestamptz
         and r.dismissed_at is null
         and (
               e.visibility = 'global'
            or (e.visibility = 'league'
                and e.league_id in (
                  select lm.league_id from league_memberships lm where lm.user_id = ${userId}::uuid
                ))
            or (e.visibility = 'private' and r.event_id is not null)
             )
         and (${query.leagueId}::uuid is null or e.league_id = ${query.leagueId}::uuid)
         and (${query.cursorOccurredAt?.toISOString() ?? null}::timestamptz is null
              or (e.occurred_at, e.id)
                 < (${query.cursorOccurredAt?.toISOString() ?? null}::timestamptz, ${query.cursorId}::uuid))
       order by e.occurred_at desc, e.id desc
       limit ${query.limit}
    `);
    return [...rows].map(toRow);
  }

  async countUnread(
    userId: string,
    leagueId: string | null,
    retentionFloor: Date,
  ): Promise<number> {
    // Matches `change_event_receipts_user_unread_idx`'s partial predicate exactly, and is capped
    // before counting so a large backlog cannot turn the badge into a full scan. The league
    // predicate mirrors `listVisibleEvents` so the badge counts exactly the rows that feed can show.
    const rows = await this.#database.execute<{ readonly unread: number }>(sql`
      select count(*)::int as unread from (
        select e.id
          from change_events e
          left join change_event_receipts r
                 on r.event_id = e.id and r.user_id = ${userId}::uuid
         where e.occurred_at > ${retentionFloor.toISOString()}::timestamptz
           and r.read_at is null
           and r.dismissed_at is null
           and (
                 e.visibility = 'global'
              or (e.visibility = 'league'
                  and e.league_id in (
                    select lm.league_id from league_memberships lm where lm.user_id = ${userId}::uuid
                  ))
              or (e.visibility = 'private' and r.event_id is not null)
               )
           and (${leagueId}::uuid is null or e.league_id = ${leagueId}::uuid)
         limit ${MAX_UNREAD_COUNT + 1}
      ) bounded
    `);
    return Math.min(rows[0]?.unread ?? 0, MAX_UNREAD_COUNT);
  }

  async findVisibleEvent(
    userId: string,
    eventId: string,
    retentionFloor: Date,
  ): Promise<ChangeEventRow | undefined> {
    const rows = await this.#database.execute<RawEventRow>(sql`
      select e.id, e.event_type, e.severity, e.visibility, e.league_id, e.occurred_at, e.payload,
             r.first_seen_at, r.read_at, r.dismissed_at
        from change_events e
        left join change_event_receipts r
               on r.event_id = e.id and r.user_id = ${userId}::uuid
       where e.id = ${eventId}::uuid
         and e.occurred_at > ${retentionFloor.toISOString()}::timestamptz
         and (
               e.visibility = 'global'
            or (e.visibility = 'league'
                and e.league_id in (
                  select lm.league_id from league_memberships lm where lm.user_id = ${userId}::uuid
                ))
            or (e.visibility = 'private' and r.event_id is not null)
             )
       limit 1
    `);
    const raw = rows[0];
    return raw ? toRow(raw) : undefined;
  }

  async upsertReceipt(
    userId: string,
    eventId: string,
    field: ChangeEventReceiptField,
    now: Date,
  ): Promise<Date | undefined> {
    // A raw `sql` fragment bypasses Drizzle's column-type mapping, so timestamps cross as ISO text
    // with an explicit cast rather than as a `Date` the driver cannot bind.
    const nowIso = now.toISOString();
    // `first_seen_at` is set in the *same* statement, which is what satisfies
    // `change_event_receipts_read_check` / `_dismissed_check`. The `coalesce` is what makes a repeat
    // return the original timestamps, so a second POST is a true no-op.
    const rows =
      field === "read"
        ? await this.#database.execute<{ readonly at: string | Date }>(sql`
            insert into change_event_receipts (event_id, user_id, first_seen_at, read_at, created_at)
            values (${eventId}::uuid, ${userId}::uuid, ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
            on conflict (event_id, user_id) do update
               set first_seen_at = coalesce(change_event_receipts.first_seen_at, excluded.first_seen_at),
                   read_at       = coalesce(change_event_receipts.read_at, excluded.read_at)
            returning read_at as at
          `)
        : await this.#database.execute<{ readonly at: string | Date }>(sql`
            insert into change_event_receipts (event_id, user_id, first_seen_at, dismissed_at, created_at)
            values (${eventId}::uuid, ${userId}::uuid, ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
            on conflict (event_id, user_id) do update
               set first_seen_at = coalesce(change_event_receipts.first_seen_at, excluded.first_seen_at),
                   dismissed_at  = coalesce(change_event_receipts.dismissed_at, excluded.dismissed_at)
            returning dismissed_at as at
          `);
    return toDate(rows[0]?.at ?? null) ?? undefined;
  }

  async updateReceipt(
    userId: string,
    eventId: string,
    field: ChangeEventReceiptField,
    now: Date,
  ): Promise<Date | undefined> {
    const nowIso = now.toISOString();
    // Update only. Inserting here would let a caller manufacture a receipt for a private event they
    // cannot see, which is exactly the leak the visibility predicate exists to prevent.
    const rows =
      field === "read"
        ? await this.#database.execute<{ readonly at: string | Date }>(sql`
            update change_event_receipts
               set first_seen_at = coalesce(first_seen_at, ${nowIso}::timestamptz),
                   read_at       = coalesce(read_at, ${nowIso}::timestamptz)
             where event_id = ${eventId}::uuid and user_id = ${userId}::uuid
            returning read_at as at
          `)
        : await this.#database.execute<{ readonly at: string | Date }>(sql`
            update change_event_receipts
               set first_seen_at = coalesce(first_seen_at, ${nowIso}::timestamptz),
                   dismissed_at  = coalesce(dismissed_at, ${nowIso}::timestamptz)
             where event_id = ${eventId}::uuid and user_id = ${userId}::uuid
            returning dismissed_at as at
          `);
    return toDate(rows[0]?.at ?? null) ?? undefined;
  }
}

interface RenderedEvent {
  readonly headline: string;
  readonly detail: string | null;
  readonly url: string;
}

const GENERIC_HEADLINE = "An update is available";

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function nameList(entries: readonly { readonly name: string }[]): string {
  return entries.map((entry) => entry.name).join(", ");
}

/**
 * A row whose payload the current reader cannot fully understand still renders. A future writer's
 * event must degrade, never disappear and never throw.
 */
function render(row: ChangeEventRow): RenderedEvent {
  const parsed = parseChangeEventPayload(row.eventType, row.payload);
  if (parsed.state !== "parsed") return { headline: GENERIC_HEADLINE, detail: null, url: "/app" };

  if (parsed.eventType === "league.sync.completed") {
    const { provider, season, week } = parsed.payload;
    return {
      headline: truncate(`${provider.toUpperCase()} league sync completed`, 160),
      detail: truncate(
        week === null ? `Season ${season}.` : `Season ${season}, week ${week}.`,
        400,
      ),
      url: "/app",
    };
  }
  if (parsed.eventType === "roster.changed") {
    const { teamName, added, removed, promoted, benched, moreCount } = parsed.payload;
    const moves = added.length + removed.length + promoted.length + benched.length + moreCount;
    const parts: string[] = [];
    if (added.length > 0) parts.push(`Added ${nameList(added)}.`);
    if (removed.length > 0) parts.push(`Dropped ${nameList(removed)}.`);
    if (promoted.length > 0) parts.push(`Started ${nameList(promoted)}.`);
    if (benched.length > 0) parts.push(`Benched ${nameList(benched)}.`);
    if (moreCount > 0) parts.push(`${moreCount} more.`);
    return {
      headline: truncate(
        `${teamName} changed ${moves} roster ${moves === 1 ? "spot" : "spots"}`,
        160,
      ),
      detail: parts.length > 0 ? truncate(parts.join(" "), 400) : null,
      url: "/app",
    };
  }
  if (parsed.eventType === "player.injury.changed") {
    const { playerName, teamName, week, reportStatus, practiceStatus } = parsed.payload;
    return {
      headline: truncate(
        reportStatus === null
          ? `${playerName} has a new injury report`
          : `${playerName} is ${reportStatus.toUpperCase()}`,
        160,
      ),
      detail: truncate(
        `${teamName}, week ${week}.${practiceStatus === null ? "" : ` Practice: ${practiceStatus}.`}`,
        400,
      ),
      url: "/decisions",
    };
  }
  const { teamName, kinds, week } = parsed.payload;
  return {
    headline: truncate(`Your ${kinds.join(" and ")} recommendation changed`, 160),
    detail: truncate(`${teamName}${week === null ? "" : `, week ${week}`}.`, 400),
    url: "/decisions",
  };
}

export class ChangeEventService {
  readonly #repository: ChangeEventRepository;
  readonly #now: () => Date;

  constructor(repository: ChangeEventRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  #retentionFloor(now: Date): Date {
    return new Date(now.getTime() - CHANGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  }

  async list(userId: string, query: ChangeEventFeedQuery): Promise<ChangeEventFeedResponse> {
    const now = this.#now();
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    // A forged or stale cursor is not an error — it is simply not a cursor, and the caller gets the
    // first page rather than a 400 they cannot act on. Either way it never reaches SQL.
    const cursor = query.cursor === null ? null : decodeChangeEventCursor(query.cursor);
    const retentionFloor = this.#retentionFloor(now);

    const rows = await this.#repository.listVisibleEvents(userId, {
      limit,
      leagueId: query.leagueId,
      cursorOccurredAt: cursor === null ? null : new Date(cursor.occurredAt),
      cursorId: cursor?.id ?? null,
      retentionFloor,
    });
    const unreadCount = await this.#repository.countUnread(userId, query.leagueId, retentionFloor);

    const events: ChangeEvent[] = rows.map((row) => {
      const rendered = render(row);
      return {
        id: row.id,
        eventType: row.eventType,
        severity: row.severity,
        visibility: row.visibility,
        leagueId: row.leagueId,
        occurredAt: row.occurredAt.toISOString(),
        headline: rendered.headline,
        detail: rendered.detail,
        url: rendered.url,
        state: row.readAt === null ? "unread" : "read",
        payload: row.payload,
      };
    });

    const last = rows.length === limit ? rows[rows.length - 1] : undefined;
    return {
      generatedAt: now.toISOString(),
      unreadCount,
      // Only a full page can have a next page. A short page is the end of the feed.
      nextCursor: last ? encodeChangeEventCursor(last.occurredAt.toISOString(), last.id) : null,
      events,
    };
  }

  markRead(userId: string, eventId: string): Promise<ChangeEventReceiptResponse | undefined> {
    return this.#mark(userId, eventId, "read");
  }

  dismiss(userId: string, eventId: string): Promise<ChangeEventReceiptResponse | undefined> {
    return this.#mark(userId, eventId, "dismissed");
  }

  async #mark(
    userId: string,
    eventId: string,
    field: ChangeEventReceiptField,
  ): Promise<ChangeEventReceiptResponse | undefined> {
    const now = this.#now();
    // Unknown, inaccessible, and outside-retention are one answer on purpose: distinguishing them
    // would confirm that an event the caller cannot see exists.
    const event = await this.#repository.findVisibleEvent(
      userId,
      eventId,
      this.#retentionFloor(now),
    );
    if (!event) return undefined;

    const at =
      event.visibility === "private"
        ? await this.#repository.updateReceipt(userId, eventId, field, now)
        : await this.#repository.upsertReceipt(userId, eventId, field, now);
    if (!at) return undefined;
    return { eventId, state: field, at: at.toISOString() };
  }
}
