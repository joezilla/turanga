CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"embedding" vector(1536),
	"topic" text,
	"salience" integer DEFAULT 0 NOT NULL,
	"source_run_id" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"default_enabled" boolean DEFAULT false NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"retention_days" integer,
	"privacy" text DEFAULT 'agent-scoped' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "memory_config" jsonb DEFAULT '{"mode":"inherit","recall":true,"reflect":true,"kinds":["episodic","semantic","procedure"]}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_memories_agent_idx" ON "agent_memories" USING btree ("agent_id");