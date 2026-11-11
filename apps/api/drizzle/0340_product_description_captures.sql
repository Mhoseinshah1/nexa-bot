CREATE TABLE "product_description_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"captured_text" text,
	CONSTRAINT "product_description_captures_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('CAPTURED', 'EXPIRED', 'SUPERSEDED')),
	CONSTRAINT "product_description_captures_closed_check" CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
	CONSTRAINT "product_description_captures_expiry_check" CHECK (expires_at > opened_at),
	CONSTRAINT "product_description_captures_captured_check" CHECK ((close_reason = 'CAPTURED') = (captured_text IS NOT NULL)
          AND (captured_text IS NULL OR char_length(captured_text) BETWEEN 1 AND 2000))
);
--> statement-breakpoint
ALTER TABLE "product_description_captures" ADD CONSTRAINT "product_description_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_description_captures" ADD CONSTRAINT "product_description_captures_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_description_captures" ADD CONSTRAINT "product_description_captures_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_description_captures_open_key" ON "product_description_captures" USING btree ("tenant_id","admin_id") WHERE closed_at IS NULL;