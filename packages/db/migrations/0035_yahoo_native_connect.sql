-- Native Yahoo setup reuses the existing state and browser-handoff tables. Completion mode is a
-- closed value stored beside the state owner and expiry; existing in-flight states stay browser
-- flows. The handoff destination remains allowlisted in PostgreSQL as well as in the API contract.

ALTER TABLE "oauth_states" ADD COLUMN "return_mode" text DEFAULT 'browser' NOT NULL;
--> statement-breakpoint
ALTER TABLE "oauth_states"
	ADD CONSTRAINT "oauth_states_return_mode_check"
	CHECK ("oauth_states"."return_mode" in ('browser', 'ios-app'));
--> statement-breakpoint
ALTER TABLE "browser_handoff_tokens"
	DROP CONSTRAINT "browser_handoff_tokens_destination_check";
--> statement-breakpoint
ALTER TABLE "browser_handoff_tokens"
	ADD CONSTRAINT "browser_handoff_tokens_destination_check"
	CHECK ("browser_handoff_tokens"."destination" in ('/app', '/analytics', '/connections', '/connections/yahoo/connect', '/decisions', '/draft', '/film-room', '/rankings', '/projections', '/schedule', '/settings', '/stats', '/admin/members'));
