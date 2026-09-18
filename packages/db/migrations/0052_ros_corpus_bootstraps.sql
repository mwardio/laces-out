CREATE TABLE "first_party_ros_corpus_bootstraps" (
	"request_identity" text PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"protocol" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"corpus_identity" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"dispatch_reservation_id" uuid,
	"dispatch_claimed_at" timestamp with time zone,
	"job_id" uuid,
	"reason_code" text,
	"diagnostic" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_snapshot_id" uuid,
	"source_snapshot_state" text,
	"source_snapshot_created_at" timestamp with time zone,
	"source_snapshot_qualified_at" timestamp with time zone,
	CONSTRAINT "ros_corpus_bootstraps_identity_check" CHECK ("first_party_ros_corpus_bootstraps"."request_identity" ~ '^[a-f0-9]{64}$' and "first_party_ros_corpus_bootstraps"."season" between 2007 and 2200 and ("first_party_ros_corpus_bootstraps"."corpus_identity" is null or "first_party_ros_corpus_bootstraps"."corpus_identity" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "ros_corpus_bootstraps_state_check" CHECK ("first_party_ros_corpus_bootstraps"."state" in ('pending', 'building', 'ready', 'retry-wait', 'waiting-source', 'blocked-integrity') and "first_party_ros_corpus_bootstraps"."attempt" between 0 and 2147483647 and ("first_party_ros_corpus_bootstraps"."state" <> 'ready' or ("first_party_ros_corpus_bootstraps"."corpus_identity" is not null and "first_party_ros_corpus_bootstraps"."verified_at" is not null))),
	CONSTRAINT "ros_corpus_bootstraps_payload_check" CHECK (jsonb_typeof("first_party_ros_corpus_bootstraps"."protocol") = 'object' and jsonb_typeof("first_party_ros_corpus_bootstraps"."diagnostic") = 'object' and octet_length("first_party_ros_corpus_bootstraps"."diagnostic"::text) <= 16384 and ("first_party_ros_corpus_bootstraps"."reason_code" is null or char_length("first_party_ros_corpus_bootstraps"."reason_code") between 1 and 128)),
	CONSTRAINT "ros_corpus_bootstraps_dates_check" CHECK (isfinite("first_party_ros_corpus_bootstraps"."requested_at") and "first_party_ros_corpus_bootstraps"."requested_at" >= '2000-01-01'::timestamptz and isfinite("first_party_ros_corpus_bootstraps"."updated_at") and "first_party_ros_corpus_bootstraps"."updated_at" >= '2000-01-01'::timestamptz and ("first_party_ros_corpus_bootstraps"."started_at" is null or (isfinite("first_party_ros_corpus_bootstraps"."started_at") and "first_party_ros_corpus_bootstraps"."started_at" >= '2000-01-01'::timestamptz)) and ("first_party_ros_corpus_bootstraps"."completed_at" is null or (isfinite("first_party_ros_corpus_bootstraps"."completed_at") and "first_party_ros_corpus_bootstraps"."completed_at" >= '2000-01-01'::timestamptz)) and ("first_party_ros_corpus_bootstraps"."next_attempt_at" is null or (isfinite("first_party_ros_corpus_bootstraps"."next_attempt_at") and "first_party_ros_corpus_bootstraps"."next_attempt_at" >= '2000-01-01'::timestamptz)) and ("first_party_ros_corpus_bootstraps"."verified_at" is null or (isfinite("first_party_ros_corpus_bootstraps"."verified_at") and "first_party_ros_corpus_bootstraps"."verified_at" >= '2000-01-01'::timestamptz)) and ("first_party_ros_corpus_bootstraps"."dispatch_claimed_at" is null or (isfinite("first_party_ros_corpus_bootstraps"."dispatch_claimed_at") and "first_party_ros_corpus_bootstraps"."dispatch_claimed_at" >= '2000-01-01'::timestamptz)) and ("first_party_ros_corpus_bootstraps"."source_snapshot_created_at" is null or (isfinite("first_party_ros_corpus_bootstraps"."source_snapshot_created_at") and "first_party_ros_corpus_bootstraps"."source_snapshot_created_at" >= '2000-01-01'::timestamptz)) and ("first_party_ros_corpus_bootstraps"."source_snapshot_qualified_at" is null or (isfinite("first_party_ros_corpus_bootstraps"."source_snapshot_qualified_at") and "first_party_ros_corpus_bootstraps"."source_snapshot_qualified_at" >= '2000-01-01'::timestamptz))),
	CONSTRAINT "ros_corpus_bootstraps_snapshot_check" CHECK ((("first_party_ros_corpus_bootstraps"."source_snapshot_id" is null and "first_party_ros_corpus_bootstraps"."source_snapshot_state" is null and "first_party_ros_corpus_bootstraps"."source_snapshot_created_at" is null and "first_party_ros_corpus_bootstraps"."source_snapshot_qualified_at" is null) or ("first_party_ros_corpus_bootstraps"."source_snapshot_id" is not null and "first_party_ros_corpus_bootstraps"."source_snapshot_state" is not null and "first_party_ros_corpus_bootstraps"."source_snapshot_state" in ('capturing', 'qualified', 'unqualified') and "first_party_ros_corpus_bootstraps"."source_snapshot_created_at" is not null and ("first_party_ros_corpus_bootstraps"."source_snapshot_state" <> 'qualified' or "first_party_ros_corpus_bootstraps"."source_snapshot_qualified_at" is not null))))
);
--> statement-breakpoint
CREATE INDEX "ros_corpus_bootstraps_state_retry_idx" ON "first_party_ros_corpus_bootstraps" USING btree ("state","next_attempt_at");
--> statement-breakpoint
-- The ledger must retain evidence that a corpus was once ready, even after storage loss.
CREATE FUNCTION "protect_ros_corpus_bootstrap_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_identity IS DISTINCT FROM OLD.request_identity
     OR NEW.season IS DISTINCT FROM OLD.season
     OR NEW.protocol IS DISTINCT FROM OLD.protocol THEN
    RAISE EXCEPTION 'ROS bootstrap physical request is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.corpus_identity IS NOT NULL
     AND NEW.corpus_identity IS DISTINCT FROM OLD.corpus_identity THEN
    RAISE EXCEPTION 'ROS bootstrap committed corpus identity must be retained' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ros_corpus_bootstrap_identity_guard"
BEFORE UPDATE ON "first_party_ros_corpus_bootstraps"
FOR EACH ROW EXECUTE FUNCTION "protect_ros_corpus_bootstrap_identity"();
