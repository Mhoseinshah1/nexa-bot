-- A service can be terminated before it was ever provisioned.
--
-- `SERVICE_MACHINE` has said so since it was written: `PENDING_PROVISION ->
-- TERMINATED` and `UNRECONCILED -> TERMINATED` are both declared edges, and
-- `OPERATION_LEGAL_FROM.TERMINATE` names both states with a reason beside them
-- — "a service an operator or a customer has decided to end must be endable
-- whatever went wrong on the way, including one stuck in `UNRECONCILED` after
-- a lost create".
--
-- `services_provisioned_at_check` refused both. It was an EQUALITY between "the
-- state is one of those two" and "`provisioned_at` is null", so moving the
-- state to TERMINATED while the timestamp stayed null put the two sides out of
-- agreement and the UPDATE raised. Two declared edges of the machine could not
-- be taken at all.
--
-- Nothing had taken them, which is why this stood. The automatic refund is the
-- first caller: a create that definitively failed leaves a `PENDING_PROVISION`
-- row occupying a capacity slot, and terminating it is how the panel gets the
-- slot back. The full integration suite found it on the first run.
--
-- The carve-out is for TERMINATED and nothing else. For every state a service
-- can be USED in the equality still holds, and `services_terminated_at_check`
-- still forces `terminated_at`, so a terminated row still says when. What a
-- terminated row's null `provisioned_at` now says is true and worth saying:
-- this service never reached a panel.
--
-- No existing row changes meaning. The clause only ADMITS rows the old check
-- rejected, and every terminated row written before this release came from a
-- state that had a `provisioned_at`.

ALTER TABLE "services" DROP CONSTRAINT "services_provisioned_at_check";--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_provisioned_at_check" CHECK (state = 'TERMINATED'
          OR (state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') = (provisioned_at IS NULL));