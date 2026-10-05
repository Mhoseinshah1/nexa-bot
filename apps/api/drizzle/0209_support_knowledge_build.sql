CREATE TABLE "support_knowledge_build_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_hash" text NOT NULL,
	"article_id" uuid,
	"base_revision" integer,
	"base_title" text,
	"base_body" text,
	"resolution" text,
	"decided_by_admin_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_knowledge_build_proposals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_knowledge_build_proposals_source_type_check" CHECK (source_type IN ('PRODUCT', 'LOCATIONS', 'CLIENT_APP', 'TUTORIAL', 'FAQ', 'TERMS', 'SUPPORT_ACCOUNTS', 'PAYMENT_METHOD')),
	CONSTRAINT "support_knowledge_build_proposals_kind_check" CHECK (kind IN ('ADD', 'UPDATE', 'UNCHANGED', 'CONFLICT', 'RETIRE')),
	CONSTRAINT "support_knowledge_build_proposals_state_check" CHECK (state IN ('PENDING', 'APPLIED', 'SKIPPED')),
	CONSTRAINT "support_knowledge_build_proposals_category_check" CHECK (category IN ('CONNECTION', 'APPS', 'PLANS', 'PAYMENTS', 'ACCOUNT', 'POLICY', 'GENERAL')),
	CONSTRAINT "support_knowledge_build_proposals_resolution_check" CHECK (resolution IS NULL OR resolution IN ('TAKE_BUILD', 'KEEP_CURRENT')),
	CONSTRAINT "support_knowledge_build_proposals_article_check" CHECK ((kind = 'ADD') = (article_id IS NULL) AND (article_id IS NULL) = (base_revision IS NULL)),
	CONSTRAINT "support_knowledge_build_proposals_unchanged_check" CHECK (kind <> 'UNCHANGED' OR state = 'SKIPPED'),
	CONSTRAINT "support_knowledge_build_proposals_resolution_shape_check" CHECK (resolution IS NULL OR kind = 'CONFLICT'),
	CONSTRAINT "support_knowledge_build_proposals_text_check" CHECK (length(btrim(title)) BETWEEN 1 AND 200 AND length(btrim(body)) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "support_knowledge_builds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"created_by_admin_id" uuid,
	"add_count" integer DEFAULT 0 NOT NULL,
	"update_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"retire_count" integer DEFAULT 0 NOT NULL,
	"truncated_count" integer DEFAULT 0 NOT NULL,
	"capped_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_knowledge_builds_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_knowledge_builds_state_check" CHECK (state IN ('OPEN', 'SUPERSEDED')),
	CONSTRAINT "support_knowledge_builds_counts_check" CHECK (add_count >= 0 AND update_count >= 0 AND unchanged_count >= 0 AND conflict_count >= 0
          AND retire_count >= 0 AND truncated_count >= 0 AND capped_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD COLUMN "built_revision" integer;--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD COLUMN "built_hash" text;--> statement-breakpoint
ALTER TABLE "support_knowledge_build_proposals" ADD CONSTRAINT "support_knowledge_build_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_build_proposals" ADD CONSTRAINT "support_knowledge_build_proposals_build_fk" FOREIGN KEY ("tenant_id","build_id") REFERENCES "public"."support_knowledge_builds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_build_proposals" ADD CONSTRAINT "support_knowledge_build_proposals_article_fk" FOREIGN KEY ("tenant_id","article_id") REFERENCES "public"."support_knowledge_articles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_build_proposals" ADD CONSTRAINT "support_knowledge_build_proposals_admin_fk" FOREIGN KEY ("tenant_id","decided_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_builds" ADD CONSTRAINT "support_knowledge_builds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_builds" ADD CONSTRAINT "support_knowledge_builds_admin_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_knowledge_build_proposals_source_key" ON "support_knowledge_build_proposals" USING btree ("tenant_id","build_id","source_type","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "support_knowledge_builds_open_key" ON "support_knowledge_builds" USING btree ("tenant_id") WHERE state = 'OPEN';--> statement-breakpoint
CREATE INDEX "support_knowledge_builds_recent_idx" ON "support_knowledge_builds" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_knowledge_articles_source_key" ON "support_knowledge_articles" USING btree ("tenant_id","source_type","source_key") WHERE source_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD CONSTRAINT "support_knowledge_articles_source_type_check" CHECK (source_type IS NULL OR source_type IN ('PRODUCT', 'LOCATIONS', 'CLIENT_APP', 'TUTORIAL', 'FAQ', 'TERMS', 'SUPPORT_ACCOUNTS', 'PAYMENT_METHOD'));--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD CONSTRAINT "support_knowledge_articles_built_check" CHECK ((source = 'NEXA_BUILD') = (source_type IS NOT NULL)
          AND (source_type IS NULL) = (source_key IS NULL)
          AND (source_type IS NULL) = (built_revision IS NULL)
          AND (source_type IS NULL) = (built_hash IS NULL));