-- One row per panel, holding the right to run a connection test.
--
-- The composite (tenant_id, panel_id) foreign key added in 0018 already exists
-- when this runs, so the generated statement order applies as emitted.
--
-- Purely additive: nothing reads or writes this table before the release that
-- introduces it, so an installation mid-update has a table nobody uses rather
-- than a behaviour change it has not deployed yet.
CREATE TABLE "panel_probe_claims" (
	"panel_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"configuration" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "panel_probe_claims" ADD CONSTRAINT "panel_probe_claims_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_probe_claims" ADD CONSTRAINT "panel_probe_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_probe_claims" ADD CONSTRAINT "panel_probe_claims_tenant_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "panel_probe_claims_tenant_idx" ON "panel_probe_claims" USING btree ("tenant_id");