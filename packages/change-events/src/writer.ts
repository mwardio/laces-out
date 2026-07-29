import {
  parseChangeEventPayload,
  type ChangeEventKind,
  type ChangeEventSeverity,
  type ChangeEventSource,
  type ChangeEventVisibility,
} from "@fantasy/contracts";
import { changeEventReceipts, changeEvents, type Database } from "@fantasy/db";
import { sql } from "drizzle-orm";

/**
 * The one writer for `change_events` and `change_event_receipts`.
 *
 * Three database facts shape everything here, and none of them is negotiable from application code:
 *
 * 1. `change_events_append_only_trigger` (migration `0003`) raises on `UPDATE` and `DELETE`. So
 *    `onConflictDoUpdate` is illegal — `ON CONFLICT DO UPDATE` issues a real `UPDATE`, the
 *    `BEFORE UPDATE` trigger fires, and the statement fails with `change_events is append-only`.
 *    Only `onConflictDoNothing` may ever appear against this table.
 * 2. `change_events_source_deduplication_unique` is **partial** — it constrains
 *    `(source, deduplication_key)` only `where deduplication_key is not null`. Drizzle must therefore
 *    be told the target *and* the predicate, or it emits a bare `ON CONFLICT DO NOTHING` that also
 *    swallows unrelated constraint violations.
 * 3. A duplicate insert returns zero rows. That is precisely why a dismissal is permanent: the emit
 *    returns nothing, no receipt is rebuilt, and the dismissed receipt survives untouched. Receipt
 *    creation is skipped entirely rather than attempted-and-ignored.
 *
 * Retention consequently cannot delete events. It is a *read window* (see
 * `apps/api/src/change-events.ts`), and deleting rows would require a forward migration that alters
 * the trigger — deliberately out of scope.
 */

export interface ChangeEventDraft {
  readonly source: ChangeEventSource;
  readonly eventType: ChangeEventKind;
  /** Never null in this package; the partial unique index only constrains non-null keys. */
  readonly deduplicationKey: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly leagueId: string | null;
  readonly actorUserId: string | null;
  readonly visibility: ChangeEventVisibility;
  readonly severity: ChangeEventSeverity;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  /** Explicit. An empty list writes the event with no receipts, which is the `global` case. */
  readonly recipientUserIds: readonly string[];
}

export interface ChangeEventEmitResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly receiptsCreated: number;
}

/** Accepts a `Database` or an open Drizzle transaction, so a producer can emit atomically. */
export type ChangeEventExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A producer bug must not be able to write an unbounded fan-out. */
export const MAX_DRAFTS_PER_EMIT = 200;
export const MAX_RECIPIENTS_PER_EVENT = 64;

export async function emitChangeEvents(
  executor: ChangeEventExecutor,
  drafts: readonly ChangeEventDraft[],
  now: Date,
): Promise<ChangeEventEmitResult> {
  if (drafts.length > MAX_DRAFTS_PER_EMIT) {
    throw new Error(`Change-event emit exceeded ${MAX_DRAFTS_PER_EMIT} drafts`);
  }

  let inserted = 0;
  let duplicates = 0;
  let receiptsCreated = 0;

  for (const draft of drafts) {
    if (draft.recipientUserIds.length > MAX_RECIPIENTS_PER_EVENT) {
      throw new Error(`Change-event emit exceeded ${MAX_RECIPIENTS_PER_EVENT} recipients`);
    }
    // A producer that writes a payload the reader cannot parse is a bug, and a silent one would be
    // invisible until a member saw a blank row weeks later. Fail loudly at the write instead.
    const validated = parseChangeEventPayload(draft.eventType, draft.payload);
    if (validated.state !== "parsed") {
      throw new Error(
        `Change-event payload for ${draft.eventType} is ${validated.state}${
          validated.state === "malformed" ? `: ${validated.issues.join("; ")}` : ""
        }`,
      );
    }

    const written = await executor
      .insert(changeEvents)
      .values({
        source: draft.source,
        deduplicationKey: draft.deduplicationKey,
        eventType: draft.eventType,
        aggregateType: draft.aggregateType,
        aggregateId: draft.aggregateId,
        leagueId: draft.leagueId,
        actorUserId: draft.actorUserId,
        visibility: draft.visibility,
        severity: draft.severity,
        // `payload` is `not null`; an empty payload is written as `{}` and never omitted.
        payload: draft.payload,
        // Always the draft's own time. `now` is the receipt clock, never the event clock.
        occurredAt: draft.occurredAt,
        createdAt: now,
      })
      .onConflictDoNothing({
        // `where` here is the *index predicate*, which is how PostgreSQL infers a partial unique
        // index as the arbiter. Omitting it raises `42P10: there is no unique or exclusion
        // constraint matching the ON CONFLICT specification`.
        target: [changeEvents.source, changeEvents.deduplicationKey],
        where: sql`${changeEvents.deduplicationKey} is not null`,
      })
      .returning({ id: changeEvents.id });

    const event = written[0];
    if (!event) {
      // Already emitted. No receipts, which is what keeps a dismissal permanent.
      duplicates += 1;
      continue;
    }
    inserted += 1;
    if (draft.recipientUserIds.length === 0) continue;

    const receipts = await executor
      .insert(changeEventReceipts)
      .values(
        draft.recipientUserIds.map((userId) => ({
          eventId: event.id,
          userId,
          createdAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ eventId: changeEventReceipts.eventId });
    receiptsCreated += receipts.length;
  }

  return { inserted, duplicates, receiptsCreated };
}
