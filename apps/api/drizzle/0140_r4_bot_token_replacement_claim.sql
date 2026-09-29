ALTER TABLE "bot_instances" ADD COLUMN "token_replacement_claim" uuid;--> statement-breakpoint
ALTER TABLE "bot_instances" ADD COLUMN "token_replacement_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_token_replacement_claim_check" CHECK ((token_replacement_claim IS NULL) = (token_replacement_claimed_until IS NULL));