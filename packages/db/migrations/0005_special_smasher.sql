ALTER TABLE "import_runs" DROP CONSTRAINT "import_runs_content_hash_check";--> statement-breakpoint
ALTER TABLE "ranking_entries" DROP CONSTRAINT "ranking_entries_rank_check";--> statement-breakpoint
ALTER TABLE "ranking_list_versions" DROP CONSTRAINT "ranking_list_versions_status_check";--> statement-breakpoint
ALTER TABLE "ranking_list_versions" DROP CONSTRAINT "ranking_list_versions_published_at_check";--> statement-breakpoint
ALTER TABLE "ranking_list_versions" DROP CONSTRAINT "ranking_list_versions_content_hash_check";--> statement-breakpoint
ALTER TABLE "ranking_lists" DROP CONSTRAINT "ranking_lists_league_visibility_scope_check";--> statement-breakpoint
ALTER TABLE "ranking_lists" DROP CONSTRAINT "ranking_lists_kind_check";--> statement-breakpoint
ALTER TABLE "ranking_lists" DROP CONSTRAINT "ranking_lists_visibility_check";--> statement-breakpoint
ALTER TABLE "ranking_entries" ALTER COLUMN "rank" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "position" text;--> statement-breakpoint
UPDATE "ranking_entries"
SET "position" = upper(substring("position_rank" from '^([A-Za-z]+)'))
WHERE "position_rank" ~ '^[A-Za-z]+[1-9][0-9]*$';--> statement-breakpoint
ALTER TABLE "ranking_entries" ALTER COLUMN "position_rank" SET DATA TYPE integer
USING (
	CASE
		WHEN "position_rank" ~ '^[A-Za-z]+[1-9][0-9]*$'
			THEN substring("position_rank" from '([1-9][0-9]*)$')::integer
		ELSE NULL
	END
);--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "preview_checksum_sha256" text;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "commit_decision" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "accepted_row_numbers" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "confidence" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "is_target" boolean;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "is_avoid" boolean;--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD COLUMN "parent_version_id" uuid;--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD COLUMN "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD COLUMN "visibility_config" jsonb DEFAULT '{"scope":"private"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD COLUMN "scoring_context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD COLUMN "latest_published_version_id" uuid;--> statement-breakpoint

-- Canonicalize the pre-release representation without rewriting table identities. Public and
-- unlisted lists become private until an explicit league/shared-link grant is configured.
UPDATE "ranking_lists"
SET "kind" = CASE "kind"
	WHEN 'auction_values' THEN 'auction-values'
	WHEN 'cheat_sheet' THEN 'cheat-sheet'
	ELSE "kind"
END;--> statement-breakpoint
UPDATE "ranking_lists"
SET "visibility" = 'private'
WHERE "visibility" IN ('unlisted', 'public');--> statement-breakpoint
UPDATE "ranking_lists"
SET "visibility_config" = CASE
	WHEN "visibility" = 'league' THEN jsonb_build_object(
		'scope', 'league',
		'leagueIds', CASE WHEN "league_id" IS NULL THEN '[]'::jsonb ELSE jsonb_build_array("league_id"::text) END,
		'allowClone', false
	)
	ELSE jsonb_build_object('scope', 'private')
END;--> statement-breakpoint
UPDATE "ranking_lists"
SET "scoring_context" = jsonb_build_object(
	'format', CASE
		WHEN "scoring_format" IN ('STANDARD', 'HALF_PPR', 'PPR', 'CUSTOM') THEN "scoring_format"
		ELSE 'CUSTOM'
	END,
	'leagueId', "league_id"::text,
	'settingsChecksumSha256', NULL,
	'label', CASE
		WHEN "scoring_format" IN ('STANDARD', 'HALF_PPR', 'PPR', 'CUSTOM') THEN NULL
		ELSE "scoring_format"
	END
);--> statement-breakpoint
UPDATE "ranking_list_versions"
SET "status" = CASE
	WHEN "status" = 'archived' AND "published_at" IS NOT NULL THEN 'published'
	WHEN "status" = 'archived' THEN 'draft'
	ELSE "status"
END;--> statement-breakpoint

-- Retain any legacy non-SHA checksum as metadata before clearing the now strongly typed field.
UPDATE "ranking_list_versions"
SET "metadata" = jsonb_set("metadata", '{legacyContentHash}', to_jsonb("content_hash")),
	"content_hash" = NULL
WHERE "content_hash" IS NOT NULL AND "content_hash" !~ '^[a-f0-9]{64}$';--> statement-breakpoint
UPDATE "import_runs"
SET "validation_summary" = jsonb_set(
	"validation_summary", '{legacyContentHash}', to_jsonb("content_hash")
), "content_hash" = NULL
WHERE "content_hash" IS NOT NULL AND "content_hash" !~ '^[a-f0-9]{64}$';--> statement-breakpoint

-- Existing rows predate field-level provenance. Attribute those initial values to the list
-- owner at the row creation time so every populated typed field remains explainable.
UPDATE "ranking_entries" re
SET "field_provenance" = re."field_provenance"
	|| CASE WHEN re."rank" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('overallRank', attribution.value) END
	|| CASE WHEN re."position_rank" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('positionRank', attribution.value) END
	|| CASE WHEN re."tier" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('tier', attribution.value) END
	|| CASE WHEN re."adp" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('adp', attribution.value) END
	|| CASE WHEN re."aav" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('aav', attribution.value) END
	|| CASE WHEN re."floor" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('floorPrice', attribution.value) END
	|| CASE WHEN re."target" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('targetPrice', attribution.value) END
	|| CASE WHEN re."ceiling" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ceilingPrice', attribution.value) END
	|| CASE WHEN re."notes" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('notes', attribution.value) END
FROM "ranking_list_versions" rlv
JOIN "ranking_lists" rl ON rl."id" = rlv."ranking_list_id"
CROSS JOIN LATERAL (
	SELECT jsonb_build_object(
		'kind', 'user',
		'authorUserId', rl."owner_user_id"::text,
		'authoredAt', rlv."created_at"::text
	) AS value
) attribution
WHERE rlv."id" = re."ranking_list_version_id";--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_parent_version_id_ranking_list_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."ranking_list_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD CONSTRAINT "ranking_lists_current_version_id_ranking_list_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."ranking_list_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD CONSTRAINT "ranking_lists_latest_published_version_id_ranking_list_versions_id_fk" FOREIGN KEY ("latest_published_version_id") REFERENCES "public"."ranking_list_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ranking_list_versions_parent_idx" ON "ranking_list_versions" USING btree ("parent_version_id");--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_preview_hash_check" CHECK ("import_runs"."preview_checksum_sha256" is null or "import_runs"."preview_checksum_sha256" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_commit_decision_check" CHECK ("import_runs"."commit_decision" in ('pending', 'accepted', 'rejected'));--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_committed_at_check" CHECK (("import_runs"."commit_decision" = 'accepted') = ("import_runs"."committed_at" is not null));--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_content_hash_check" CHECK ("import_runs"."content_hash" is null or "import_runs"."content_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_position_rank_check" CHECK ("ranking_entries"."position_rank" is null or ("ranking_entries"."position_rank" > 0 and "ranking_entries"."position" is not null));--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_confidence_check" CHECK ("ranking_entries"."confidence" is null or ("ranking_entries"."confidence" >= 0 and "ranking_entries"."confidence" <= 1));--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_target_avoid_check" CHECK (not (coalesce("ranking_entries"."is_target", false) and coalesce("ranking_entries"."is_avoid", false)));--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_provenance_check" CHECK (jsonb_typeof("ranking_entries"."field_provenance") = 'object' and ("ranking_entries"."rank" is null or "ranking_entries"."field_provenance" ? 'overallRank') and ("ranking_entries"."position_rank" is null or "ranking_entries"."field_provenance" ? 'positionRank') and ("ranking_entries"."tier" is null or "ranking_entries"."field_provenance" ? 'tier') and ("ranking_entries"."adp" is null or "ranking_entries"."field_provenance" ? 'adp') and ("ranking_entries"."aav" is null or "ranking_entries"."field_provenance" ? 'aav') and ("ranking_entries"."floor" is null or "ranking_entries"."field_provenance" ? 'floorPrice') and ("ranking_entries"."target" is null or "ranking_entries"."field_provenance" ? 'targetPrice') and ("ranking_entries"."ceiling" is null or "ranking_entries"."field_provenance" ? 'ceilingPrice') and ("ranking_entries"."confidence" is null or "ranking_entries"."field_provenance" ? 'confidence') and ("ranking_entries"."tags" is null or "ranking_entries"."field_provenance" ? 'tags') and ("ranking_entries"."notes" is null or "ranking_entries"."field_provenance" ? 'notes') and ("ranking_entries"."is_target" is null or "ranking_entries"."field_provenance" ? 'target') and ("ranking_entries"."is_avoid" is null or "ranking_entries"."field_provenance" ? 'avoid'));--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_rank_check" CHECK ("ranking_entries"."rank" is null or "ranking_entries"."rank" > 0);--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_parent_check" CHECK ("ranking_list_versions"."parent_version_id" is null or "ranking_list_versions"."parent_version_id" <> "ranking_list_versions"."id");--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_status_check" CHECK ("ranking_list_versions"."status" in ('draft', 'published'));--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_published_at_check" CHECK (("ranking_list_versions"."status" = 'published') = ("ranking_list_versions"."published_at" is not null));--> statement-breakpoint
ALTER TABLE "ranking_list_versions" ADD CONSTRAINT "ranking_list_versions_content_hash_check" CHECK ("ranking_list_versions"."content_hash" is null or "ranking_list_versions"."content_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD CONSTRAINT "ranking_lists_visibility_config_check" CHECK (jsonb_typeof("ranking_lists"."visibility_config") = 'object' and "ranking_lists"."visibility_config"->>'scope' = "ranking_lists"."visibility");--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD CONSTRAINT "ranking_lists_kind_check" CHECK ("ranking_lists"."kind" in ('rankings', 'adp', 'auction-values', 'cheat-sheet'));--> statement-breakpoint
ALTER TABLE "ranking_lists" ADD CONSTRAINT "ranking_lists_visibility_check" CHECK ("ranking_lists"."visibility" in ('private', 'league', 'shared-link'));--> statement-breakpoint

CREATE FUNCTION "enforce_ranking_version_scope"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_list_id uuid;
	parent_version integer;
	import_list_id uuid;
BEGIN
	IF NEW."parent_version_id" IS NOT NULL THEN
		SELECT "ranking_list_id", "version" INTO parent_list_id, parent_version
		FROM "ranking_list_versions"
		WHERE "id" = NEW."parent_version_id";

		IF parent_list_id IS DISTINCT FROM NEW."ranking_list_id" THEN
			RAISE EXCEPTION 'ranking version parent must belong to the same list';
		END IF;
		IF parent_version >= NEW."version" THEN
			RAISE EXCEPTION 'ranking version parent must precede its child';
		END IF;
	END IF;

	IF NEW."import_run_id" IS NOT NULL THEN
		SELECT "ranking_list_id" INTO import_list_id
		FROM "import_runs"
		WHERE "id" = NEW."import_run_id";

		IF import_list_id IS NOT NULL AND import_list_id IS DISTINCT FROM NEW."ranking_list_id" THEN
			RAISE EXCEPTION 'ranking version import run must target the same list';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "ranking_list_versions_10_scope_trigger"
BEFORE INSERT OR UPDATE ON "ranking_list_versions"
FOR EACH ROW EXECUTE FUNCTION "enforce_ranking_version_scope"();--> statement-breakpoint

CREATE FUNCTION "enforce_ranking_version_immutable"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	actual_entry_count integer;
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF EXISTS (SELECT 1 FROM "ranking_lists" WHERE "id" = OLD."ranking_list_id") THEN
			RAISE EXCEPTION 'ranking version snapshots cannot be deleted';
		END IF;
		RETURN OLD;
	END IF;

	IF OLD."status" = 'draft'
		AND NEW."status" = 'published'
		AND (to_jsonb(NEW) - ARRAY['status', 'published_at', 'content_hash', 'entry_count'])
			= (to_jsonb(OLD) - ARRAY['status', 'published_at', 'content_hash', 'entry_count'])
	THEN
		SELECT count(*)::integer INTO actual_entry_count
		FROM "ranking_entries"
		WHERE "ranking_list_version_id" = OLD."id";

		IF NEW."entry_count" IS DISTINCT FROM actual_entry_count THEN
			RAISE EXCEPTION 'published ranking entry_count must match its snapshot';
		END IF;
		IF NEW."content_hash" IS NULL THEN
			RAISE EXCEPTION 'published ranking snapshot requires a SHA-256 checksum';
		END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'ranking version snapshots are immutable';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "ranking_list_versions_20_immutable_trigger"
BEFORE UPDATE OR DELETE ON "ranking_list_versions"
FOR EACH ROW EXECUTE FUNCTION "enforce_ranking_version_immutable"();--> statement-breakpoint

CREATE FUNCTION "enforce_ranking_entry_immutable"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	version_state text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT "status" INTO version_state
		FROM "ranking_list_versions"
		WHERE "id" = NEW."ranking_list_version_id";
		IF version_state IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'entries can only be inserted into a draft ranking snapshot';
		END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'DELETE' AND NOT EXISTS (
		SELECT 1 FROM "ranking_list_versions" WHERE "id" = OLD."ranking_list_version_id"
	) THEN
		RETURN OLD;
	END IF;

	RAISE EXCEPTION 'ranking entries are immutable; create a new version';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "ranking_entries_immutable_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ranking_entries"
FOR EACH ROW EXECUTE FUNCTION "enforce_ranking_entry_immutable"();--> statement-breakpoint

CREATE FUNCTION "enforce_ranking_list_version_pointers"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."current_version_id" IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM "ranking_list_versions"
		WHERE "id" = NEW."current_version_id" AND "ranking_list_id" = NEW."id"
	) THEN
		RAISE EXCEPTION 'current ranking version must belong to its list';
	END IF;

	IF NEW."latest_published_version_id" IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM "ranking_list_versions"
		WHERE "id" = NEW."latest_published_version_id"
			AND "ranking_list_id" = NEW."id"
			AND "status" = 'published'
	) THEN
		RAISE EXCEPTION 'latest published ranking version must be published and belong to its list';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "ranking_lists_version_pointers_trigger"
BEFORE INSERT OR UPDATE OF "current_version_id", "latest_published_version_id" ON "ranking_lists"
FOR EACH ROW EXECUTE FUNCTION "enforce_ranking_list_version_pointers"();
