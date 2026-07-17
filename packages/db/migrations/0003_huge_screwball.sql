CREATE TABLE "ai_provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"credential_fingerprint_hash" text NOT NULL,
	"provider_account_id_hash" text,
	"credential_envelope" jsonb NOT NULL,
	"envelope_version" integer NOT NULL,
	"encryption_key_id" text NOT NULL,
	"credential_purpose" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_credentials_provider_check" CHECK ("ai_provider_credentials"."provider" in ('openai', 'anthropic')),
	CONSTRAINT "ai_provider_credentials_status_check" CHECK ("ai_provider_credentials"."status" in ('active', 'invalid', 'revoked')),
	CONSTRAINT "ai_provider_credentials_fingerprint_check" CHECK (char_length("ai_provider_credentials"."credential_fingerprint_hash") >= 32),
	CONSTRAINT "ai_provider_credentials_envelope_version_check" CHECK ("ai_provider_credentials"."envelope_version" > 0),
	CONSTRAINT "ai_provider_credentials_envelope_shape_check" CHECK (jsonb_typeof("ai_provider_credentials"."credential_envelope") = 'object' and "ai_provider_credentials"."credential_envelope" ?& array['version', 'algorithm', 'keyId', 'purpose', 'createdAt', 'iv', 'ciphertext', 'authTag'] and jsonb_typeof("ai_provider_credentials"."credential_envelope"->'ciphertext') = 'string' and jsonb_typeof("ai_provider_credentials"."credential_envelope"->'authTag') = 'string'),
	CONSTRAINT "ai_provider_credentials_envelope_metadata_check" CHECK ("ai_provider_credentials"."credential_envelope"->>'version' = "ai_provider_credentials"."envelope_version"::text and "ai_provider_credentials"."credential_envelope"->>'keyId' = "ai_provider_credentials"."encryption_key_id" and "ai_provider_credentials"."credential_envelope"->>'purpose' = "ai_provider_credentials"."credential_purpose"),
	CONSTRAINT "ai_provider_credentials_revoked_at_check" CHECK (("ai_provider_credentials"."status" = 'revoked') = ("ai_provider_credentials"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ai_usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"credential_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"request_id_hash" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(16, 6) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"latency_ms" integer,
	"succeeded" boolean DEFAULT true NOT NULL,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_ledger_provider_check" CHECK ("ai_usage_ledger"."provider" in ('openai', 'anthropic')),
	CONSTRAINT "ai_usage_ledger_token_counts_check" CHECK ("ai_usage_ledger"."input_tokens" >= 0 and "ai_usage_ledger"."output_tokens" >= 0 and "ai_usage_ledger"."cache_read_tokens" >= 0 and "ai_usage_ledger"."cache_write_tokens" >= 0),
	CONSTRAINT "ai_usage_ledger_cost_check" CHECK ("ai_usage_ledger"."cost" >= 0),
	CONSTRAINT "ai_usage_ledger_latency_check" CHECK ("ai_usage_ledger"."latency_ms" is null or "ai_usage_ledger"."latency_ms" >= 0),
	CONSTRAINT "ai_usage_ledger_currency_check" CHECK ("ai_usage_ledger"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ai_usage_ledger_request_hash_check" CHECK ("ai_usage_ledger"."request_id_hash" is null or char_length("ai_usage_ledger"."request_id_hash") >= 32)
);
--> statement-breakpoint
CREATE TABLE "change_event_receipts" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"delivery_channels" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_event_receipts_event_id_user_id_pk" PRIMARY KEY("event_id","user_id"),
	CONSTRAINT "change_event_receipts_read_check" CHECK ("change_event_receipts"."read_at" is null or "change_event_receipts"."first_seen_at" is not null),
	CONSTRAINT "change_event_receipts_dismissed_check" CHECK ("change_event_receipts"."dismissed_at" is null or "change_event_receipts"."first_seen_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"deduplication_key" text,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"league_id" uuid,
	"actor_user_id" uuid,
	"visibility" text DEFAULT 'private' NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_events_visibility_check" CHECK ("change_events"."visibility" in ('private', 'league', 'global')),
	CONSTRAINT "change_events_severity_check" CHECK ("change_events"."severity" in ('info', 'action', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ranking_list_id" uuid,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"source_format" text NOT NULL,
	"source_file_name" text,
	"source_object_key" text,
	"content_hash" text,
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_accepted" integer DEFAULT 0 NOT NULL,
	"rows_rejected" integer DEFAULT 0 NOT NULL,
	"validation_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_detail" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_state_check" CHECK ("import_runs"."state" in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "import_runs_row_counts_check" CHECK ("import_runs"."rows_read" >= 0 and "import_runs"."rows_accepted" >= 0 and "import_runs"."rows_rejected" >= 0 and "import_runs"."rows_accepted" + "import_runs"."rows_rejected" <= "import_runs"."rows_read"),
	CONSTRAINT "import_runs_finished_at_check" CHECK ("import_runs"."finished_at" is null or "import_runs"."started_at" is not null),
	CONSTRAINT "import_runs_content_hash_check" CHECK ("import_runs"."content_hash" is null or char_length("import_runs"."content_hash") >= 32)
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"email_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"league_id" uuid,
	"league_role" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_check" CHECK (char_length("invitations"."token_hash") >= 32),
	CONSTRAINT "invitations_email_hash_check" CHECK (char_length("invitations"."email_hash") >= 32),
	CONSTRAINT "invitations_role_check" CHECK ("invitations"."role" in ('member', 'admin')),
	CONSTRAINT "invitations_league_role_check" CHECK ("invitations"."league_role" is null or "invitations"."league_role" in ('commissioner', 'manager', 'viewer')),
	CONSTRAINT "invitations_league_scope_check" CHECK (("invitations"."league_id" is null) = ("invitations"."league_role" is null)),
	CONSTRAINT "invitations_expiry_check" CHECK ("invitations"."expires_at" > "invitations"."created_at"),
	CONSTRAINT "invitations_acceptance_check" CHECK (("invitations"."accepted_at" is null) = ("invitations"."accepted_by_user_id" is null)),
	CONSTRAINT "invitations_terminal_state_check" CHECK (not ("invitations"."accepted_at" is not null and "invitations"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "league_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'manager' NOT NULL,
	"claimed_fantasy_team_id" uuid,
	"invited_by_user_id" uuid,
	"claimed_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_memberships_role_check" CHECK ("league_memberships"."role" in ('owner', 'commissioner', 'manager', 'viewer')),
	CONSTRAINT "league_memberships_claimed_at_check" CHECK ("league_memberships"."claimed_at" is null or "league_memberships"."claimed_fantasy_team_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "ranking_entries" (
	"ranking_list_version_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"tier" integer,
	"position_rank" text,
	"adp" numeric(9, 3),
	"aav" numeric(12, 2),
	"floor" numeric(12, 2),
	"target" numeric(12, 2),
	"ceiling" numeric(12, 2),
	"user_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ranking_entries_ranking_list_version_id_player_id_pk" PRIMARY KEY("ranking_list_version_id","player_id"),
	CONSTRAINT "ranking_entries_rank_check" CHECK ("ranking_entries"."rank" > 0),
	CONSTRAINT "ranking_entries_tier_check" CHECK ("ranking_entries"."tier" is null or "ranking_entries"."tier" > 0),
	CONSTRAINT "ranking_entries_adp_check" CHECK ("ranking_entries"."adp" is null or "ranking_entries"."adp" > 0),
	CONSTRAINT "ranking_entries_aav_check" CHECK ("ranking_entries"."aav" is null or "ranking_entries"."aav" >= 0),
	CONSTRAINT "ranking_entries_value_bounds_check" CHECK (("ranking_entries"."floor" is null or "ranking_entries"."floor" >= 0) and ("ranking_entries"."target" is null or "ranking_entries"."target" >= 0) and ("ranking_entries"."ceiling" is null or "ranking_entries"."ceiling" >= 0) and ("ranking_entries"."floor" is null or "ranking_entries"."target" is null or "ranking_entries"."floor" <= "ranking_entries"."target") and ("ranking_entries"."target" is null or "ranking_entries"."ceiling" is null or "ranking_entries"."target" <= "ranking_entries"."ceiling") and ("ranking_entries"."floor" is null or "ranking_entries"."ceiling" is null or "ranking_entries"."floor" <= "ranking_entries"."ceiling"))
);
--> statement-breakpoint
CREATE TABLE "ranking_list_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ranking_list_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid,
	"import_run_id" uuid,
	"data_as_of" timestamp with time zone,
	"published_at" timestamp with time zone,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"content_hash" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ranking_list_versions_version_check" CHECK ("ranking_list_versions"."version" > 0),
	CONSTRAINT "ranking_list_versions_entry_count_check" CHECK ("ranking_list_versions"."entry_count" >= 0),
	CONSTRAINT "ranking_list_versions_status_check" CHECK ("ranking_list_versions"."status" in ('draft', 'published', 'archived')),
	CONSTRAINT "ranking_list_versions_published_at_check" CHECK (("ranking_list_versions"."status" <> 'published' or "ranking_list_versions"."published_at" is not null) and ("ranking_list_versions"."published_at" is null or "ranking_list_versions"."status" in ('published', 'archived'))),
	CONSTRAINT "ranking_list_versions_content_hash_check" CHECK ("ranking_list_versions"."content_hash" is null or char_length("ranking_list_versions"."content_hash") >= 32)
);
--> statement-breakpoint
CREATE TABLE "ranking_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"league_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"season" integer NOT NULL,
	"scoring_format" text,
	"source_label" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ranking_lists_kind_check" CHECK ("ranking_lists"."kind" in ('rankings', 'adp', 'auction_values', 'cheat_sheet')),
	CONSTRAINT "ranking_lists_visibility_check" CHECK ("ranking_lists"."visibility" in ('private', 'league', 'unlisted', 'public')),
	CONSTRAINT "ranking_lists_league_visibility_scope_check" CHECK ("ranking_lists"."visibility" <> 'league' or "ranking_lists"."league_id" is not null),
	CONSTRAINT "ranking_lists_season_check" CHECK ("ranking_lists"."season" >= 2000 and "ranking_lists"."season" <= 2200),
	CONSTRAINT "ranking_lists_name_check" CHECK (char_length(btrim("ranking_lists"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "refresh_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"connection_id" uuid,
	"league_season_id" uuid,
	"ranking_list_id" uuid,
	"result_sync_run_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"error_detail" text,
	"result_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_requests_kind_check" CHECK ("refresh_requests"."kind" in ('player_catalog', 'rankings', 'projections', 'injuries', 'league', 'all')),
	CONSTRAINT "refresh_requests_state_check" CHECK ("refresh_requests"."state" in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "refresh_requests_priority_check" CHECK ("refresh_requests"."priority" between -100 and 100),
	CONSTRAINT "refresh_requests_scope_check" CHECK (("refresh_requests"."kind" <> 'league' or "refresh_requests"."league_season_id" is not null) and ("refresh_requests"."kind" <> 'rankings' or "refresh_requests"."ranking_list_id" is not null)),
	CONSTRAINT "refresh_requests_finished_at_check" CHECK ("refresh_requests"."finished_at" is null or "refresh_requests"."started_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"ranking_list_id" uuid,
	"league_id" uuid,
	"label" text,
	"permission" text DEFAULT 'view' NOT NULL,
	"allow_copy" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_hash_check" CHECK (char_length("share_links"."token_hash") >= 32),
	CONSTRAINT "share_links_permission_check" CHECK ("share_links"."permission" in ('view', 'copy')),
	CONSTRAINT "share_links_resource_check" CHECK (num_nonnulls("share_links"."ranking_list_id", "share_links"."league_id") = 1),
	CONSTRAINT "share_links_max_uses_check" CHECK ("share_links"."max_uses" is null or "share_links"."max_uses" > 0),
	CONSTRAINT "share_links_use_count_check" CHECK ("share_links"."use_count" >= 0 and ("share_links"."max_uses" is null or "share_links"."use_count" <= "share_links"."max_uses")),
	CONSTRAINT "share_links_expiry_check" CHECK ("share_links"."expires_at" is null or "share_links"."expires_at" > "share_links"."created_at")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"default_league_id" uuid,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"digest_cadence" text DEFAULT 'daily' NOT NULL,
	"email_notifications" boolean DEFAULT true NOT NULL,
	"dashboard_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommendation_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_theme_check" CHECK ("user_preferences"."theme" in ('system', 'light', 'dark')),
	CONSTRAINT "user_preferences_digest_check" CHECK ("user_preferences"."digest_cadence" in ('off', 'daily', 'weekly'))
);
--> statement-breakpoint
ALTER TABLE "leagues" DROP CONSTRAINT "leagues_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "leagues_user_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_credential_id_ai_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_provider_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_event_receipts" ADD CONSTRAINT "change_event_receipts_event_id_change_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."change_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_event_receipts" ADD CONSTRAINT "change_event_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_ranking_list_id_ranking_lists_id_fk" FOREIGN KEY ("ranking_list_id") REFERENCES "public"."ranking_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_claimed_fantasy_team_id_fantasy_teams_id_fk" FOREIGN KEY ("claimed_fantasy_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_ranking_list_version_id_ranking_list_versions_id_fk" FOREIGN KEY ("ranking_list_version_id") REFERENCES "public"."ranking_list_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_ranking_list_id_ranking_lists_id_fk" FOREIGN KEY ("ranking_list_id") REFERENCES "public"."ranking_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD CONSTRAINT "ranking_lists_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD CONSTRAINT "ranking_lists_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD CONSTRAINT "refresh_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD CONSTRAINT "refresh_requests_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD CONSTRAINT "refresh_requests_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD CONSTRAINT "refresh_requests_ranking_list_id_ranking_lists_id_fk" FOREIGN KEY ("ranking_list_id") REFERENCES "public"."ranking_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD CONSTRAINT "refresh_requests_result_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("result_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_ranking_list_id_ranking_lists_id_fk" FOREIGN KEY ("ranking_list_id") REFERENCES "public"."ranking_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_default_league_id_leagues_id_fk" FOREIGN KEY ("default_league_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_credentials_fingerprint_unique" ON "ai_provider_credentials" USING btree ("user_id","provider","credential_fingerprint_hash");--> statement-breakpoint
CREATE INDEX "ai_provider_credentials_user_status_idx" ON "ai_provider_credentials" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_ledger_provider_request_unique" ON "ai_usage_ledger" USING btree ("provider","request_id_hash") WHERE "ai_usage_ledger"."request_id_hash" is not null;--> statement-breakpoint
CREATE INDEX "ai_usage_ledger_user_occurred_idx" ON "ai_usage_ledger" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_usage_ledger_provider_model_occurred_idx" ON "ai_usage_ledger" USING btree ("provider","model","occurred_at");--> statement-breakpoint
CREATE INDEX "change_event_receipts_user_unread_idx" ON "change_event_receipts" USING btree ("user_id","created_at") WHERE "change_event_receipts"."read_at" is null and "change_event_receipts"."dismissed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_source_deduplication_unique" ON "change_events" USING btree ("source","deduplication_key") WHERE "change_events"."deduplication_key" is not null;--> statement-breakpoint
CREATE INDEX "change_events_league_occurred_idx" ON "change_events" USING btree ("league_id","occurred_at");--> statement-breakpoint
CREATE INDEX "change_events_aggregate_occurred_idx" ON "change_events" USING btree ("aggregate_type","aggregate_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_user_idempotency_unique" ON "import_runs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "import_runs_user_created_idx" ON "import_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "import_runs_ranking_list_idx" ON "import_runs" USING btree ("ranking_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_unique" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_pending_email_hash_idx" ON "invitations" USING btree ("email_hash","expires_at") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "invitations_inviter_created_idx" ON "invitations" USING btree ("invited_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "invitations_league_idx" ON "invitations" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "league_memberships_league_user_unique" ON "league_memberships" USING btree ("league_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "league_memberships_owner_unique" ON "league_memberships" USING btree ("league_id") WHERE "league_memberships"."role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "league_memberships_claimed_team_unique" ON "league_memberships" USING btree ("claimed_fantasy_team_id") WHERE "league_memberships"."claimed_fantasy_team_id" is not null;--> statement-breakpoint
CREATE INDEX "league_memberships_user_idx" ON "league_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "league_memberships_inviter_idx" ON "league_memberships" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX "ranking_entries_version_rank_idx" ON "ranking_entries" USING btree ("ranking_list_version_id","rank");--> statement-breakpoint
CREATE INDEX "ranking_entries_player_idx" ON "ranking_entries" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_list_versions_list_version_unique" ON "ranking_list_versions" USING btree ("ranking_list_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_list_versions_import_run_unique" ON "ranking_list_versions" USING btree ("import_run_id") WHERE "ranking_list_versions"."import_run_id" is not null;--> statement-breakpoint
CREATE INDEX "ranking_list_versions_status_idx" ON "ranking_list_versions" USING btree ("ranking_list_id","status","version");--> statement-breakpoint
CREATE INDEX "ranking_lists_owner_updated_idx" ON "ranking_lists" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ranking_lists_league_visibility_idx" ON "ranking_lists" USING btree ("league_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_requests_user_idempotency_unique" ON "refresh_requests" USING btree ("requested_by_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "refresh_requests_queue_idx" ON "refresh_requests" USING btree ("state","priority","not_before") WHERE "refresh_requests"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "refresh_requests_user_created_idx" ON "refresh_requests" USING btree ("requested_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "refresh_requests_league_season_idx" ON "refresh_requests" USING btree ("league_season_id");--> statement-breakpoint
CREATE INDEX "refresh_requests_ranking_list_idx" ON "refresh_requests" USING btree ("ranking_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_unique" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_creator_created_idx" ON "share_links" USING btree ("created_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "share_links_ranking_list_idx" ON "share_links" USING btree ("ranking_list_id");--> statement-breakpoint
CREATE INDEX "share_links_league_idx" ON "share_links" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "user_preferences_default_league_idx" ON "user_preferences" USING btree ("default_league_id");--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leagues_owner_idx" ON "leagues" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('member', 'admin'));--> statement-breakpoint

-- Preserve every existing owner as the first membership. The legacy user_id column remains
-- the ownership anchor, avoiding a destructive rewrite and making transfer transactional.
INSERT INTO "league_memberships" (
	"league_id",
	"user_id",
	"role",
	"joined_at",
	"created_at",
	"updated_at"
)
SELECT "id", "user_id", 'owner', "created_at", "created_at", "updated_at"
FROM "leagues"
ON CONFLICT ("league_id", "user_id") DO UPDATE
SET "role" = 'owner', "updated_at" = excluded."updated_at";--> statement-breakpoint

CREATE FUNCTION "enforce_league_membership_integrity"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	claimed_league_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."role" = 'owner' AND EXISTS (
			SELECT 1 FROM "leagues"
			WHERE "id" = OLD."league_id" AND "user_id" = OLD."user_id"
		) THEN
			RAISE EXCEPTION 'the canonical league owner membership cannot be deleted';
		END IF;
		RETURN OLD;
	END IF;

	IF NEW."role" = 'owner' AND NOT EXISTS (
		SELECT 1 FROM "leagues"
		WHERE "id" = NEW."league_id" AND "user_id" = NEW."user_id"
	) THEN
		RAISE EXCEPTION 'owner membership must match leagues.user_id';
	END IF;

	IF TG_OP = 'UPDATE'
		AND OLD."role" = 'owner'
		AND (NEW."role", NEW."league_id", NEW."user_id")
			IS DISTINCT FROM (OLD."role", OLD."league_id", OLD."user_id")
		AND EXISTS (
			SELECT 1 FROM "leagues"
			WHERE "id" = OLD."league_id" AND "user_id" = OLD."user_id"
		)
	THEN
		RAISE EXCEPTION 'transfer ownership through leagues.user_id';
	END IF;

	IF NEW."claimed_fantasy_team_id" IS NOT NULL THEN
		SELECT ls."league_id" INTO claimed_league_id
		FROM "fantasy_teams" ft
		JOIN "league_seasons" ls ON ls."id" = ft."league_season_id"
		WHERE ft."id" = NEW."claimed_fantasy_team_id";

		IF claimed_league_id IS DISTINCT FROM NEW."league_id" THEN
			RAISE EXCEPTION 'claimed fantasy team must belong to the membership league';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "league_memberships_integrity_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "league_memberships"
FOR EACH ROW EXECUTE FUNCTION "enforce_league_membership_integrity"();--> statement-breakpoint

CREATE FUNCTION "sync_league_owner_membership"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
		UPDATE "league_memberships"
		SET "role" = 'commissioner', "updated_at" = now()
		WHERE "league_id" = NEW."id" AND "user_id" = OLD."user_id" AND "role" = 'owner';
	END IF;

	IF TG_OP = 'INSERT' OR NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
		INSERT INTO "league_memberships" ("league_id", "user_id", "role")
		VALUES (NEW."id", NEW."user_id", 'owner')
		ON CONFLICT ("league_id", "user_id") DO UPDATE
		SET "role" = 'owner', "updated_at" = now();
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "leagues_sync_owner_membership_trigger"
AFTER INSERT OR UPDATE OF "user_id" ON "leagues"
FOR EACH ROW EXECUTE FUNCTION "sync_league_owner_membership"();--> statement-breakpoint

-- Accepted and revoked invitations cannot be returned to a usable state, and token hashes
-- themselves are immutable. Acceptance therefore remains a single conditional update.
CREATE FUNCTION "enforce_invitation_single_use"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."token_hash" IS DISTINCT FROM OLD."token_hash" THEN
		RAISE EXCEPTION 'invitation token hash is immutable';
	END IF;

	IF OLD."accepted_at" IS NOT NULL AND
		(NEW."accepted_at", NEW."accepted_by_user_id")
			IS DISTINCT FROM (OLD."accepted_at", OLD."accepted_by_user_id")
	THEN
		RAISE EXCEPTION 'accepted invitation is single-use';
	END IF;

	IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
		RAISE EXCEPTION 'revoked invitation cannot be restored';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "invitations_single_use_trigger"
BEFORE UPDATE OF "token_hash", "accepted_at", "accepted_by_user_id", "revoked_at" ON "invitations"
FOR EACH ROW EXECUTE FUNCTION "enforce_invitation_single_use"();--> statement-breakpoint

-- Event facts are immutable. The two nullable attribution FKs may only be nulled by their
-- ON DELETE actions; event contents can never be edited or deleted.
CREATE FUNCTION "enforce_change_events_append_only"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'change_events is append-only';
	END IF;

	IF (to_jsonb(NEW) - ARRAY['league_id', 'actor_user_id'])
		IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['league_id', 'actor_user_id'])
		OR (NEW."league_id" IS DISTINCT FROM OLD."league_id" AND NEW."league_id" IS NOT NULL)
		OR (NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id" AND NEW."actor_user_id" IS NOT NULL)
	THEN
		RAISE EXCEPTION 'change_events is append-only';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "change_events_append_only_trigger"
BEFORE UPDATE OR DELETE ON "change_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_change_events_append_only"();--> statement-breakpoint

-- Usage records contain counts and cost metadata only. They are immutable after insertion;
-- nullable ownership references may be cleared by FK deletion actions.
CREATE FUNCTION "enforce_ai_usage_ledger_append_only"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'ai_usage_ledger is append-only';
	END IF;

	IF (to_jsonb(NEW) - ARRAY['user_id', 'credential_id'])
		IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['user_id', 'credential_id'])
		OR (NEW."user_id" IS DISTINCT FROM OLD."user_id" AND NEW."user_id" IS NOT NULL)
		OR (NEW."credential_id" IS DISTINCT FROM OLD."credential_id" AND NEW."credential_id" IS NOT NULL)
	THEN
		RAISE EXCEPTION 'ai_usage_ledger is append-only';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "ai_usage_ledger_append_only_trigger"
BEFORE UPDATE OR DELETE ON "ai_usage_ledger"
FOR EACH ROW EXECUTE FUNCTION "enforce_ai_usage_ledger_append_only"();
