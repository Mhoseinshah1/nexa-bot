ALTER TABLE "tenants" ADD COLUMN "rules_first_enforced_at" timestamp with time zone;--> statement-breakpoint
-- Enforcement already effective today (flag on AND a published version): stamp it now, so the
-- customers who exist are not asked. Idempotent by the IS NULL; a tenant not enforcing yet is
-- stamped later by the write that makes it so.
UPDATE "tenants" t SET "rules_first_enforced_at" = now()
 WHERE t."rules_first_enforced_at" IS NULL
   AND EXISTS (SELECT 1 FROM "feature_flag_states" f
                WHERE f."tenant_id" = t."id" AND f."flag_key" = 'terms_enforcement' AND f."enabled")
   AND EXISTS (SELECT 1 FROM "terms_versions" v
                WHERE v."tenant_id" = t."id" AND v."status" = 'PUBLISHED');
