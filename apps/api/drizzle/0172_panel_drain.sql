-- Phase C2: panel drain.
--
-- panels.drained_at / drain_reason  an operator's "no new allocations here", its own
--                                   column rather than a status (DISABLED stops
--                                   monitoring and operations; a drained panel keeps
--                                   both). NULL on every existing panel, so nothing
--                                   changes behaviour when this runs.
-- role_permissions                  backfills `panels.drain` into the existing owner
--                                   and technical system roles, below.
--
-- Numbered 0165 on its branch, renumbered 0172 at merge. The
-- hand-written backfill is the separated tail after the generated DDL.
ALTER TABLE "panels" ADD COLUMN "drained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "drain_reason" text;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_drain_reason_check" CHECK (("panels"."drained_at" IS NULL) = ("panels"."drain_reason" IS NULL));--> statement-breakpoint
-- Backfill (hand-written): `panels.drain` reaches the system roles that already exist.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role (0109
-- states why). The key is NEW in this release, so no installation can have withdrawn it,
-- and a DENY override still beats it. `owner` holds every key; `technical` is the role
-- that operates panels during an incident.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'panels.drain'),
        ('technical', 'panels.drain')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
