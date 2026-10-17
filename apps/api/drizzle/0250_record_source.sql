ALTER TABLE "orders" DROP CONSTRAINT "orders_origin_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_evidence_kind_check";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "resellers" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "source" text DEFAULT 'NEXA' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "source_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_source_ref_key" ON "customers" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_tenant_source_ref_key" ON "discounts" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_source_ref_key" ON "orders" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_source_ref_key" ON "payments" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_source_ref_key" ON "products" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_tenant_source_ref_key" ON "referrals" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resellers_tenant_source_ref_key" ON "resellers" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "services_tenant_source_ref_key" ON "services" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_tenant_source_ref_key" ON "ticket_messages" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_tenant_source_ref_key" ON "tickets" USING btree ("tenant_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_legacy_history_shape_check" CHECK (origin <> 'LEGACY_HISTORY' OR (source = 'MIRZA' AND discount_code IS NULL
          AND state IN ('PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED')));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_origin_check" CHECK (origin IN ('STANDARD', 'LEGACY_ADOPTION', 'LEGACY_HISTORY'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_legacy_import_source_check" CHECK (evidence_kind IS DISTINCT FROM 'LEGACY_IMPORT' OR source = 'MIRZA');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_evidence_kind_check" CHECK (evidence_kind IS NULL OR evidence_kind IN ('OPERATOR_REVIEW', 'WALLET_DEBIT', 'GATEWAY_CALLBACK', 'RECONCILIATION', 'GATEWAY_INQUIRY', 'LEGACY_IMPORT'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_source_check" CHECK (source IN ('NEXA', 'MIRZA'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_source_ref_check" CHECK ((source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128));