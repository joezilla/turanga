ALTER TABLE "agents" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "variables" jsonb DEFAULT '[]'::jsonb NOT NULL;