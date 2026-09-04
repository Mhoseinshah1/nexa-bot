-- The UNIQUE comes FIRST, and the order is load-bearing.
--
-- A composite foreign key needs a unique constraint on the columns it points
-- at, and PostgreSQL checks that when the constraint is created rather than
-- when it is first used. drizzle-kit emitted the two references before the key
-- they reference, so the generated file failed to apply with
-- "there is no unique constraint matching given keys". Reordered by hand, which
-- is allowed here only because this migration has never been applied anywhere.
--
-- On an installation whose data is sound these three statements are metadata
-- changes and a validation scan. If a child row DOES name another tenant's
-- panel, the ALTER fails and the update stops — which is the right outcome: the
-- application cannot produce such a row, so its existence means something wrote
-- the database directly, and re-encrypting a credential under a context derived
-- from the wrong tenant would make it permanently unreadable.
ALTER TABLE "panels" ADD CONSTRAINT "panels_tenant_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "panel_credentials" ADD CONSTRAINT "panel_credentials_tenant_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_health" ADD CONSTRAINT "panel_health_tenant_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;
