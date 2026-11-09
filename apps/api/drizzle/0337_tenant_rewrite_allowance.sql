-- Phase 6B (ADR-0039 § 4, § 10): the TENANT REWRITE ALLOWANCE, the piece of the erasure
-- design this phase builds, for REPLACE — restoring a hosted archive over the SAME tenant.
--
-- A replace deletes the tenant's rows (children first) and inserts the archive's in ONE
-- transaction, and compares them with the verified scratch before it commits. Every
-- append-only guard that fires on DELETE refuses that today. Each one gains ONE branch, at
-- its top, that returns OLD for a DELETE when `nexa_tenant_rewrite_permits(<the row's
-- tenant>)` is true, and is otherwise byte-for-byte what it was. UPDATE stays refused.
--
-- `nexa_tenant_rewrite_permits` is SECURITY INVOKER, so `current_user` in it is the role
-- that made the statement: it requires `nexa_system` (the system path), the replace's own
-- literal reason bound in `app.system_reason`, and only then asks
-- `nexa_tenant_rewrite_allowed`, the SECURITY DEFINER lookup of the authority row: a
-- `tenant_restores` row named by `nexa.tenant_rewrite`, mode REPLACE, APPLYING, for exactly
-- that tenant, whose `rewrite_xact_id` is the CURRENT transaction's id. The lookup is owned
-- by the migration owner (who can read `tenant_restores` past row-level security), its
-- search_path is pinned, EXECUTE is revoked from PUBLIC and granted to nexa_system only.
--
-- Guards that fire only on INSERT or UPDATE cannot see a DELETE and are unchanged. The one
-- DELETE trigger that is not a guard of history, `nexa_require_active_owner` (a constraint
-- trigger, INITIALLY DEFERRED), keeps refusing: a replace must commit with an active owner.
--
-- `hosted_bots_owner_admin_fk` (the owner's register naming the hosted tenant's owner admin)
-- becomes DEFERRABLE INITIALLY IMMEDIATE: unchanged for every statement but the replace, which
-- defers it so the register may name the archive's owner admin once it is reinserted; it is
-- still checked at commit.

CREATE OR REPLACE FUNCTION nexa_tenant_rewrite_allowed(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tenant_restores AS r
     WHERE r.id = CASE
                    WHEN coalesce(current_setting('nexa.tenant_rewrite', true), '')
                         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN current_setting('nexa.tenant_rewrite', true)::uuid
                  END
       AND r.mode = 'REPLACE'
       AND r.state = 'APPLYING'
       AND r.hosted_tenant_id = p_tenant
       AND r.rewrite_xact_id = (pg_current_xact_id()::text)::bigint
  );
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION nexa_tenant_rewrite_allowed(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexa_system') THEN
    GRANT EXECUTE ON FUNCTION nexa_tenant_rewrite_allowed(uuid) TO nexa_system;
  END IF;
END
$grant$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_tenant_rewrite_permits(p_tenant uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  -- Nested, never one AND: SQL does not promise the order, and the lookup must not even be
  -- called by a role that is not the system path.
  IF p_tenant IS NULL THEN
    RETURN false;
  END IF;
  IF current_user <> 'nexa_system' THEN
    RETURN false;
  END IF;
  IF coalesce(current_setting('app.system_reason', true), '')
     <> 'tenant archive: replace a hosted tenant''s rows' THEN
    RETURN false;
  END IF;
  RETURN public.nexa_tenant_rewrite_allowed(p_tenant);
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rewrite_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- `processed_messages` has no tenant: its rows are the tenant's through their message.
    IF TG_TABLE_NAME = 'processed_messages' THEN
      SELECT o.tenant_id INTO rewrite_tenant
        FROM outbox_messages AS o
       WHERE o.id = (to_jsonb(OLD) ->> 'message_id')::uuid;
    ELSE
      rewrite_tenant := (to_jsonb(OLD) ->> 'tenant_id')::uuid;
    END IF;
    IF nexa_tenant_rewrite_permits(rewrite_tenant) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_gateway_invoice_cards_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'gateway_invoice_cards is append-only: a card a customer was shown is never changed or removed.'
    USING ERRCODE = 'restrict_violation';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_legacy_cleanup_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  run_id text := current_setting('nexa.legacy_compaction_run', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF run_id IS NOT NULL AND run_id <> '' AND EXISTS (
       SELECT 1 FROM legacy_compaction_runs AS run
        WHERE run.id = run_id::uuid
          AND run.tenant_id = OLD.tenant_id
          AND run.state = 'CLEARING') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_legacy_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  run_id text := current_setting('nexa.legacy_compaction_run', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF run_id IS NOT NULL AND run_id <> '' AND EXISTS (
       SELECT 1 FROM legacy_compaction_runs AS run
        WHERE run.id = run_id::uuid
          AND run.tenant_id = OLD.tenant_id
          AND run.state IN ('DROPPING', 'DEDUPING', 'STRIPPING')) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.nxpkg_import_id IS DISTINCT FROM OLD.nxpkg_import_id
       OR NEW.package_import_id IS DISTINCT FROM OLD.package_import_id
       OR NEW.record_type IS DISTINCT FROM OLD.record_type
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.legacy_user_id IS DISTINCT FROM OLD.legacy_user_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A legacy compaction may change a history record''s payload only.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_notification_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  run_id text := current_setting('nexa.data_compaction_run', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND run_id IS NOT NULL AND run_id <> '' AND EXISTS (
       SELECT 1 FROM data_compaction_runs AS run
        WHERE run.id = run_id::uuid
          AND run.tenant_id = OLD.tenant_id
          AND run.state = 'RUNNING'
          AND run.mode = 'APPLY')
     AND EXISTS (
       SELECT 1 FROM notifications AS n
        WHERE n.tenant_id = OLD.tenant_id
          AND n.id = OLD.notification_id
          AND n.status <> 'PENDING') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_order_cashback_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'order_cashback rows are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
     OR NEW.rule_label IS DISTINCT FROM OLD.rule_label
     OR NEW.percent IS DISTINCT FROM OLD.percent
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the terms of an order''s cashback are frozen once promised'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'an order''s cashback that is % does not change again', OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.state NOT IN ('EARNED', 'VOID') THEN
    RAISE EXCEPTION 'an order''s cashback moves from PENDING to EARNED or VOID, not to %', NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_order_custom_service_terms_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION
    'order_custom_service_terms for order % are frozen', OLD.order_id
    USING ERRCODE = 'raise_exception';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_order_referral_commission_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'order_referral_commissions rows are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.referral_id IS DISTINCT FROM OLD.referral_id
     OR NEW.referrer_id IS DISTINCT FROM OLD.referrer_id
     OR NEW.referee_id IS DISTINCT FROM OLD.referee_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.percent IS DISTINCT FROM OLD.percent
     OR NEW.basis_amount IS DISTINCT FROM OLD.basis_amount
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the terms of a referral commission are frozen once promised'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a referral commission that is % does not change again', OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- R10 D5: the deferral. PENDING stays PENDING, and only the hold moves.
  IF NEW.state = 'PENDING' THEN
    IF NEW.earned_amount IS DISTINCT FROM OLD.earned_amount
       OR NEW.earned_entry_id IS DISTINCT FROM OLD.earned_entry_id
       OR NEW.earned_at IS DISTINCT FROM OLD.earned_at
       OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
       OR NEW.not_before IS NULL THEN
      RAISE EXCEPTION 'a pending referral commission changes only its not_before while it stays pending'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state NOT IN ('EARNED', 'VOID') THEN
    RAISE EXCEPTION 'a referral commission moves from PENDING to EARNED or VOID, not to %', NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_product_referenced_never_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM orders o WHERE o.tenant_id = OLD.tenant_id AND o.product_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM services s WHERE s.tenant_id = OLD.tenant_id AND s.product_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'product % is referenced by an order or a service and can never be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_protect_system_role()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF OLD.is_system THEN
    RAISE EXCEPTION 'role % is a system role and cannot be deleted', OLD.key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_terms_version_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION
      'A published terms version is immutable; % is not permitted.', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION
      'A terms version keeps its identity.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
-- Phase 6B PR-5's HOST principal (0335): a replace deletes it with the tenant's other admins
-- (and reinserts it when the archive carries it); outside the run it stays undeletable.
CREATE OR REPLACE FUNCTION nexa_host_admin_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nexa_tenant_rewrite_permits(OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.kind = 'HOST' THEN
      RAISE EXCEPTION 'The host principal of a hosted tenant cannot be deleted.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.kind = 'HOST' OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'The host principal of a hosted tenant cannot be changed.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER TABLE hosted_bots ALTER CONSTRAINT hosted_bots_owner_admin_fk DEFERRABLE INITIALLY IMMEDIATE;
