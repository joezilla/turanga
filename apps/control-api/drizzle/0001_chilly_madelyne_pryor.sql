CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"key_last4" text,
	"status" text NOT NULL,
	"last_error" text,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"litellm_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
