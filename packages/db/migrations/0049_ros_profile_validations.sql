CREATE TABLE "first_party_ros_profile_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season" integer NOT NULL,
	"model_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"calibration_version" text NOT NULL,
	"scoring_profile_key" text NOT NULL,
	"scoring_profile_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb,
	"artifact_id" uuid,
	"publication_scope_digest" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "first_party_ros_profile_validations_identity_check" CHECK ("first_party_ros_profile_validations"."season" between 2000 and 2200 and char_length("first_party_ros_profile_validations"."scoring_profile_key") between 1 and 8192 and "first_party_ros_profile_validations"."scoring_profile_digest" ~ '^[a-f0-9]{64}$' and char_length("first_party_ros_profile_validations"."model_version") between 1 and 128 and char_length("first_party_ros_profile_validations"."policy_version") between 1 and 128 and char_length("first_party_ros_profile_validations"."calibration_version") between 1 and 128),
	CONSTRAINT "first_party_ros_profile_validations_state_check" CHECK ("first_party_ros_profile_validations"."state" in ('pending', 'validating', 'admitted', 'withheld', 'failed') and ("first_party_ros_profile_validations"."state" <> 'admitted' or "first_party_ros_profile_validations"."artifact_id" is not null)),
	CONSTRAINT "first_party_ros_profile_validations_payload_check" CHECK (jsonb_typeof("first_party_ros_profile_validations"."blockers") = 'array' and ("first_party_ros_profile_validations"."report" is null or jsonb_typeof("first_party_ros_profile_validations"."report") = 'object') and ("first_party_ros_profile_validations"."publication_scope_digest" is null or "first_party_ros_profile_validations"."publication_scope_digest" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "first_party_ros_profile_validations" ADD CONSTRAINT "first_party_ros_profile_validations_artifact_id_first_party_ros_champion_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."first_party_ros_champion_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "first_party_ros_profile_validations_identity_unique" ON "first_party_ros_profile_validations" USING btree ("season","model_version","policy_version","calibration_version","scoring_profile_digest");--> statement-breakpoint
CREATE INDEX "first_party_ros_profile_validations_state_idx" ON "first_party_ros_profile_validations" USING btree ("state","requested_at");