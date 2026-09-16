CREATE TABLE "service_addons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'INACTIVE' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"traffic_bytes" bigint,
	"duration_days" integer,
	"price_amount" bigint,
	"price_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_addons_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_addons_kind_check" CHECK (kind IN ('ADD_TRAFFIC', 'ADD_TIME')),
	CONSTRAINT "service_addons_status_check" CHECK (status IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "service_addons_price_currency_check" CHECK (price_currency IS NULL OR price_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_addons_price_pair_check" CHECK ((price_amount IS NULL) = (price_currency IS NULL)),
	CONSTRAINT "service_addons_price_positive_check" CHECK (price_amount IS NULL OR price_amount > 0),
	CONSTRAINT "service_addons_amount_matches_kind" CHECK ((kind = 'ADD_TRAFFIC' AND traffic_bytes IS NOT NULL AND traffic_bytes > 0 AND duration_days IS NULL)
          OR (kind = 'ADD_TIME' AND duration_days IS NOT NULL AND duration_days > 0 AND traffic_bytes IS NULL)),
	CONSTRAINT "service_addons_duration_bound_check" CHECK (duration_days IS NULL OR duration_days <= 3650)
);
--> statement-breakpoint
CREATE TABLE "service_commercial_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"product_id" uuid,
	"addon_id" uuid,
	"purchased_traffic_bytes" bigint DEFAULT 0 NOT NULL,
	"purchased_duration_days" integer DEFAULT 0 NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_commercial_actions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_commercial_actions_kind_check" CHECK (kind IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME')),
	CONSTRAINT "service_commercial_actions_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_commercial_actions_amount_check" CHECK (amount >= 0),
	CONSTRAINT "service_commercial_actions_source_check" CHECK ((product_id IS NULL) <> (addon_id IS NULL)),
	CONSTRAINT "service_commercial_actions_purchased_check" CHECK ((kind = 'RENEW')
          OR (kind = 'ADD_TRAFFIC' AND purchased_traffic_bytes > 0 AND purchased_duration_days = 0)
          OR (kind = 'ADD_TIME' AND purchased_duration_days > 0 AND purchased_traffic_bytes = 0))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "purpose" text DEFAULT 'NEW_SERVICE' NOT NULL;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "target_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "target_traffic_limit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hoisted above the foreign key below: drizzle-kit emits the reference before
-- the unique constraint it points at, and PostgreSQL refuses a composite
-- foreign key whose target has no matching unique index.
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_customer_key" UNIQUE("tenant_id","id","customer_id");--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_service_fk" FOREIGN KEY ("tenant_id","service_id","customer_id") REFERENCES "public"."services"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_addon_fk" FOREIGN KEY ("tenant_id","addon_id") REFERENCES "public"."service_addons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_addons_tenant_status_idx" ON "service_addons" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "service_addons_tenant_sort_idx" ON "service_addons" USING btree ("tenant_id","kind","sort_order","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_commercial_actions_order_key" ON "service_commercial_actions" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "service_commercial_actions_service_idx" ON "service_commercial_actions" USING btree ("service_id","created_at","id");--> statement-breakpoint
CREATE INDEX "service_commercial_actions_customer_idx" ON "service_commercial_actions" USING btree ("customer_id","created_at","id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purpose_check" CHECK (purpose IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quantity_line_check" CHECK (purpose NOT IN ('ADD_TRAFFIC', 'ADD_TIME')
          OR (purpose = 'ADD_TRAFFIC' AND line_traffic_bytes > 0 AND line_duration_days = 0)
          OR (purpose = 'ADD_TIME' AND line_duration_days > 0 AND line_traffic_bytes = 0));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_check" CHECK (type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME')
          OR (target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_present_check" CHECK (type NOT IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME')
          OR target_expires_at IS NOT NULL
          OR target_traffic_limit_bytes IS NOT NULL);--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_traffic_check" CHECK (target_traffic_limit_bytes IS NULL OR target_traffic_limit_bytes >= 0);