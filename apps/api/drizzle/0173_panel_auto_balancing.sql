-- Phase C3: automatic panel balancing.
--
-- panels.balancing_group     an operator's label for panels interchangeable for a NEW
--                            account. NULL on every existing panel, so every product keeps
--                            its explicit route when this runs.
-- order_panel_placements     why a new-service order landed where it did, written once in
--                            the draft's transaction and never changed (trigger below).
--
-- Numbered 0173, above C2's 0172_panel_drain; renumber at merge if another lands first.
-- The hand-written immutability trigger is the separated tail after the generated DDL.
CREATE TABLE "order_panel_placements" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"home_panel_id" uuid NOT NULL,
	"chosen_panel_id" uuid NOT NULL,
	"balancing_group" text NOT NULL,
	"strategy" text NOT NULL,
	"decided_by" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_panel_placements_pk" PRIMARY KEY("tenant_id","order_id"),
	CONSTRAINT "order_panel_placements_strategy_check" CHECK (strategy IN ('LEAST_USED', 'LOWEST_UTILISATION')),
	CONSTRAINT "order_panel_placements_decided_by_check" CHECK (decided_by IN ('SOLE_CANDIDATE', 'HEALTH', 'LOAD', 'HOME_PREFERENCE', 'PANEL_ID', 'NO_ELIGIBLE_CANDIDATE')),
	CONSTRAINT "order_panel_placements_candidates_check" CHECK (jsonb_typeof("order_panel_placements"."candidates") = 'array')
);
--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "balancing_group" text;--> statement-breakpoint
ALTER TABLE "order_panel_placements" ADD CONSTRAINT "order_panel_placements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_panel_placements" ADD CONSTRAINT "order_panel_placements_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_panel_placements" ADD CONSTRAINT "order_panel_placements_home_fk" FOREIGN KEY ("tenant_id","home_panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_panel_placements" ADD CONSTRAINT "order_panel_placements_chosen_fk" FOREIGN KEY ("tenant_id","chosen_panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_balancing_group_check" CHECK ("panels"."balancing_group" IS NULL OR "panels"."balancing_group" ~ '^[a-z0-9][a-z0-9_-]{0,39}$');--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers). A placement explains a decision
-- that was made; rewriting it later would make the explanation describe something else.
CREATE OR REPLACE FUNCTION nexa_order_panel_placements_frozen() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_panel_placements rows are written once and never changed.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER nexa_order_panel_placements_frozen
  BEFORE UPDATE ON order_panel_placements
  FOR EACH ROW EXECUTE FUNCTION nexa_order_panel_placements_frozen();
