-- WP-A5: extra users / devices on an existing service.
--
-- services.device_limit        the device / connection limit a service is entitled to;
--                              seeded below from the order that created it, raised only by
--                              an ADD_DEVICES operation the panel applied.
-- service_addons               ADD_DEVICES kind: a per-device price with max_quantity, an
--                              optional panel / product scope, and a version every edit bumps.
-- orders                       ADD_DEVICES purpose; its line is quantity x unit price with
--                              line_device_limit = the quoted target.
-- service_commercial_actions   purchased_device_count and addon_version (the rule's id and
--                              version on the snapshot).
-- provisioning_operations      ADD_DEVICES type with target_device_limit, and it joins the
--                              one-open-commercial-action index. No ADD_DEVICES row exists
--                              before this release, so the rebuilt index cannot collide.
ALTER TABLE "cashback_rules" DROP CONSTRAINT "cashback_rules_applies_to_check";--> statement-breakpoint
ALTER TABLE "discounts" DROP CONSTRAINT "discounts_applies_to_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_purpose_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_quantity_line_check";--> statement-breakpoint
ALTER TABLE "provisioning_operations" DROP CONSTRAINT "provisioning_operations_type_check";--> statement-breakpoint
ALTER TABLE "provisioning_operations" DROP CONSTRAINT "provisioning_operations_target_check";--> statement-breakpoint
ALTER TABLE "provisioning_operations" DROP CONSTRAINT "provisioning_operations_target_present_check";--> statement-breakpoint
ALTER TABLE "reseller_tier_grants" DROP CONSTRAINT "reseller_tier_grants_subject_check";--> statement-breakpoint
ALTER TABLE "service_addons" DROP CONSTRAINT "service_addons_kind_check";--> statement-breakpoint
ALTER TABLE "service_addons" DROP CONSTRAINT "service_addons_amount_matches_kind";--> statement-breakpoint
ALTER TABLE "service_commercial_actions" DROP CONSTRAINT "service_commercial_actions_kind_check";--> statement-breakpoint
ALTER TABLE "service_commercial_actions" DROP CONSTRAINT "service_commercial_actions_purchased_check";--> statement-breakpoint
DROP INDEX "provisioning_operations_open_commercial_key";--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "target_device_limit" integer;--> statement-breakpoint
ALTER TABLE "service_addons" ADD COLUMN "max_quantity" integer;--> statement-breakpoint
ALTER TABLE "service_addons" ADD COLUMN "panel_id" uuid;--> statement-breakpoint
ALTER TABLE "service_addons" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "service_addons" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD COLUMN "purchased_device_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD COLUMN "addon_version" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "device_limit" integer;--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_operations_open_commercial_key" ON "provisioning_operations" USING btree ("tenant_id","service_id") WHERE type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES') AND state IN ('PLANNED', 'IN_FLIGHT', 'UNKNOWN');--> statement-breakpoint
ALTER TABLE "cashback_rules" ADD CONSTRAINT "cashback_rules_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'CUSTOM_SERVICE', 'ADD_DEVICES']::text[]);--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_applies_to_check" CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'CUSTOM_SERVICE', 'ADD_DEVICES']::text[]);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purpose_check" CHECK (purpose IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'TRIAL', 'CUSTOM_SERVICE', 'ADD_DEVICES'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quantity_line_check" CHECK (purpose NOT IN ('ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES')
          OR (purpose = 'ADD_TRAFFIC' AND line_traffic_bytes > 0 AND line_duration_days = 0)
          OR (purpose = 'ADD_TIME' AND line_duration_days > 0 AND line_traffic_bytes = 0)
          OR (purpose = 'ADD_DEVICES' AND line_traffic_bytes = 0 AND line_duration_days = 0
              AND line_device_limit IS NOT NULL AND line_device_limit > line_quantity));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_device_check" CHECK ((type = 'ADD_DEVICES'
           AND target_device_limit IS NOT NULL AND target_device_limit >= 1 AND target_device_limit <= 1000
           AND target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL)
          OR (type <> 'ADD_DEVICES' AND target_device_limit IS NULL));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_type_check" CHECK (type IN ('PROVISION', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'SUSPEND', 'RESUME', 'TERMINATE', 'SYNC_USAGE', 'ROTATE_SUBSCRIPTION', 'RECONCILE', 'ADD_DEVICES'));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_check" CHECK (type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES')
          OR (target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL AND target_device_limit IS NULL));--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_target_present_check" CHECK (type NOT IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES')
          OR target_expires_at IS NOT NULL
          OR target_traffic_limit_bytes IS NOT NULL
          OR target_device_limit IS NOT NULL);--> statement-breakpoint
ALTER TABLE "reseller_tier_grants" ADD CONSTRAINT "reseller_tier_grants_subject_check" CHECK (subject = '*' OR (kind = 'OPERATION' AND subject IN ('NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES')) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_scope_kind_check" CHECK (kind = 'ADD_DEVICES' OR (panel_id IS NULL AND product_id IS NULL));--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_version_check" CHECK (version >= 1);--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_kind_check" CHECK (kind IN ('ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES'));--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_amount_matches_kind" CHECK ((kind = 'ADD_TRAFFIC' AND traffic_bytes IS NOT NULL AND traffic_bytes > 0 AND duration_days IS NULL AND max_quantity IS NULL)
          OR (kind = 'ADD_TIME' AND duration_days IS NOT NULL AND duration_days > 0 AND traffic_bytes IS NULL AND max_quantity IS NULL)
          OR (kind = 'ADD_DEVICES' AND max_quantity IS NOT NULL AND max_quantity >= 1 AND max_quantity <= 20 AND traffic_bytes IS NULL AND duration_days IS NULL));--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_addon_version_check" CHECK (addon_version IS NULL OR (kind = 'ADD_DEVICES' AND addon_version >= 1));--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_kind_check" CHECK (kind IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES'));--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_purchased_check" CHECK ((kind = 'RENEW' AND purchased_device_count = 0)
          OR (kind = 'ADD_TRAFFIC' AND purchased_traffic_bytes > 0 AND purchased_duration_days = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_TIME' AND purchased_duration_days > 0 AND purchased_traffic_bytes = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_DEVICES' AND purchased_device_count > 0 AND purchased_traffic_bytes = 0 AND purchased_duration_days = 0
              AND addon_id IS NOT NULL AND addon_version IS NOT NULL));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_device_limit_check" CHECK (device_limit IS NULL OR (device_limit >= 1 AND device_limit <= 1000));--> statement-breakpoint
-- The entitlement every existing service already has: the limit its own order froze. A
-- custom service (no product) and a plan with no limit stay NULL, which is "none recorded"
-- and is never offered extra users. A value outside the bound is left NULL rather than
-- clamped: a clamp would record a limit the panel was never given.
UPDATE "services" AS s
   SET "device_limit" = o."line_device_limit"
  FROM "orders" AS o
 WHERE o."tenant_id" = s."tenant_id"
   AND o."id" = s."order_id"
   AND o."line_device_limit" BETWEEN 1 AND 1000
   AND s."device_limit" IS NULL;
