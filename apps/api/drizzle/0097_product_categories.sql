CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"emoji" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"visibility" text DEFAULT 'VISIBLE' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_categories_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_categories_status_check" CHECK (status IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "product_categories_visibility_check" CHECK (visibility IN ('VISIBLE', 'HIDDEN')),
	CONSTRAINT "product_categories_name_check" CHECK (length(name) > 0 AND length(name) <= 120),
	CONSTRAINT "product_categories_emoji_check" CHECK (emoji IS NULL OR (
        length(emoji) > 0
        AND length(emoji) <= 8
        AND btrim(emoji) <> ''
        AND emoji !~ U&'[\0001-\001f\007f\0085\2028\2029]'
      )),
	CONSTRAINT "product_categories_sort_check" CHECK (sort_order >= 0 AND sort_order <= 100000)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "line_category_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "line_category_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "line_category_emoji" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_categories_tenant_sort_idx" ON "product_categories" USING btree ("tenant_id","sort_order","created_at","id");--> statement-breakpoint
CREATE INDEX "product_categories_tenant_created_idx" ON "product_categories" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_tenant_category_sort_idx" ON "products" USING btree ("tenant_id","category_id","sort_order","created_at","id");--> statement-breakpoint
--
-- The backfill. Products get a category; ORDERS DELIBERATELY DO NOT.
--
-- Every product must belong to exactly one category, so every tenant that already has
-- products gets one category and every one of its products is put in it. A tenant with
-- no products gets nothing: a category nobody can see is noise in an operator's list,
-- and the first category such a tenant needs is one they create themselves.
--
-- The name is a starting value for TENANT DATA, not surface text, which is why it is a
-- literal here and not a template key. A category's name is the operator's own words in
-- exactly the way a product's title is — both are rendered as data and neither is
-- translated — and the operator renames this one from either admin surface. What would
-- have been wrong is a name the operator CANNOT change, and this is not that.
--
-- `gen_random_uuid()` rather than the application's UUIDv7, for the same reason
-- migration 0045 uses it: a backfill has no application to ask, and these ids are never
-- ordered by.
--
-- One statement, and a CTE rather than two, so the UPDATE is joined to the rows this
-- migration actually INSERTED rather than to whatever categories the tenant happens to
-- have. Today those are the same set — nothing else can be creating categories inside a
-- migration's transaction — but a join on `tenant_id` alone would stop being correct
-- the moment this file is read as a template for a later backfill.
WITH created AS (
  INSERT INTO "product_categories" ("id", "tenant_id", "name", "status", "visibility", "sort_order")
  SELECT gen_random_uuid(), p."tenant_id", 'عمومی', 'ACTIVE', 'VISIBLE', 0
  FROM (SELECT DISTINCT "tenant_id" FROM "products") AS p
  RETURNING "id", "tenant_id"
)
UPDATE "products" AS pr
SET "category_id" = created."id"
FROM created
WHERE created."tenant_id" = pr."tenant_id" AND pr."category_id" IS NULL;
--
-- `orders` is not mentioned above, and that absence is the point.
--
-- The three `line_category_*` columns stay NULL on every order that already exists. A
-- product's category TODAY is not evidence of what a customer browsed when they bought
-- it, so filling those columns from `products.category_id` would write a guess into a
-- row whose entire purpose is to be a record. NULL there means UNKNOWN, and a surface
-- that renders it must say so rather than join its way to a plausible answer.
--
