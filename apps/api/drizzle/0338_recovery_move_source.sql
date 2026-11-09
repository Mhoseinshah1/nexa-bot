ALTER TABLE "recovery_requests" DROP CONSTRAINT "recovery_requests_source_check";--> statement-breakpoint
ALTER TABLE "recovery_requests" DROP CONSTRAINT "recovery_requests_confirmation_check";--> statement-breakpoint
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_source_check" CHECK (source IN ('UPLOAD', 'LOCAL_RUN', 'MOVE'));--> statement-breakpoint
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_confirmation_check" CHECK (CASE WHEN source = 'MOVE'
            THEN confirmed_by_admin_id IS NULL
             AND num_nonnulls(confirmed_at, confirmed_checksum, confirmation_expires_at) IN (0, 3)
            ELSE num_nonnulls(confirmed_at, confirmed_by_admin_id, confirmed_checksum, confirmation_expires_at) IN (0, 4)
          END);