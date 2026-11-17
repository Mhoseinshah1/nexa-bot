-- Repair HOSTED tenants created without their own payment routes/category.
-- Data only: no permission, billing, credential or existing configuration changes.
-- sales.currency is tenant-local; invalid/missing values use the registry default
-- (IRT), just as SettingsResolver does. Never read the parent's setting or routes.
INSERT INTO payment_gateways
  (tenant_id, provider, status, bounds_currency, allow_service_purchase, allow_wallet_topup)
SELECT t.id, p.provider, p.status,
       CASE WHEN s.value IN ('"IRT"'::jsonb, '"IRR"'::jsonb)
            THEN s.value #>> '{}' ELSE 'IRT' END,
       true, true
FROM tenants t
CROSS JOIN (VALUES
  ('MANUAL_TRANSFER', 'ACTIVE'),
  ('TONPAYS', 'DISABLED'),
  ('TELEGRAM_STARS', 'DISABLED'),
  ('TONPAYS_TELEGRAM', 'DISABLED'),
  ('NOWPAYMENTS', 'DISABLED'),
  ('CENTRALPAY', 'DISABLED'),
  ('TETRAPAY', 'DISABLED'),
  ('RIALIT', 'DISABLED'),
  ('CUSTOM', 'DISABLED')
) AS p(provider, status)
LEFT JOIN setting_values s ON s.tenant_id = t.id AND s.setting_key = 'sales.currency'
WHERE t.kind = 'HOSTED'
ON CONFLICT (tenant_id, provider) DO NOTHING;
--> statement-breakpoint
-- Any category (including hidden/inactive or renamed) means "already initialized".
-- UUIDv7 generation follows 0100; plain gen_random_uuid() would make a v4 that
-- productCategoryIdSchema refuses, leaving the repaired category unusable.
-- The block keeps the lock and insert atomic even for a SQL runner that executes
-- migration statements separately (the rollback-compatibility suite does this).
DO $$
DECLARE previous_lock_timeout text := current_setting('lock_timeout');
BEGIN
  -- Serialize against concurrent first-category inserts, including custom categories.
  -- Fail the migration rather than waiting indefinitely behind an operator's write.
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE product_categories IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('lock_timeout', previous_lock_timeout, true);
  INSERT INTO product_categories (id, tenant_id, name)
  SELECT encode(
    set_bit(set_bit(overlay(
      uuid_send(gen_random_uuid())
      PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
      FROM 1 FOR 6
    ), 52, 1), 53, 1), 'hex'
  )::uuid, t.id, 'عمومی'
  FROM tenants t
  WHERE t.kind = 'HOSTED'
    AND NOT EXISTS (SELECT 1 FROM product_categories c WHERE c.tenant_id = t.id);
END $$;
