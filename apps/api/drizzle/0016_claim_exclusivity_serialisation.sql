-- 0014's guards did not hold between concurrent transactions.
--
-- Both trigger functions decide with `IF EXISTS (SELECT ...)`. Under READ
-- COMMITTED — PostgreSQL's default, and what this application runs — a
-- statement sees only rows committed before it started. Two transactions that
-- have each inserted but not committed are invisible to one another, so both
-- EXISTS checks find nothing and both inserts are allowed.
--
-- Reproduced against a real database before this migration was written:
--
--   T1: BEGIN; INSERT attempt (n, 1)          -- trigger sees no release
--   T2: BEGIN; INSERT release (n, 1)          -- trigger sees no attempt
--   T1: COMMIT;  T2: COMMIT;
--   => attempts = 1, releases = 1
--
-- That is precisely the state 0014 exists to prevent: the message reached the
-- transport AND its allowance was handed back, so a bounded retry becomes an
-- unbounded one. The guards were sound against sequential writers and silent
-- against simultaneous ones, which is the harder case and the one a dispatcher
-- with more than one worker will eventually produce.
--
-- The fix is to make the two inserts contend for the same lock before either
-- looks. `pg_advisory_xact_lock` is transaction-scoped: it is taken inside the
-- trigger, held until COMMIT or ROLLBACK, and cannot be leaked by a crash
-- between statements. The second transaction blocks until the first finishes,
-- and its EXISTS then sees a committed row and refuses.
--
-- The key is derived identically in both functions from the triple that
-- defines the claim, so an attempt and a release for the SAME attempt number
-- serialise and everything else proceeds in parallel. A hash collision between
-- two unrelated triples costs a brief wait, never a wrong answer.
--
-- Why not a constraint: the invariant spans two tables, which no unique index
-- or CHECK in PostgreSQL can express. Serialising the writers is the mechanism
-- the database does offer, and it is the one the guarantee now rests on.

CREATE OR REPLACE FUNCTION nexa_claim_lock_key(
  p_tenant uuid, p_notification uuid, p_attempt integer
) RETURNS bigint AS $$
  SELECT hashtextextended(
    p_tenant::text || ':' || p_notification::text || ':' || p_attempt::text, 0
  );
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION nexa_reject_attempt_over_release() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    nexa_claim_lock_key(NEW.tenant_id, NEW.notification_id, NEW.attempt_number)
  );

  IF EXISTS (
    SELECT 1
      FROM notification_released_claims r
     WHERE r.tenant_id = NEW.tenant_id
       AND r.notification_id = NEW.notification_id
       AND r.attempt_number = NEW.attempt_number
  ) THEN
    RAISE EXCEPTION
      'Attempt % of notification % was released; a returned claim never reached the transport.',
      NEW.attempt_number, NEW.notification_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION nexa_reject_release_over_attempt() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    nexa_claim_lock_key(NEW.tenant_id, NEW.notification_id, NEW.attempt_number)
  );

  IF EXISTS (
    SELECT 1
      FROM notification_delivery_attempts a
     WHERE a.tenant_id = NEW.tenant_id
       AND a.notification_id = NEW.notification_id
       AND a.attempt_number = NEW.attempt_number
       -- Everything except the sweep withdrawing its own bookkeeping row.
       AND NOT (
         NEW.reason = 'sweep.withdrawn'
         AND a.outcome = 'FAILED_PERMANENT'
         AND a.error_code = 'notification.attempts_exhausted'
       )
  ) THEN
    RAISE EXCEPTION
      'Attempt % of notification % reached the transport; its claim cannot be returned.',
      NEW.attempt_number, NEW.notification_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
