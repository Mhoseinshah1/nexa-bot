CREATE TABLE "installation_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"wrapped_material" text NOT NULL,
	"wrapped_under_key_id" text NOT NULL,
	"source" text NOT NULL,
	"kit_id" uuid,
	"imported_at" timestamp with time zone NOT NULL,
	"imported_by_admin_id" uuid,
	"imported_by_label" text,
	CONSTRAINT "installation_keys_source_check" CHECK (source IN ('RECOVERY_KIT')),
	CONSTRAINT "installation_keys_key_id_check" CHECK (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
	CONSTRAINT "installation_keys_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "installation_keys_wrapped_under_check" CHECK (wrapped_under_key_id ~ '^[A-Za-z0-9._-]{1,64}$' AND wrapped_under_key_id <> key_id)
);
--> statement-breakpoint
ALTER TABLE "recovery_requests" DROP CONSTRAINT "recovery_requests_failure_code_check";--> statement-breakpoint
CREATE UNIQUE INDEX "installation_keys_key_id_idx" ON "installation_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "installation_keys_wrapped_under_idx" ON "installation_keys" USING btree ("wrapped_under_key_id");--> statement-breakpoint
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_failure_code_check" CHECK (failure_code IS NULL OR failure_code IN ('recovery.upload_rejected', 'recovery.archive_malformed', 'recovery.archive_auth_failed', 'recovery.archive_foreign_key', 'recovery.checksum_mismatch', 'recovery.manifest_invalid', 'recovery.restore_test_failed', 'recovery.restored_database_empty', 'recovery.migration_state_unreadable', 'recovery.migration_incompatible', 'recovery.confirmation_invalid', 'recovery.emergency_backup_failed', 'recovery.emergency_backup_busy', 'recovery.quiesce_failed', 'recovery.candidate_create_failed', 'recovery.candidate_restore_failed', 'recovery.candidate_validation_failed', 'recovery.cutover_failed', 'recovery.readiness_failed', 'recovery.lease_expired', 'recovery.candidate_keys_missing', 'recovery.internal'));--> statement-breakpoint
-- Backfill: the Recovery Kit's three permissions reach the system owner roles that already exist.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, so a key newly
-- added to a seeded role reaches an existing installation only through a migration. All three keys
-- are NEW in this release: no installation can have withdrawn any of them, so this deletes nothing
-- and replaces nothing, and a DENY override still beats it because resolution subtracts DENY last.
-- All three are CRITICAL, so they reach the owner alone.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill coverage guard
-- reads the PAIRS out of this statement.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'recovery.kit.export'),
        ('owner', 'recovery.kit.import'),
        ('owner', 'recovery.key.remove')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
