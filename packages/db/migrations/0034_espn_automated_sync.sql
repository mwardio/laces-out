ALTER TABLE "bridge_devices" ADD COLUMN "client_kind" text DEFAULT 'chrome-extension' NOT NULL;
--> statement-breakpoint
ALTER TABLE "bridge_devices" ADD COLUMN "agent_capable" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "league_supplemental_artifact_unique";
--> statement-breakpoint
CREATE INDEX "league_supplemental_artifact_lookup_idx"
  ON "league_supplemental_snapshots" USING btree ("league_season_id", "kind", "availability", "effective_at", "artifact_checksum");
--> statement-breakpoint
-- Existing automatic companions retain their credential when the extension updates and starts
-- polling. The web-created one-click credential has always used this fixed label and cannot poll.
UPDATE "bridge_devices"
SET "agent_capable" = true
WHERE "name" <> 'One-click ESPN sync';
--> statement-breakpoint
ALTER TABLE "bridge_devices"
  ADD CONSTRAINT "bridge_devices_client_kind_check"
  CHECK ("bridge_devices"."client_kind" in ('chrome-extension', 'ios-app'));
--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD COLUMN "minimum_capture_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD COLUMN "required_artifacts" jsonb;
--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD COLUMN "fulfillment_mode" text;
--> statement-breakpoint
ALTER TABLE "refresh_requests" ADD COLUMN "fulfilled_by_bridge_device_id" uuid;
--> statement-breakpoint
UPDATE "refresh_requests"
SET
  "expires_at" = COALESCE("expires_at", "created_at" + interval '24 hours'),
  "minimum_capture_at" = COALESCE("minimum_capture_at", "created_at"),
  "required_artifacts" = COALESCE("required_artifacts", '["core"]'::jsonb)
WHERE "kind" = 'league';
--> statement-breakpoint
WITH duplicate_live AS (
  SELECT "id",
    row_number() OVER (
      PARTITION BY "league_season_id"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS ordinal
  FROM "refresh_requests"
  WHERE "kind" = 'league'
    AND "state" in ('queued', 'processing')
)
UPDATE "refresh_requests" AS request
SET
  "state" = 'cancelled',
  "started_at" = COALESCE(request."started_at", request."created_at"),
  "finished_at" = COALESCE(request."finished_at", now()),
  "error_code" = 'COALESCED_BY_MIGRATION',
  "error_detail" = 'Superseded while enforcing one live league refresh request.'
FROM duplicate_live
WHERE request."id" = duplicate_live."id"
  AND duplicate_live.ordinal > 1;
--> statement-breakpoint
ALTER TABLE "refresh_requests" DROP CONSTRAINT "refresh_requests_scope_check";
--> statement-breakpoint
ALTER TABLE "refresh_requests" DROP CONSTRAINT "refresh_requests_league_season_id_league_seasons_id_fk";
--> statement-breakpoint
ALTER TABLE "refresh_requests"
  ADD CONSTRAINT "refresh_requests_league_season_id_league_seasons_id_fk"
  FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refresh_requests"
  ADD CONSTRAINT "refresh_requests_scope_check"
  CHECK (("kind" <> 'league' OR ("league_season_id" IS NOT NULL AND "expires_at" IS NOT NULL AND "minimum_capture_at" IS NOT NULL AND "required_artifacts" IS NOT NULL)) AND ("kind" <> 'rankings' OR "ranking_list_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "refresh_requests"
  ADD CONSTRAINT "refresh_requests_expiry_check"
  CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");
--> statement-breakpoint
ALTER TABLE "refresh_requests"
  ADD CONSTRAINT "refresh_requests_artifacts_check"
  CHECK ("required_artifacts" IS NULL OR (jsonb_typeof("required_artifacts") = 'array' AND jsonb_array_length("required_artifacts") BETWEEN 1 AND 5 AND "required_artifacts" <@ '["core", "available-players", "weekly-box-scores", "transactions", "completed-draft"]'::jsonb));
--> statement-breakpoint
ALTER TABLE "refresh_requests"
  ADD CONSTRAINT "refresh_requests_fulfillment_mode_check"
  CHECK ("fulfillment_mode" IS NULL OR "fulfillment_mode" in ('server-direct', 'chrome-agent', 'native-agent'));
--> statement-breakpoint
ALTER TABLE "refresh_requests"
  ADD CONSTRAINT "refresh_requests_fulfilled_by_bridge_device_id_bridge_devices_id_fk"
  FOREIGN KEY ("fulfilled_by_bridge_device_id") REFERENCES "public"."bridge_devices"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_requests_live_league_unique"
  ON "refresh_requests" USING btree ("league_season_id")
  WHERE "kind" = 'league' AND "state" in ('queued', 'processing');
--> statement-breakpoint
CREATE TABLE "espn_league_sync_states" (
  "league_season_id" uuid PRIMARY KEY NOT NULL,
  "direct_core_state" text DEFAULT 'unknown' NOT NULL,
  "supplemental_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "artifact_freshness" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_probe_at" timestamp with time zone,
  "next_probe_at" timestamp with time zone,
  "last_direct_success_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_at" timestamp with time zone,
  "last_error_detail" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "circuit_open_until" timestamp with time zone,
  "preferred_mode" text DEFAULT 'automatic' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "espn_league_sync_states_direct_core_check" CHECK ("direct_core_state" in ('unknown', 'available', 'not-public', 'degraded', 'disabled')),
  CONSTRAINT "espn_league_sync_states_capability_shape_check" CHECK (jsonb_typeof("supplemental_capabilities") = 'object' AND jsonb_typeof("artifact_freshness") = 'object'),
  CONSTRAINT "espn_league_sync_states_preferred_mode_check" CHECK ("preferred_mode" in ('direct', 'assisted', 'automatic')),
  CONSTRAINT "espn_league_sync_states_failure_count_check" CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "espn_league_sync_states_error_bounds_check" CHECK (("last_error_code" IS NULL OR char_length("last_error_code") <= 64) AND ("last_error_detail" IS NULL OR char_length("last_error_detail") <= 500))
);
--> statement-breakpoint
ALTER TABLE "espn_league_sync_states"
  ADD CONSTRAINT "espn_league_sync_states_league_season_id_league_seasons_id_fk"
  FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "espn_league_sync_states_due_idx"
  ON "espn_league_sync_states" USING btree ("next_probe_at", "circuit_open_until");
--> statement-breakpoint
INSERT INTO "espn_league_sync_states" ("league_season_id", "artifact_freshness", "next_probe_at")
SELECT
  season."id",
  CASE
    WHEN season."last_synced_at" IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('core', season."last_synced_at")
  END,
  now()
FROM "league_seasons" AS season
WHERE season."provider" = 'espn'
ON CONFLICT ("league_season_id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE "espn_refresh_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "refresh_request_id" uuid NOT NULL,
  "mode" text NOT NULL,
  "bridge_device_id" uuid,
  "state" text NOT NULL,
  "error_code" text,
  "error_detail" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "espn_refresh_attempts_mode_check" CHECK ("mode" in ('server-direct', 'chrome-agent', 'native-agent')),
  CONSTRAINT "espn_refresh_attempts_state_check" CHECK ("state" in ('offered', 'started', 'accepted', 'unchanged', 'login-required', 'not-public', 'retryable-error', 'rejected')),
  CONSTRAINT "espn_refresh_attempts_error_bounds_check" CHECK (("error_code" IS NULL OR char_length("error_code") <= 64) AND ("error_detail" IS NULL OR char_length("error_detail") <= 500)),
  CONSTRAINT "espn_refresh_attempts_provenance_check" CHECK (("mode" = 'server-direct' AND "bridge_device_id" IS NULL) OR ("mode" in ('chrome-agent', 'native-agent') AND "bridge_device_id" IS NOT NULL)),
  CONSTRAINT "espn_refresh_attempts_lifecycle_check" CHECK ((("state" in ('offered', 'started')) = ("finished_at" IS NULL)) AND ("finished_at" IS NULL OR "finished_at" >= "started_at") AND ("state" not in ('login-required', 'not-public', 'retryable-error', 'rejected') OR "error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "espn_refresh_attempts"
  ADD CONSTRAINT "espn_refresh_attempts_refresh_request_id_refresh_requests_id_fk"
  FOREIGN KEY ("refresh_request_id") REFERENCES "public"."refresh_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "espn_refresh_attempts"
  ADD CONSTRAINT "espn_refresh_attempts_bridge_device_id_bridge_devices_id_fk"
  FOREIGN KEY ("bridge_device_id") REFERENCES "public"."bridge_devices"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "espn_refresh_attempts_request_idx"
  ON "espn_refresh_attempts" USING btree ("refresh_request_id", "started_at");
--> statement-breakpoint
CREATE INDEX "espn_refresh_attempts_device_idx"
  ON "espn_refresh_attempts" USING btree ("bridge_device_id", "started_at");
