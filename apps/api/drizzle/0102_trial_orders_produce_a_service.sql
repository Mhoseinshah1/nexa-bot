-- A trial order produces a service, exactly as a purchase does.
--
-- `nexa_service_requires_purchase_order` (0050) refuses a service for any order
-- whose purpose is not `NEW_SERVICE`, because a RENEW, ADD_TRAFFIC or ADD_TIME
-- order acts on a service that already exists and must never create a second
-- provider account. `TRIAL` is the second purpose that CREATES one
-- (`orderPurposeCreatesNewService`), so it joins `NEW_SERVICE` here and the
-- three commercial purposes stay refused. docs/wp6-audit.md A1.
--
-- Written as the positive list of the two that create, not as an exclusion of
-- the three that do not: a purpose added later without a thought is refused by
-- this trigger rather than allowed, which is the safe side for the reason 0050
-- gives.
--
-- On a rollback to the release before this one the older binary never writes a
-- TRIAL order, and this function still refuses everything 0050 refused.
CREATE OR REPLACE FUNCTION nexa_service_requires_purchase_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_purpose text;
BEGIN
  SELECT purpose INTO order_purpose
    FROM orders
   WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF order_purpose IS NOT NULL AND order_purpose NOT IN ('NEW_SERVICE', 'TRIAL') THEN
    RAISE EXCEPTION
      'order % is a % and cannot produce a service', NEW.order_id, order_purpose
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
