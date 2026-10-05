-- TB8 (`docs/support-agent/tb8-controlled-learning.md`): the backfill of the three new
-- `support_knowledge.*` keys to the seeded roles that already exist (ROLE_SEEDS): `owner` holds
-- every key; `operator` and `support` read the knowledge and propose lessons; `observer` holds
-- every LOW key, so it reads them. Reviewing —
-- publishing what the support agent repeats to every customer — stays the owner's. Hand-written,
-- so no snapshot accompanies it.
--
-- The keys are NEW in this release, so no installation can have withdrawn them, and a DENY
-- override still beats this. Proposing creates a CANDIDATE, never knowledge.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'support_knowledge.view'),
        ('owner', 'support_knowledge.propose'),
        ('owner', 'support_knowledge.review'),
        ('operator', 'support_knowledge.view'),
        ('operator', 'support_knowledge.propose'),
        ('support', 'support_knowledge.view'),
        ('support', 'support_knowledge.propose'),
        ('observer', 'support_knowledge.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ADR-0035 §1: every body ever approved is kept, with its reviewer. An edit is a NEW revision;
-- nothing rewrites or removes an old one. The triggers fire for every role, the owner included.
CREATE TRIGGER support_knowledge_revisions_no_update
  BEFORE UPDATE ON support_knowledge_revisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER support_knowledge_revisions_no_delete
  BEFORE DELETE ON support_knowledge_revisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
