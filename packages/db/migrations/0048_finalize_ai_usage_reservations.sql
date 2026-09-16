-- Daily-limit reservations are inserted before a provider call. Permit exactly one
-- completion of an untouched reservation, then keep the resulting audit row immutable.
-- In particular, occurred_at remains the reservation day used for daily-limit accounting.
CREATE OR REPLACE FUNCTION "enforce_ai_usage_ledger_append_only"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'ai_usage_ledger is append-only';
	END IF;

	-- Retain the existing FK anonymization allowance without allowing another edit
	-- to be hidden in the same UPDATE. Exact no-op retries are also harmless.
	IF (to_jsonb(NEW) - ARRAY['user_id', 'credential_id'])
		IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['user_id', 'credential_id'])
		AND (NEW."user_id" IS NOT DISTINCT FROM OLD."user_id" OR NEW."user_id" IS NULL)
		AND (NEW."credential_id" IS NOT DISTINCT FROM OLD."credential_id" OR NEW."credential_id" IS NULL)
	THEN
		RETURN NEW;
	END IF;

	IF OLD."request_id_hash" IS NULL
		AND OLD."input_tokens" = 0 AND OLD."output_tokens" = 0
		AND OLD."cache_read_tokens" = 0 AND OLD."cache_write_tokens" = 0
		AND OLD."cost" = 0 AND OLD."latency_ms" IS NULL
		AND OLD."succeeded" = false AND OLD."error_code" IS NULL
		AND NEW."latency_ms" IS NOT NULL AND NEW."latency_ms" >= 0
		AND ((NEW."succeeded" = true AND NEW."error_code" IS NULL)
			OR (NEW."succeeded" = false AND char_length(btrim(NEW."error_code")) > 0))
		AND (to_jsonb(NEW) - ARRAY[
			'request_id_hash', 'input_tokens', 'output_tokens', 'cache_read_tokens',
			'cache_write_tokens', 'latency_ms', 'succeeded', 'error_code'
		]) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY[
			'request_id_hash', 'input_tokens', 'output_tokens', 'cache_read_tokens',
			'cache_write_tokens', 'latency_ms', 'succeeded', 'error_code'
		])
	THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'ai_usage_ledger is append-only';
END;
$$;
