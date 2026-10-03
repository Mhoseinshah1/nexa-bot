CREATE TABLE "legacy_product_shapes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shape_key" text NOT NULL,
	"legacy_code_panel" text,
	"traffic_bytes" bigint NOT NULL,
	"duration_days" integer NOT NULL,
	"is_custom" boolean NOT NULL,
	"product_id" uuid NOT NULL,
	"tariff_status" text DEFAULT 'UNRESOLVED' NOT NULL,
	"unresolved_reason" text DEFAULT 'NOT_YET_RESOLVED',
	"resolution" text,
	"tariff_source_product_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_product_shapes_tariff_status_check" CHECK (tariff_status IN ('UNRESOLVED', 'RESOLVED')),
	CONSTRAINT "legacy_product_shapes_unresolved_reason_check" CHECK (unresolved_reason IS NULL OR unresolved_reason IN ('NOT_YET_RESOLVED', 'NO_CURRENT_TARIFF', 'AMBIGUOUS_TARIFF')),
	CONSTRAINT "legacy_product_shapes_resolution_check" CHECK (resolution IS NULL OR resolution IN ('MATCHED_PUBLIC_PRODUCT', 'OPERATOR_STATED')),
	CONSTRAINT "legacy_product_shapes_state_check" CHECK ((tariff_status = 'UNRESOLVED'
            AND unresolved_reason IS NOT NULL AND resolution IS NULL
            AND resolved_at IS NULL AND tariff_source_product_id IS NULL)
       OR (tariff_status = 'RESOLVED'
            AND unresolved_reason IS NULL AND resolution IS NOT NULL AND resolved_at IS NOT NULL
            AND (resolution = 'MATCHED_PUBLIC_PRODUCT') = (tariff_source_product_id IS NOT NULL))),
	CONSTRAINT "legacy_product_shapes_amounts_check" CHECK (traffic_bytes > 0 AND duration_days > 0 AND duration_days <= 3650),
	CONSTRAINT "legacy_product_shapes_key_check" CHECK (length(shape_key) BETWEEN 1 AND 512 AND (legacy_code_panel IS NULL OR length(btrim(legacy_code_panel)) > 0))
);
--> statement-breakpoint
ALTER TABLE "legacy_product_shapes" ADD CONSTRAINT "legacy_product_shapes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_product_shapes" ADD CONSTRAINT "legacy_product_shapes_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_product_shapes" ADD CONSTRAINT "legacy_product_shapes_source_fk" FOREIGN KEY ("tenant_id","tariff_source_product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_product_shapes_tenant_key" ON "legacy_product_shapes" USING btree ("tenant_id","shape_key");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_product_shapes_tenant_product_key" ON "legacy_product_shapes" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "legacy_product_shapes_tenant_status_idx" ON "legacy_product_shapes" USING btree ("tenant_id","tariff_status","id");