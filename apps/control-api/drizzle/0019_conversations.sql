CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"published_version" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "turn_index" integer;--> statement-breakpoint
CREATE INDEX "conversations_agent_idx" ON "conversations" USING btree ("agent_id");