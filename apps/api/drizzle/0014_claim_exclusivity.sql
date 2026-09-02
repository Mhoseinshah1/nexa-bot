-- An attempt number is EITHER spent or returned, never both.
--
-- Split from any generated migration for the reason 0011 and 0013 give:
-- `drizzle-kit` regenerates table migrations from `schema.ts` and would drop
-- anything hand-written in them. Triggers live here, where it does not look.
--
-- The ownership model states this and nothing enforced it. Spend is
-- `attempt_count` minus the released rows, so a number carrying both records
-- counts as returned while its attempt row says it reached the transport: the
-- message was sent and its allowance was handed back anyway, which is how a
-- bounded retry becomes an unbounded one. `releaseClaim` guards its own insert
-- with `NOT EXISTS` against the attempts table; `recordAttempt` had no mirror
-- guard, and neither statement is serialised against the other — the only
-- `FOR UPDATE` in the repository is in `claimDue` and `failExhausted`.
--
-- It is unreachable through the dispatcher today: one worker owns a claim, and
-- it either sends on that number or hands it back. That is an argument about
-- how the caller behaves, and it was the whole guarantee. Both tables are
-- append-only, so the database can hold this instead.
--
-- THE ONE PERMITTED PAIR is the sweep's own withdrawal. `failExhausted` writes
-- a synthetic FAILED_PERMANENT attempt at `attempt_count + 1` to record the
-- verdict it reached; when a hand-back later withdraws that verdict,
-- `releaseClaim` retires that number by recording it released, because nothing
-- was ever sent on it. Both halves of that pair are deliberate and the
-- exception is written narrowly enough to say so: the release must name itself
-- `sweep.withdrawn` AND the attempt row it sits on must actually be a sweep
-- verdict. Any other overlap is refused.

CREATE OR REPLACE FUNCTION nexa_reject_attempt_over_release() RETURNS trigger AS $$
BEGIN
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
--> statement-breakpoint

CREATE TRIGGER notification_delivery_attempts_not_released
  BEFORE INSERT ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_attempt_over_release();
--> statement-breakpoint

CREATE TRIGGER notification_released_claims_not_attempted
  BEFORE INSERT ON notification_released_claims
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_release_over_attempt();
