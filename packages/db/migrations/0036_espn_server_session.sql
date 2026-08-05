-- Opt-in unattended ESPN reads use the existing encrypted provider-connection boundary. The only
-- stored provenance change needed here is a distinct fulfillment mode, so operators and members
-- can tell a credential-free direct read from an authorized server-session read.

ALTER TABLE "bridge_devices" ADD COLUMN "connection_id" uuid;
--> statement-breakpoint
ALTER TABLE "bridge_devices"
  ADD CONSTRAINT "bridge_devices_connection_id_provider_connections_id_fk"
  FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "bridge_devices_connection_idx" ON "bridge_devices" USING btree ("connection_id");
--> statement-breakpoint

ALTER TABLE "refresh_requests"
  DROP CONSTRAINT "refresh_requests_fulfillment_mode_check";
--> statement-breakpoint
ALTER TABLE "refresh_requests"
  ADD CONSTRAINT "refresh_requests_fulfillment_mode_check"
  CHECK ("fulfillment_mode" IS NULL OR "fulfillment_mode" in ('server-direct', 'server-session', 'chrome-agent', 'native-agent'));
--> statement-breakpoint
ALTER TABLE "espn_refresh_attempts"
  DROP CONSTRAINT "espn_refresh_attempts_mode_check";
--> statement-breakpoint
ALTER TABLE "espn_refresh_attempts"
  ADD CONSTRAINT "espn_refresh_attempts_mode_check"
  CHECK ("mode" in ('server-direct', 'server-session', 'chrome-agent', 'native-agent'));
--> statement-breakpoint
ALTER TABLE "espn_refresh_attempts"
  DROP CONSTRAINT "espn_refresh_attempts_provenance_check";
--> statement-breakpoint
ALTER TABLE "espn_refresh_attempts"
  ADD CONSTRAINT "espn_refresh_attempts_provenance_check"
  CHECK (("mode" in ('server-direct', 'server-session') AND "bridge_device_id" IS NULL) OR ("mode" in ('chrome-agent', 'native-agent') AND "bridge_device_id" IS NOT NULL));
