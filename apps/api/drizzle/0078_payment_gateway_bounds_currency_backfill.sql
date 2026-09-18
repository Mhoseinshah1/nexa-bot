-- Every existing route's bounds were written under the installation's `sales.currency`
-- at the time — that is the only currency a bound could ever have meant, because
-- `PaymentGatewayService` relabelled them with that setting at comparison time. So the
-- backfill records that denomination: the tenant's stored `sales.currency` where one
-- has been set, and the registry default where it has not. `COALESCE` to the default is
-- the same answer `SettingsService.valueOf` gives a tenant with no row.
--
-- `value` is jsonb holding a bare JSON string; `#>> '{}'` unwraps it.
--
-- This sits BETWEEN 0077 (column added, nullable) and 0079 (SET NOT NULL) so that an
-- upgrading installation with routes cannot meet 0079 as a failed upgrade. Only rows
-- still NULL are touched, so a re-run changes nothing.

UPDATE "payment_gateways" AS g
SET "bounds_currency" = COALESCE(
  (
    SELECT s."value" #>> '{}'
    FROM "setting_values" AS s
    WHERE s."tenant_id" = g."tenant_id"
      AND s."setting_key" = 'sales.currency'
  ),
  'IRT'
)
WHERE g."bounds_currency" IS NULL;
