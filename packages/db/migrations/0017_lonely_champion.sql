CREATE TABLE "first_party_ros_champion_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season" integer NOT NULL,
	"scoring_profile_key" text NOT NULL,
	"model_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"calibration_version" text NOT NULL,
	"evidence_through_season" integer NOT NULL,
	"source_checksums" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"release_gate" jsonb NOT NULL,
	"artifact_checksum" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "first_party_ros_champion_artifacts_season_check" CHECK ("first_party_ros_champion_artifacts"."season" between 2000 and 2200 and "first_party_ros_champion_artifacts"."evidence_through_season" between 1999 and "first_party_ros_champion_artifacts"."season"),
	CONSTRAINT "first_party_ros_champion_artifacts_identity_check" CHECK (char_length(btrim("first_party_ros_champion_artifacts"."scoring_profile_key")) between 1 and 256 and char_length(btrim("first_party_ros_champion_artifacts"."model_version")) between 1 and 128 and char_length(btrim("first_party_ros_champion_artifacts"."policy_version")) between 1 and 128 and char_length(btrim("first_party_ros_champion_artifacts"."calibration_version")) between 1 and 128),
	CONSTRAINT "first_party_ros_champion_artifacts_checksum_check" CHECK ("first_party_ros_champion_artifacts"."artifact_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "first_party_ros_champion_artifacts_payload_check" CHECK (jsonb_typeof("first_party_ros_champion_artifacts"."source_checksums") = 'array' and jsonb_array_length("first_party_ros_champion_artifacts"."source_checksums") > 0 and jsonb_typeof("first_party_ros_champion_artifacts"."policy") = 'object' and jsonb_typeof("first_party_ros_champion_artifacts"."release_gate") = 'object'),
	CONSTRAINT "first_party_ros_champion_artifacts_admitted_check" CHECK ("first_party_ros_champion_artifacts"."admitted_at" >= '2000-01-01'::timestamptz)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "first_party_ros_champion_artifacts_identity_unique" ON "first_party_ros_champion_artifacts" USING btree ("season","scoring_profile_key","model_version","policy_version","calibration_version","artifact_checksum");--> statement-breakpoint
CREATE INDEX "first_party_ros_champion_artifacts_lookup_idx" ON "first_party_ros_champion_artifacts" USING btree ("season","scoring_profile_key","admitted_at");--> statement-breakpoint
CREATE FUNCTION "enforce_first_party_ros_champion_artifact_retention"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'first_party_ros_champion_artifacts is append-only and immutable';
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "first_party_ros_champion_artifacts_append_only_trigger"
BEFORE UPDATE OR DELETE ON "first_party_ros_champion_artifacts"
FOR EACH ROW EXECUTE FUNCTION "enforce_first_party_ros_champion_artifact_retention"();
