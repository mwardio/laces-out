-- Ranking snapshots stay immutable during ordinary application work. Account erasure is the one
-- operation that must be able to remove a user UUID embedded in another member's surviving cloned
-- provenance without deleting or rewriting the ranking facts themselves. A transaction-local
-- custom setting names the exact UUID being erased; the triggers accept only the mechanically
-- identical JSON produced by replacing that UUID with the fixed, non-account sentinel.

CREATE OR REPLACE FUNCTION "enforce_ranking_version_immutable"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	actual_entry_count integer;
	deletion_user_id text := nullif(
		current_setting('laces_out.account_deletion_user_id', true),
		''
	);
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF EXISTS (SELECT 1 FROM "ranking_lists" WHERE "id" = OLD."ranking_list_id") THEN
			RAISE EXCEPTION 'ranking version snapshots cannot be deleted';
		END IF;
		RETURN OLD;
	END IF;

	IF deletion_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND (to_jsonb(NEW) - 'provenance') = (to_jsonb(OLD) - 'provenance')
		AND NEW."provenance" IS DISTINCT FROM OLD."provenance"
		AND NEW."provenance" = replace(
			OLD."provenance"::text,
			deletion_user_id,
			'00000000-0000-4000-8000-000000000000'
		)::jsonb
	THEN
		RETURN NEW;
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_ranking_entry_immutable"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	version_state text;
	deletion_user_id text := nullif(
		current_setting('laces_out.account_deletion_user_id', true),
		''
	);
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

	IF TG_OP = 'UPDATE'
		AND deletion_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND (to_jsonb(NEW) - 'field_provenance') = (to_jsonb(OLD) - 'field_provenance')
		AND NEW."field_provenance" IS DISTINCT FROM OLD."field_provenance"
		AND NEW."field_provenance" = replace(
			OLD."field_provenance"::text,
			deletion_user_id,
			'00000000-0000-4000-8000-000000000000'
		)::jsonb
	THEN
		RETURN NEW;
	END IF;

	IF TG_OP = 'DELETE' AND NOT EXISTS (
		SELECT 1 FROM "ranking_list_versions" WHERE "id" = OLD."ranking_list_version_id"
	) THEN
		RETURN OLD;
	END IF;

	RAISE EXCEPTION 'ranking entries are immutable; create a new version';
END;
$$;
