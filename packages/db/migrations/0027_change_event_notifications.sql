-- Change-event push delivery (WP5, plan IDs A6 + D9).
--
-- `notification_deliveries` is the send-once occasion ledger for outbound notifications, and its
-- `kind` was pinned to the single existing family by a check constraint. WP5 adds a second family:
-- `change-event`, one digest per member per sweep, claimed through the same ledger and dispatched by
-- the same `NotificationSender`. Widening this one check is the only DDL WP5 needs — `change_events`
-- and `change_event_receipts` were already migrated in 0003 and are unchanged here.
--
-- Forward-only and widening only: every row that satisfied the old constraint satisfies the new one,
-- no row is rewritten or dropped, and an unrecognized kind still fails closed.
--
-- `packages/db/src/schema.ts` declares the same two values on `NotificationKind` and on the check,
-- and `packages/db/scripts/schema-smoke.ts` asserts the live behavior against a real database.
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_kind_check" CHECK ("notification_deliveries"."kind" in ('lineup-lock', 'change-event'));
