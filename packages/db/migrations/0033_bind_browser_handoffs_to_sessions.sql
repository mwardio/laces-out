-- Existing handoffs are deliberately invalidated: they predate source-session binding and cannot
-- safely be upgraded by guessing which of a user's sessions authenticated their creation.
ALTER TABLE "browser_handoff_tokens" ADD COLUMN "source_session_id" uuid;
--> statement-breakpoint
ALTER TABLE "browser_handoff_tokens" ADD COLUMN "confirmed_at" timestamp with time zone;
--> statement-breakpoint
DELETE FROM "browser_handoff_tokens";
--> statement-breakpoint
ALTER TABLE "browser_handoff_tokens" ALTER COLUMN "source_session_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "browser_handoff_tokens"
	ADD CONSTRAINT "browser_handoff_tokens_source_session_id_sessions_id_fk"
	FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "browser_handoff_tokens"
	ADD CONSTRAINT "browser_handoff_tokens_confirmed_check"
	CHECK ("browser_handoff_tokens"."confirmed_at" is null or ("browser_handoff_tokens"."staged_at" is not null and "browser_handoff_tokens"."confirmed_at" >= "browser_handoff_tokens"."staged_at" and "browser_handoff_tokens"."confirmed_at" < "browser_handoff_tokens"."expires_at"));
--> statement-breakpoint
CREATE INDEX "browser_handoff_tokens_source_session_idx"
	ON "browser_handoff_tokens" USING btree ("source_session_id");
