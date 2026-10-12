ALTER TABLE "legacy_import_run_inputs" DROP CONSTRAINT "legacy_import_run_inputs_engine_check";--> statement-breakpoint
ALTER TABLE "legacy_invoice_archive_runs" DROP CONSTRAINT "legacy_invoice_archive_runs_engine_check";--> statement-breakpoint
ALTER TABLE "legacy_read_set_runs" DROP CONSTRAINT "legacy_read_set_runs_engine_check";--> statement-breakpoint
ALTER TABLE "legacy_import_run_inputs" ADD CONSTRAINT "legacy_import_run_inputs_engine_check" CHECK (source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE', 'NXPKG'));--> statement-breakpoint
ALTER TABLE "legacy_invoice_archive_runs" ADD CONSTRAINT "legacy_invoice_archive_runs_engine_check" CHECK (source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE', 'NXPKG'));--> statement-breakpoint
ALTER TABLE "legacy_read_set_runs" ADD CONSTRAINT "legacy_read_set_runs_engine_check" CHECK (source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE', 'NXPKG'));