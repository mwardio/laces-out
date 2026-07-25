CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"delivered_device_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_kind_check" CHECK ("notification_deliveries"."kind" in ('lineup-lock')),
	CONSTRAINT "notification_deliveries_key_check" CHECK (char_length(btrim("notification_deliveries"."idempotency_key")) between 1 and 200),
	CONSTRAINT "notification_deliveries_device_count_check" CHECK ("notification_deliveries"."delivered_device_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_check" CHECK (char_length(btrim("push_subscriptions"."endpoint")) between 1 and 2048),
	CONSTRAINT "push_subscriptions_keys_check" CHECK (char_length(btrim("push_subscriptions"."p256dh")) between 1 and 256 and char_length(btrim("push_subscriptions"."auth")) between 1 and 256),
	CONSTRAINT "push_subscriptions_label_check" CHECK ("push_subscriptions"."user_agent_label" is null or char_length(btrim("push_subscriptions"."user_agent_label")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_key_unique" ON "notification_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_idx" ON "notification_deliveries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_unique" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");