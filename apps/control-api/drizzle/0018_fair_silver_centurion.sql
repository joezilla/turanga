CREATE TABLE "memory_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"memory_id" text,
	"kind" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"source_run_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_settings" ADD COLUMN "require_approval_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_events_agent_idx" ON "memory_events" USING btree ("agent_id");