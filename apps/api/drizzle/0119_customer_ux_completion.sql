CREATE TABLE "customer_text_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"subject_id" uuid,
	"state" text DEFAULT 'AWAITING_TEXT' NOT NULL,
	"amount_minor" bigint,
	"amount_currency" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE')),
	CONSTRAINT "customer_text_captures_state_check" CHECK (state IN ('AWAITING_TEXT', 'AMOUNT_RECORDED')),
	CONSTRAINT "customer_text_captures_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('RECEIVED', 'SUPERSEDED', 'EXPIRED', 'CANCELLED')),
	CONSTRAINT "customer_text_captures_closed_check" CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
	CONSTRAINT "customer_text_captures_expiry_check" CHECK (expires_at > opened_at),
	CONSTRAINT "customer_text_captures_amount_currency_check" CHECK (amount_currency IS NULL OR amount_currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "customer_text_captures_amount_check" CHECK ((amount_minor IS NULL) = (amount_currency IS NULL) AND (amount_minor IS NULL OR amount_minor > 0)),
	CONSTRAINT "customer_text_captures_amount_state_check" CHECK ((state = 'AMOUNT_RECORDED') = (amount_minor IS NOT NULL)
          AND (amount_minor IS NULL OR purpose = 'TOPUP_AMOUNT')),
	CONSTRAINT "customer_text_captures_subject_check" CHECK ((purpose = 'SERVICE_NOTE') = (subject_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "referral_signup_gifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"referral_id" uuid NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referee_id" uuid NOT NULL,
	"total_amount" bigint NOT NULL,
	"referrer_amount" bigint NOT NULL,
	"referee_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"referrer_entry_id" uuid,
	"referee_entry_id" uuid,
	"referrer_claimed_at" timestamp with time zone,
	"referee_claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_signup_gifts_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "referral_signup_gifts_not_self_check" CHECK (referrer_id <> referee_id),
	CONSTRAINT "referral_signup_gifts_amounts_check" CHECK (total_amount >= 0 AND referrer_amount >= 0 AND referee_amount >= 0
          AND referrer_amount + referee_amount = total_amount),
	CONSTRAINT "referral_signup_gifts_referrer_claim_check" CHECK ((referrer_entry_id IS NULL) = (referrer_claimed_at IS NULL)),
	CONSTRAINT "referral_signup_gifts_referee_claim_check" CHECK ((referee_entry_id IS NULL) = (referee_claimed_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "support_faq_seeds" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_faqs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_faqs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_faqs_status_check" CHECK (status IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "support_faqs_question_check" CHECK (length(btrim(question)) BETWEEN 1 AND 300),
	CONSTRAINT "support_faqs_answer_check" CHECK (length(btrim(answer)) BETWEEN 1 AND 2000),
	CONSTRAINT "support_faqs_sort_order_check" CHECK (sort_order BETWEEN 0 AND 100000),
	CONSTRAINT "support_faqs_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "tenant_media_assets" (
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"mime_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_media_assets_pk" PRIMARY KEY("tenant_id","purpose"),
	CONSTRAINT "tenant_media_assets_purpose_check" CHECK (purpose IN ('REFERRAL_BANNER')),
	CONSTRAINT "tenant_media_assets_mime_check" CHECK (mime_type IN ('image/png', 'image/jpeg')),
	CONSTRAINT "tenant_media_assets_size_check" CHECK (byte_length BETWEEN 1 AND 1048576 AND byte_length = octet_length(content)),
	CONSTRAINT "tenant_media_assets_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tenant_media_assets_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "allow_service_purchase" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "allow_wallet_topup" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "display_locations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "display_features" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "service_location_label" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "last_seen_state" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "customer_note" text;--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_signup_gifts" ADD CONSTRAINT "referral_signup_gifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_signup_gifts" ADD CONSTRAINT "referral_signup_gifts_referral_fk" FOREIGN KEY ("tenant_id","referral_id") REFERENCES "public"."referrals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_signup_gifts" ADD CONSTRAINT "referral_signup_gifts_referrer_fk" FOREIGN KEY ("tenant_id","referrer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_signup_gifts" ADD CONSTRAINT "referral_signup_gifts_referee_fk" FOREIGN KEY ("tenant_id","referee_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_faq_seeds" ADD CONSTRAINT "support_faq_seeds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_faqs" ADD CONSTRAINT "support_faqs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_media_assets" ADD CONSTRAINT "tenant_media_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_text_captures_open_key" ON "customer_text_captures" USING btree ("tenant_id","bot_instance_id","customer_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "customer_text_captures_expiry_idx" ON "customer_text_captures" USING btree ("tenant_id","expires_at") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_signup_gifts_referral_key" ON "referral_signup_gifts" USING btree ("tenant_id","referral_id");--> statement-breakpoint
CREATE INDEX "referral_signup_gifts_referrer_idx" ON "referral_signup_gifts" USING btree ("tenant_id","referrer_id");--> statement-breakpoint
CREATE INDEX "referral_signup_gifts_referee_idx" ON "referral_signup_gifts" USING btree ("tenant_id","referee_id");--> statement-breakpoint
CREATE INDEX "support_faqs_tenant_sort_idx" ON "support_faqs" USING btree ("tenant_id","sort_order","created_at","id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_display_lists_check" CHECK (jsonb_typeof(display_locations) = 'array' AND jsonb_typeof(display_features) = 'array');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_service_location_label_check" CHECK (service_location_label IS NULL OR length(btrim(service_location_label)) BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_last_seen_state_check" CHECK (last_seen_state IS NULL OR last_seen_state IN ('AT', 'NEVER'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_last_seen_pair_check" CHECK ((last_seen_state IS NOT DISTINCT FROM 'AT') = (last_seen_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_customer_note_check" CHECK (customer_note IS NULL OR length(btrim(customer_note)) BETWEEN 1 AND 200);