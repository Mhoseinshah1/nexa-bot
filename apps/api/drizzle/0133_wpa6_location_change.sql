-- WP-A6: service location change.
--
-- service_locations            an operator's locations per panel: the adapter-defined key, the
--                              customer-facing name, the panel's INITIAL location, and, when
--                              enabled and priced, an offer to move there (zero is free; no
--                              row, disabled or unpriced is unavailable). Optional product
--                              scope, cooldown and rolling-period limit; a version per edit.
-- service_location_changes     one row per requested change, written once: from / to (keys and
--                              names), the location and version it was quoted from, the list
--                              price, the cooldown and limit it was quoted under, and the ORDER
--                              (paid) or the OPERATION (free) behind it.
-- services                     location_key / location_label, written by an applied move, and
--                              by an operator's change to a panel's initial location, which
--                              first freezes the old one onto every never-moved service.
-- orders                       CHANGE_LOCATION purpose; its line buys no bytes, days or devices.
-- service_commercial_actions   location_id is the third, mutually exclusive price source.
-- provisioning_operations      CHANGE_LOCATION type with target_location_key, and it joins the
--                              one-open-commercial-action index. No CHANGE_LOCATION row exists
--                              before this release, so the rebuilt index cannot collide.
CREATE TABLE "service_location_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"location_version" integer NOT NULL,
	"from_location_key" text NOT NULL,
	"from_location_label" text NOT NULL,
	"to_location_key" text NOT NULL,
	"to_location_label" text NOT NULL,
	"price_amount" bigint NOT NULL,
	"price_currency" text NOT NULL,
	"cooldown_hours" integer,
	"max_changes" integer,
	"period_days" integer,
	"order_id" uuid,
	"operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_location_changes_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_location_changes_source_check" CHECK ((order_id IS NULL) <> (operation_id IS NULL)),
	CONSTRAINT "service_location_changes_price_check" CHECK (price_amount >= 0 AND (price_amount = 0) = (order_id IS NULL)),
	CONSTRAINT "service_location_changes_currency_check" CHECK (price_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_location_changes_moves_check" CHECK (from_location_key <> to_location_key),
	CONSTRAINT "service_location_changes_version_check" CHECK (location_version >= 1),
	CONSTRAINT "service_location_changes_limits_check" CHECK ((cooldown_hours IS NULL OR cooldown_hours >= 1)
          AND (max_changes IS NULL) = (period_days IS NULL)
          AND (max_changes IS NULL OR (max_changes >= 1 AND period_days >= 1)))
);
--> statement-breakpoint
CREATE TABLE "service_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"product_id" uuid,
	"location_key" text NOT NULL,
	"label" text NOT NULL,
	"is_initial" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"price_amount" bigint,
	"price_currency" text,
	"cooldown_hours" integer,
	"max_changes" integer,
	"period_days" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_locations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_locations_key" UNIQUE NULLS NOT DISTINCT("tenant_id","panel_id","location_key","product_id"),
	CONSTRAINT "service_locations_key_check" CHECK (length(location_key) BETWEEN 1 AND 120),
	CONSTRAINT "service_locations_label_check" CHECK (length(btrim(label)) BETWEEN 1 AND 60),
	CONSTRAINT "service_locations_price_check" CHECK ((price_amount IS NULL) = (price_currency IS NULL) AND (price_amount IS NULL OR price_amount >= 0)),
	CONSTRAINT "service_locations_currency_check" CHECK (price_currency IS NULL OR price_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_locations_enabled_priced_check" CHECK (NOT enabled OR price_amount IS NOT NULL),
	CONSTRAINT "service_locations_initial_scope_check" CHECK (NOT is_initial OR product_id IS NULL),
	CONSTRAINT "service_locations_cooldown_check" CHECK (cooldown_hours IS NULL OR (cooldown_hours >= 1 AND cooldown_hours <= 8760)),
	CONSTRAINT "service_locations_limit_check" CHECK ((max_changes IS NULL) = (period_days IS NULL)
          AND (max_changes IS NULL OR (max_changes >= 1 AND max_changes <= 100))
          AND (period_days IS NULL OR (period_days >= 1 AND period_days <= 365))),
	CONSTRAINT "service_locations_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "cashback_rules" DROP CONSTRAINT "cashback_rules_applies_to_check";--> statement-breakpoint
ALTER TABLE "discounts" DROP CONSTRAINT "discounts_applies_to_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_purpose_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_quantity_line_check";--> statement-breakpoint
ALTER TABLE "provisioning_operations" DROP CONSTRAINT "provisioning_operations_type_check";--> statement-breakpoint
ALTER TABLE "provisioning_operations" DROP CONSTRAINT "provisioning_operations_target_check";--> statement-breakpoint
ALTER TABLE "provisioning_operations" DROP CONSTRAINT "provisioning_operations_target_present_check";--> statement-breakpoint
ALTER TABLE "reseller_tier_grants" DROP CONSTRAINT "reseller_tier_grants_subject_check";--> statement-breakpoint
ALTER TABLE "service_commercial_actions" DROP CONSTRAINT "service_commercial_actions_kind_check";--> statement-breakpoint
ALTER TABLE "service_commercial_actions" DROP CONSTRAINT "service_commercial_actions_source_check";--> statement-breakpoint
ALTER TABLE "service_commercial_actions" DROP CONSTRAINT "service_commercial_actions_purchased_check";--> statement-breakpoint
DROP INDEX "provisioning_operations_open_commercial_key";--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "target_location_key" text;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "location_key" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "location_label" text;--> statement-breakpoint
ALTER TABLE "service_location_changes" ADD CONSTRAINT "service_location_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location_changes" ADD CONSTRAINT "service_location_changes_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location_changes" ADD CONSTRAINT "service_location_changes_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location_changes" ADD CONSTRAINT "service_location_changes_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."service_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location_changes" ADD CONSTRAINT "service_location_changes_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location_changes" ADD CONSTRAINT "service_location_changes_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."provisioning_operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_location_changes_order_key" ON "service_location_changes" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_location_changes_operation_key" ON "service_location_changes" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX "service_location_changes_service_idx" ON "service_location_changes" USING btree ("tenant_id","service_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_locations_initial_key" ON "service_locations" USING btree ("tenant_id","panel_id") WHERE is_initial;--> statement-breakpoint
CREATE INDEX "service_locations_panel_idx" ON "service_locations" USING btree ("tenant_id","panel_id","sort_order");--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."service_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_operations_open_commercial_key" ON "provisioning_operations" USING btree ("tenant_id","service_id") WHERE type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION') AND state IN ('PLANNED', 'IN_FLIGHT', 'UNKNOWN');--> statement-breakpoint
ALTER TABLE "cashback_rules" ADD CONSTRAINT "cashback_rules_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'CUSTOM_SERVICE', 'ADD_DEVICES', 'CHANGE_LOCATION']::text[]);--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'CUSTOM_SERVICE', 'ADD_DEVICES', 'CHANGE_LOCATION']::text[]);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purpose_check" CHECK (purpose IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'TRIAL', 'CUSTOM_SERVICE', 'ADD_DEVICES', 'CHANGE_LOCATION'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quantity_line_check" CHECK (purpose NOT IN ('ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR (purpose = 'ADD_TRAFFIC' AND line_traffic_bytes > 0 AND line_duration_days = 0)
          OR (purpose = 'ADD_TIME' AND line_duration_days > 0 AND line_traffic_bytes = 0)
          OR (purpose = 'ADD_DEVICES' AND line_traffic_bytes = 0 AND line_duration_days = 0
              AND line_device_limit IS NOT NULL AND line_device_limit > line_quantity)
          OR (purpose = 'CHANGE_LOCATION' AND line_traffic_bytes = 0 AND line_duration_days = 0
              AND line_device_limit IS NULL AND line_quantity = 1));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_location_check" CHECK ((type = 'CHANGE_LOCATION'
           AND target_location_key IS NOT NULL
           AND length(target_location_key) BETWEEN 1 AND 120
           AND target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL AND target_device_limit IS NULL)
          OR (type <> 'CHANGE_LOCATION' AND target_location_key IS NULL));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_type_check" CHECK (type IN ('PROVISION', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'SUSPEND', 'RESUME', 'TERMINATE', 'SYNC_USAGE', 'ROTATE_SUBSCRIPTION', 'RECONCILE', 'ADD_DEVICES', 'CHANGE_LOCATION'));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_check" CHECK (type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR (target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL AND target_device_limit IS NULL
              AND target_location_key IS NULL));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_present_check" CHECK (type NOT IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR target_expires_at IS NOT NULL
          OR target_traffic_limit_bytes IS NOT NULL
          OR target_device_limit IS NOT NULL
          OR target_location_key IS NOT NULL);--> statement-breakpoint
ALTER TABLE "reseller_tier_grants" ADD CONSTRAINT "reseller_tier_grants_subject_check" CHECK (subject = '*' OR (kind = 'OPERATION' AND subject IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_kind_check" CHECK (kind IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION'));--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_source_check" CHECK ((CASE WHEN product_id IS NULL THEN 0 ELSE 1 END
           + CASE WHEN addon_id IS NULL THEN 0 ELSE 1 END
           + CASE WHEN location_id IS NULL THEN 0 ELSE 1 END) = 1
          AND (location_id IS NULL) = (kind <> 'CHANGE_LOCATION'));--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_purchased_check" CHECK ((kind = 'RENEW' AND purchased_device_count = 0)
          OR (kind = 'ADD_TRAFFIC' AND purchased_traffic_bytes > 0 AND purchased_duration_days = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_TIME' AND purchased_duration_days > 0 AND purchased_traffic_bytes = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_DEVICES' AND purchased_device_count > 0 AND purchased_traffic_bytes = 0 AND purchased_duration_days = 0
              AND addon_id IS NOT NULL AND addon_version IS NOT NULL)
          OR (kind = 'CHANGE_LOCATION' AND purchased_traffic_bytes = 0 AND purchased_duration_days = 0
              AND purchased_device_count = 0));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_location_check" CHECK ((location_key IS NULL) = (location_label IS NULL));