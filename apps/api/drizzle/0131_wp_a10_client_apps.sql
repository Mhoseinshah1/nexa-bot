CREATE TABLE "client_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"description" text NOT NULL,
	"official_url" text NOT NULL,
	"alternative_url" text,
	"help_url" text,
	"guide" text NOT NULL,
	"delivery_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"protocols" text[] DEFAULT '{}'::text[] NOT NULL,
	"provider_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'ENABLED' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_apps_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "client_apps_platform_check" CHECK (platform IN ('ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX', 'OTHER')),
	CONSTRAINT "client_apps_status_check" CHECK (status IN ('ENABLED', 'DISABLED')),
	CONSTRAINT "client_apps_name_check" CHECK (length(btrim(name)) BETWEEN 1 AND 64),
	CONSTRAINT "client_apps_icon_check" CHECK (icon IS NULL OR length(btrim(icon)) BETWEEN 1 AND 16),
	CONSTRAINT "client_apps_description_check" CHECK (length(btrim(description)) BETWEEN 1 AND 300),
	CONSTRAINT "client_apps_guide_check" CHECK (length(btrim(guide)) BETWEEN 1 AND 2500),
	CONSTRAINT "client_apps_urls_check" CHECK (official_url LIKE 'https://%' AND length(official_url) <= 2048
          AND (alternative_url IS NULL OR (alternative_url LIKE 'https://%' AND length(alternative_url) <= 2048))
          AND (help_url IS NULL OR (help_url LIKE 'https://%' AND length(help_url) <= 2048))),
	CONSTRAINT "client_apps_delivery_kinds_check" CHECK (delivery_kinds <@ ARRAY['SUBSCRIPTION_LINK', 'CONNECTION_FILES']::text[]),
	CONSTRAINT "client_apps_protocols_check" CHECK (protocols <@ ARRAY['vless', 'vmess', 'trojan', 'shadowsocks']::text[]),
	CONSTRAINT "client_apps_provider_types_check" CHECK (provider_types <@ ARRAY['marzban', 'rickpanel', 'sanaei']::text[]),
	CONSTRAINT "client_apps_sort_order_check" CHECK (sort_order BETWEEN 0 AND 100000),
	CONSTRAINT "client_apps_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "client_apps" ADD CONSTRAINT "client_apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_apps_tenant_platform_idx" ON "client_apps" USING btree ("tenant_id","platform","status","sort_order","created_at","id");--> statement-breakpoint
-- Backfill: `client_apps.view` and `client_apps.edit` reach the roles that already exist.
--
-- Hand-written and appended to the generated table migration so WP-A10 stays ONE
-- migration; `drizzle-kit` generates from `schema.ts` and does not look at data, so this
-- statement changes no snapshot and the drift check has nothing to compare.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, and never
-- reasserts them, so a key newly added to a seeded role reaches an installation whose role
-- already exists only through a migration like this one (0104 and 0109 are the worked
-- examples).
--
-- Both keys are NEW in this release, so no installation can have withdrawn either from any
-- role. This deletes nothing and replaces nothing, touches neither `admin_roles` nor
-- `admin_permission_overrides`, and a DENY override still beats it, because resolution
-- subtracts DENY last. `owner` holds every key and `observer` every LOW one by construction.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill coverage
-- guard reads the PAIRS out of this statement.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'client_apps.view'),
        ('owner', 'client_apps.edit'),
        ('observer', 'client_apps.view'),
        ('operator', 'client_apps.view'),
        ('operator', 'client_apps.edit'),
        ('support', 'client_apps.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
