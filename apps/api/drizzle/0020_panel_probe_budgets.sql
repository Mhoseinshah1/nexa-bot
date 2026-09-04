CREATE TABLE "panel_probe_budgets" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "panel_probe_budgets_tokens_check" CHECK (tokens >= 0)
);
--> statement-breakpoint
ALTER TABLE "panel_probe_budgets" ADD CONSTRAINT "panel_probe_budgets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;