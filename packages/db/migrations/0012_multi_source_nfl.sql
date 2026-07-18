CREATE TABLE "player_market_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"signal" text NOT NULL,
	"lookback_hours" integer NOT NULL,
	"rank" integer NOT NULL,
	"count" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_market_observations_external_id_check" CHECK (char_length(btrim("player_market_observations"."external_player_id")) between 1 and 64),
	CONSTRAINT "player_market_observations_signal_check" CHECK ("player_market_observations"."signal" in ('add', 'drop')),
	CONSTRAINT "player_market_observations_bounds_check" CHECK ("player_market_observations"."lookback_hours" between 1 and 168 and "player_market_observations"."rank" between 1 and 250 and "player_market_observations"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "player_source_observations" (
	"source_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"gsis_id" text,
	"full_name" text NOT NULL,
	"nfl_team" text,
	"primary_position" text NOT NULL,
	"eligible_positions" text[] NOT NULL,
	"status" text,
	"injury_status" text,
	"practice_participation" text,
	"depth_chart_position" text,
	"depth_chart_order" integer,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_source_observations_source_id_external_player_id_pk" PRIMARY KEY("source_id","external_player_id"),
	CONSTRAINT "player_source_observations_external_id_check" CHECK (char_length(btrim("player_source_observations"."external_player_id")) between 1 and 64),
	CONSTRAINT "player_source_observations_name_check" CHECK (char_length(btrim("player_source_observations"."full_name")) > 0),
	CONSTRAINT "player_source_observations_position_check" CHECK (char_length(btrim("player_source_observations"."primary_position")) > 0 and cardinality("player_source_observations"."eligible_positions") > 0),
	CONSTRAINT "player_source_observations_depth_order_check" CHECK ("player_source_observations"."depth_chart_order" is null or "player_source_observations"."depth_chart_order" between 0 and 99)
);
--> statement-breakpoint
ALTER TABLE "player_market_observations" ADD CONSTRAINT "player_market_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_market_observations" ADD CONSTRAINT "player_market_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_source_observations" ADD CONSTRAINT "player_source_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_source_observations" ADD CONSTRAINT "player_source_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_market_observations_run_unique" ON "player_market_observations" USING btree ("source_id","signal","external_player_id","observed_at");--> statement-breakpoint
CREATE INDEX "player_market_observations_player_observed_idx" ON "player_market_observations" USING btree ("player_id","observed_at");--> statement-breakpoint
CREATE INDEX "player_market_observations_source_observed_idx" ON "player_market_observations" USING btree ("source_id","observed_at");--> statement-breakpoint
CREATE INDEX "player_source_observations_player_idx" ON "player_source_observations" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "player_source_observations_observed_idx" ON "player_source_observations" USING btree ("observed_at");