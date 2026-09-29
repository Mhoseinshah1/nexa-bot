-- WP-A8: advanced provider settings.
--
-- panel_policies        one row per configured panel: which customer actions it offers,
--                       the extra cooldowns and per-purchase caps it adds, and how its
--                       services are delivered. No row means the default policy, so no
--                       existing panel changes behaviour when this migration runs.
-- role_permissions      backfills `panels.technical.view` (the Super Admin's read-only
--                       technical view) into the existing `owner` roles, below.
--
-- Numbered 0134: 0131 is WP-A10, 0132 WP-A5 and 0133 WP-A6, merged before it. First
-- written as 0133 on WP-A5's base and regenerated here with the same DDL.
CREATE TABLE "panel_policies" (
	"tenant_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"policy" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panel_policies_pk" PRIMARY KEY("tenant_id","panel_id"),
	CONSTRAINT "panel_policies_revision_check" CHECK (revision >= 1),
	CONSTRAINT "panel_policies_policy_check" CHECK (jsonb_typeof(policy) = 'object')
);
--> statement-breakpoint
ALTER TABLE "panel_policies" ADD CONSTRAINT "panel_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_policies" ADD CONSTRAINT "panel_policies_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill: `panels.technical.view` reaches the owner roles that already exist.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, and never
-- reasserts them (0109 states why). The key is NEW in this release, so no installation can
-- have withdrawn it; it is read-only, it shows no credential, and a DENY override still
-- beats it. `owner` is the only seed that holds it: the seed is every key, and it is HIGH,
-- so the LOW-only `observer` does not.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'panels.technical.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
