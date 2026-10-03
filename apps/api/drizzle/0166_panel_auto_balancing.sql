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
ALTER TABLE "panels" ADD CONSTRAINT "panels_balancing_group_check" CHECK ("panels"."balancing_group" IS NULL OR "panels"."balancing_group" ~ '^[a-z0-9][a-z0-9_-]{0,39}$');