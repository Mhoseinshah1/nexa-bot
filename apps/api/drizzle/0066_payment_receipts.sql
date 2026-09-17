CREATE TABLE "payment_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_id" text NOT NULL,
	"file_unique_id" text NOT NULL,
	"mime_type" text,
	"file_size" bigint,
	"file_name" text,
	"telegram_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_receipts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_receipts_kind_check" CHECK (kind IN ('PHOTO', 'DOCUMENT')),
	CONSTRAINT "payment_receipts_size_check" CHECK (file_size IS NULL OR file_size > 0)
);
--> statement-breakpoint
CREATE TABLE "receipt_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "receipt_captures_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "receipt_captures_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('RECEIVED', 'SUPERSEDED', 'EXPIRED')),
	CONSTRAINT "receipt_captures_closed_check" CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
	CONSTRAINT "receipt_captures_expiry_check" CHECK (expires_at > opened_at)
);
--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_captures" ADD CONSTRAINT "receipt_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_captures" ADD CONSTRAINT "receipt_captures_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_captures" ADD CONSTRAINT "receipt_captures_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_captures" ADD CONSTRAINT "receipt_captures_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_receipts_file_key" ON "payment_receipts" USING btree ("tenant_id","payment_id","file_unique_id");--> statement-breakpoint
CREATE INDEX "payment_receipts_payment_idx" ON "payment_receipts" USING btree ("tenant_id","payment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_captures_open_key" ON "receipt_captures" USING btree ("tenant_id","bot_instance_id","customer_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "receipt_captures_due_idx" ON "receipt_captures" USING btree ("tenant_id","expires_at") WHERE closed_at IS NULL;