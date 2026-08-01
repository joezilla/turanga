CREATE TABLE "data_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"account_email" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"destinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"last_error" text,
	"enc_refresh_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
