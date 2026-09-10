CREATE TABLE "decision_inbox_receipts" (
	"user_id" uuid NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"membership_id" uuid NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_inbox_receipts_user_id_league_id_team_id_item_id_pk" PRIMARY KEY("user_id","league_id","team_id","item_id"),
	CONSTRAINT "decision_inbox_receipts_state_check" CHECK ("decision_inbox_receipts"."state" in ('open', 'reviewed', 'dismissed')),
	CONSTRAINT "decision_inbox_receipts_item_id_check" CHECK ("decision_inbox_receipts"."item_id" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "decision_inbox_receipts" ADD CONSTRAINT "decision_inbox_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_inbox_receipts" ADD CONSTRAINT "decision_inbox_receipts_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_inbox_receipts" ADD CONSTRAINT "decision_inbox_receipts_team_id_fantasy_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_inbox_receipts" ADD CONSTRAINT "decision_inbox_receipts_membership_id_league_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."league_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_inbox_receipts_membership_idx" ON "decision_inbox_receipts" USING btree ("membership_id");