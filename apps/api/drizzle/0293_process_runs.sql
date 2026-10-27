CREATE TABLE "process_runs" (
	"role" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stable_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"restarts" integer DEFAULT 0 NOT NULL,
	"restarts_since" timestamp with time zone,
	CONSTRAINT "process_runs_role_check" CHECK (role ~ '^[a-z][a-z0-9_-]{0,31}$'),
	CONSTRAINT "process_runs_restarts_check" CHECK (restarts >= 0 AND (restarts = 0) = (restarts_since IS NULL))
);
