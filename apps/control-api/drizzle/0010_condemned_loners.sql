ALTER TABLE "connections" ADD COLUMN "enabled_models" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "connections" SET "enabled_models" = "models" WHERE "status" = 'connected';