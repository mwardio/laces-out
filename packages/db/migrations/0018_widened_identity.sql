-- The scoring-profile key is the full canonical scoring-rules JSON (roughly 1-4 KiB for real
-- leagues), not a short identifier. The 0017 identity check capped it at 256 characters, which
-- rejected the first real champion-artifact admission. Widen only that bound; version-string
-- bounds are unchanged.
ALTER TABLE "first_party_ros_champion_artifacts" DROP CONSTRAINT "first_party_ros_champion_artifacts_identity_check";--> statement-breakpoint
ALTER TABLE "first_party_ros_champion_artifacts" ADD CONSTRAINT "first_party_ros_champion_artifacts_identity_check" CHECK (char_length(btrim("first_party_ros_champion_artifacts"."scoring_profile_key")) between 1 and 8192 and char_length(btrim("first_party_ros_champion_artifacts"."model_version")) between 1 and 128 and char_length(btrim("first_party_ros_champion_artifacts"."policy_version")) between 1 and 128 and char_length(btrim("first_party_ros_champion_artifacts"."calibration_version")) between 1 and 128);
