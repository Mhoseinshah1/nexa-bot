-- Every reminder occurrence written so far is discarded, and it has to be.
--
-- The two snapshot columns below are NOT NULL and there is no truthful default for
-- them: `snapshot_service_label` is the account name the customer will be shown, and a
-- row written before this migration never recorded one. Inventing a placeholder would
-- put a fabricated name in front of a customer, which is the one thing this lane must
-- never do; making the columns nullable would weaken a real invariant for ever to
-- accommodate rows that cannot exist on any deployment.
--
-- `service_reminders` was created by 0090, in this same unreleased change, and nothing
-- that has shipped writes it. So on every database that exists this DELETE removes
-- nothing; on a developer's or CI's, it removes rows written by an earlier revision of
-- this branch. The worst case is a reminder re-sent once, because the occurrence that
-- recorded it is gone.
DELETE FROM "service_reminders";--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "service_reminders" DROP CONSTRAINT "service_reminders_kind_check";--> statement-breakpoint
ALTER TABLE "service_reminders" ADD COLUMN "snapshot_service_label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_reminders" ADD COLUMN "snapshot_remaining_days" integer;--> statement-breakpoint
ALTER TABLE "service_reminders" ADD COLUMN "snapshot_used_bytes" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL'));--> statement-breakpoint
ALTER TABLE "service_reminders" ADD CONSTRAINT "service_reminders_kind_check" CHECK (kind IN ('EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRED', 'USAGE_FIRST', 'USAGE_SECOND', 'USAGE_FINAL'));