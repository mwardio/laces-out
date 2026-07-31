-- One-time native-to-browser sign-in handoffs. Only SHA-256 token digests reach PostgreSQL.
-- Exact destination checks make an open redirect impossible even if an application validation
-- layer regresses. Rows are short-lived and disappear with their owning account.

CREATE TABLE "browser_handoff_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"destination" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"staged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_handoff_tokens_hash_check"
		CHECK ("browser_handoff_tokens"."token_hash" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "browser_handoff_tokens_destination_check"
		CHECK ("browser_handoff_tokens"."destination" in ('/app', '/analytics', '/connections', '/decisions', '/draft', '/film-room', '/rankings', '/projections', '/schedule', '/settings', '/stats', '/admin/members')),
	CONSTRAINT "browser_handoff_tokens_lifetime_check"
		CHECK ("browser_handoff_tokens"."expires_at" > "browser_handoff_tokens"."created_at" and "browser_handoff_tokens"."expires_at" <= "browser_handoff_tokens"."created_at" + interval '5 minutes'),
	CONSTRAINT "browser_handoff_tokens_staged_check"
		CHECK ("browser_handoff_tokens"."staged_at" is null or ("browser_handoff_tokens"."staged_at" >= "browser_handoff_tokens"."created_at" and "browser_handoff_tokens"."staged_at" < "browser_handoff_tokens"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "browser_handoff_tokens"
	ADD CONSTRAINT "browser_handoff_tokens_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoff_tokens_token_hash_unique"
	ON "browser_handoff_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoff_tokens_user_unique"
	ON "browser_handoff_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "browser_handoff_tokens_expires_idx"
	ON "browser_handoff_tokens" USING btree ("expires_at");
