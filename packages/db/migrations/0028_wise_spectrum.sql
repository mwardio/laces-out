CREATE TABLE "bridge_pairing_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"allowed_league_ids" jsonb NOT NULL,
	"season" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_pairing_sessions_code_hash_check" CHECK (char_length("bridge_pairing_sessions"."code_hash") >= 32),
	CONSTRAINT "bridge_pairing_sessions_device_name_check" CHECK (char_length(btrim("bridge_pairing_sessions"."device_name")) > 0),
	CONSTRAINT "bridge_pairing_sessions_leagues_check" CHECK (jsonb_typeof("bridge_pairing_sessions"."allowed_league_ids") = 'array' and jsonb_array_length("bridge_pairing_sessions"."allowed_league_ids") between 1 and 32),
	CONSTRAINT "bridge_pairing_sessions_season_check" CHECK ("bridge_pairing_sessions"."season" between 2000 and 2100),
	CONSTRAINT "bridge_pairing_sessions_expiry_check" CHECK ("bridge_pairing_sessions"."expires_at" > "bridge_pairing_sessions"."created_at"),
	CONSTRAINT "bridge_pairing_sessions_consumed_check" CHECK ("bridge_pairing_sessions"."consumed_at" is null or "bridge_pairing_sessions"."consumed_at" >= "bridge_pairing_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "bridge_pairing_sessions" ADD CONSTRAINT "bridge_pairing_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_pairing_sessions_code_hash_unique" ON "bridge_pairing_sessions" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "bridge_pairing_sessions_user_expiry_idx" ON "bridge_pairing_sessions" USING btree ("user_id","expires_at");
