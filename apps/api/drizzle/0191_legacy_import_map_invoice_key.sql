ALTER TABLE "legacy_import_map" DROP CONSTRAINT "legacy_import_map_table_check";--> statement-breakpoint
ALTER TABLE "legacy_import_map" DROP CONSTRAINT "legacy_import_map_legacy_key_check";--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_table_check" CHECK (legacy_table IN ('user', 'invoice'));--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_legacy_key_check" CHECK (CASE legacy_table
            WHEN 'user' THEN legacy_id ~ '^[1-9][0-9]{0,19}$'
            WHEN 'invoice' THEN legacy_id ~ '^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$'
            ELSE false
          END);