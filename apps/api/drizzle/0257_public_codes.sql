ALTER TABLE "orders" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "code_number" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_code_key" ON "orders" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_code_key" ON "payments" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_code_number_key" ON "products" USING btree ("tenant_id","code_number");--> statement-breakpoint
CREATE UNIQUE INDEX "services_tenant_code_key" ON "services" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_tenant_code_key" ON "tickets" USING btree ("tenant_id","code");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_code_number_check" CHECK (code_number IS NULL OR code_number > 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_code_check" CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$');