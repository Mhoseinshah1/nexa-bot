-- SFR A1: the Recovery Kit's three permissions, removed.
--
-- Hand-written, like 0085, because `drizzle-kit` generates from `schema.ts` and looks at no
-- data. No snapshot accompanies it: it changes no table shape, so the drift check has nothing
-- to compare.
--
-- Owner decision 2026-11-08: backups are self-contained (a backup made with a backup password
-- carries its keys, wrapped by that password), so the kit is obsolete and its export, import
-- and key removal are gone. `PERMISSION_CATALOG` no longer declares `recovery.kit.export`,
-- `recovery.kit.import` or `recovery.key.remove`, so every row naming one is a grant of a
-- permission that does not exist — invisible to `resolveEffectivePermissions`, and a key the
-- role editor cannot explain. 0160 backfilled them into the system owner roles; this retires
-- them, as 0085 retired `orders.fulfil`. A DENY override naming one is left alone.
--
-- `installation_keys` is NOT dropped: an installation that restored with a kit before v0.9.10
-- may still hold live secrets sealed under an imported key, and the keyring still reads it.
-- One DELETE per key: the seed/backfill coverage guard reads each retired key out of its own
-- statement.

DELETE FROM "role_permissions" WHERE "permission_key" = 'recovery.kit.export';
--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "permission_key" = 'recovery.kit.import';
--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "permission_key" = 'recovery.key.remove';
