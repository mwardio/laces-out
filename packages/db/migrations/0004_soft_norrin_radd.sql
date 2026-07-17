CREATE TABLE "bridge_device_leagues" (
	"bridge_device_id" uuid NOT NULL,
	"league_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_device_leagues_bridge_device_id_league_id_pk" PRIMARY KEY("bridge_device_id","league_id")
);
--> statement-breakpoint
CREATE TABLE "bridge_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'espn' NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_devices_provider_check" CHECK ("bridge_devices"."provider" = 'espn'),
	CONSTRAINT "bridge_devices_name_check" CHECK (char_length(btrim("bridge_devices"."name")) > 0),
	CONSTRAINT "bridge_devices_token_hash_check" CHECK (char_length("bridge_devices"."token_hash") >= 32),
	CONSTRAINT "bridge_devices_expiry_check" CHECK ("bridge_devices"."expires_at" is null or "bridge_devices"."expires_at" > "bridge_devices"."created_at"),
	CONSTRAINT "bridge_devices_last_seen_check" CHECK ("bridge_devices"."last_seen_at" is null or "bridge_devices"."last_seen_at" >= "bridge_devices"."created_at")
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source_url" text,
	"attribution" text,
	"attribution_url" text,
	"check_interval_minutes" integer DEFAULT 1440 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"etag" text,
	"last_modified" text,
	"last_checksum" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_detail" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_sources_key_check" CHECK ("data_sources"."key" ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
	CONSTRAINT "data_sources_name_check" CHECK (char_length(btrim("data_sources"."name")) > 0),
	CONSTRAINT "data_sources_kind_check" CHECK (char_length(btrim("data_sources"."kind")) > 0),
	CONSTRAINT "data_sources_interval_check" CHECK ("data_sources"."check_interval_minutes" between 15 and 10080),
	CONSTRAINT "data_sources_failures_check" CHECK ("data_sources"."consecutive_failures" >= 0),
	CONSTRAINT "data_sources_checksum_check" CHECK ("data_sources"."last_checksum" is null or char_length("data_sources"."last_checksum") >= 32),
	CONSTRAINT "data_sources_changed_at_check" CHECK ("data_sources"."last_changed_at" is null or ("data_sources"."last_checked_at" is not null and "data_sources"."last_changed_at" <= "data_sources"."last_checked_at")),
	CONSTRAINT "data_sources_success_at_check" CHECK ("data_sources"."last_successful_at" is null or ("data_sources"."last_checked_at" is not null and "data_sources"."last_successful_at" <= "data_sources"."last_checked_at")),
	CONSTRAINT "data_sources_error_state_check" CHECK ("data_sources"."last_error_at" is not null or ("data_sources"."last_error_code" is null and "data_sources"."last_error_detail" is null))
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "credential_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD COLUMN "data_source_id" uuid;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD CONSTRAINT "bridge_device_leagues_bridge_device_id_bridge_devices_id_fk" FOREIGN KEY ("bridge_device_id") REFERENCES "public"."bridge_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD CONSTRAINT "bridge_device_leagues_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_devices" ADD CONSTRAINT "bridge_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_device_leagues_league_idx" ON "bridge_device_leagues" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_devices_token_hash_unique" ON "bridge_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "bridge_devices_user_active_idx" ON "bridge_devices" USING btree ("user_id","created_at") WHERE "bridge_devices"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "data_sources_key_unique" ON "data_sources" USING btree ("key");--> statement-breakpoint
CREATE INDEX "data_sources_due_idx" ON "data_sources" USING btree ("next_check_at") WHERE "data_sources"."enabled" = true;--> statement-breakpoint
CREATE INDEX "data_sources_kind_idx" ON "data_sources" USING btree ("kind");--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD CONSTRAINT "refresh_requests_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_requests_data_source_idx" ON "refresh_requests" USING btree ("data_source_id");--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_credential_version_check" CHECK ("provider_connections"."credential_version" > 0);