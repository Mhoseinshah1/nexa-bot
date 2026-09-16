-- Two guards that protect a PAID commercial action from a release that predates
-- it, and they are in the DATABASE rather than in code because that is the only
-- place a previous binary can be reached from.
--
-- `botctl rollback` never restores the database — CLAUDE.md states that as a
-- rule, and it is what makes this work: after a rollback to the release before
-- this one, the old code is running against a schema that still carries these
-- triggers. The expand/contract discipline says the same thing from the other
-- side: a release that starts writing a shape must not be the first release that
-- can read it, and when it has to be, the shape itself has to refuse the reader
-- that would misread it.

-- 1. No service may be created for an order that is not a purchase.
--
-- `PaymentService` before this release ends in an unconditional
-- `planForSettledOrder`, which creates a service and a PROVISION from the order
-- line. A renewal is a NEW order against an EXISTING service, so that path would
-- provision a SECOND provider account the customer neither asked for nor paid
-- for — and `services_tenant_order_key` does not catch it, because a renewal has
-- its own order id.
--
-- Reachable two ways, and neither is hypothetical: a one-release rollback with
-- commercial orders already in `AWAITING_PAYMENT`, and an old API replica still
-- serving requests during the update itself. `orders.purpose` defaults to
-- `NEW_SERVICE`, which protects old WRITERS and does nothing for old readers.
--
-- Raising aborts the settling transaction, so the money does not move either:
-- the order stays `AWAITING_PAYMENT` and the customer can pay once the new
-- release is back. A refused settlement is recoverable; a second account the
-- customer is billed for is not.
CREATE OR REPLACE FUNCTION nexa_service_requires_purchase_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_purpose text;
BEGIN
  SELECT purpose INTO order_purpose
    FROM orders
   WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF order_purpose IS NOT NULL AND order_purpose <> 'NEW_SERVICE' THEN
    RAISE EXCEPTION
      'order % is a % and cannot produce a service', NEW.order_id, order_purpose
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER nexa_services_require_purchase_order
  BEFORE INSERT ON services
  FOR EACH ROW EXECUTE FUNCTION nexa_service_requires_purchase_order();
--> statement-breakpoint

-- 2. No commercial operation may be ABANDONED before its attempts are spent.
--
-- The provisioner before this release refuses an operation type it cannot
-- perform by transitioning it `IN_FLIGHT -> ABANDONED`, which is TERMINAL. Its
-- `claimDue` does not filter by type, so during a rolling update an old
-- provisioner can claim a `RENEW`, `ADD_TRAFFIC` or `ADD_TIME` this release
-- planned and kill it permanently — a paid action that no later worker can
-- recover, with nothing anywhere saying what happened to the money.
--
-- The distinguishing fact is the attempt count. This release abandons a
-- commercial operation in exactly one circumstance — `retireExhausted`, at the
-- ceiling — and the old release's refusal happens on the FIRST claim. So the
-- trigger refuses `ABANDONED` below the ceiling for the three commercial types
-- and leaves every legitimate abandon alone.
--
-- The old worker's transaction aborts, its tick logs and swallows, and the row
-- stays `IN_FLIGHT` with a lease nobody renews. `releaseExpiredLeases` returns
-- it to `PLANNED` — the call never started, so the guard that protects a
-- half-sent provider call does not apply — and the new provisioner picks it up.
-- Noise for the length of the update instead of a dead paid operation.
--
-- MAX_ATTEMPTS is 5 (`provision-executor.ts`). Written as a literal because a
-- trigger cannot import one; the constant and this number are asserted equal by
-- `provisioning-delivery.test.ts`.
CREATE OR REPLACE FUNCTION nexa_commercial_abandon_needs_exhaustion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'ABANDONED'
     AND OLD.state <> 'ABANDONED'
     AND NEW.type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME')
     AND NEW.attempts < 5 THEN
    RAISE EXCEPTION
      'operation % is a paid % with %  attempts and may not be abandoned',
      NEW.id, NEW.type, NEW.attempts
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER nexa_commercial_abandon_needs_exhaustion
  BEFORE UPDATE ON provisioning_operations
  FOR EACH ROW EXECUTE FUNCTION nexa_commercial_abandon_needs_exhaustion();
