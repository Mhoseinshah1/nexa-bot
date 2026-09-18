-- Closes duplicate open top-ups, so that 0075 can add the index that prevents them.
--
-- Ordering is the whole point of this file being separate: `payments_open_topup_key` is
-- a UNIQUE index, and an installation that already holds two open top-ups for one
-- customer would meet 0075 as a FAILED UPGRADE rather than as a constraint. The bug this
-- pair fixes is one that produces exactly such rows, so the data is expected to exist
-- wherever the defect has fired.
--
-- The OLDEST row per customer survives. That is the one `findOpenTopup` already returns
-- — it orders by `created_at` so that "a tenant that somehow holds two" prefers the
-- oldest — and it is the reference the customer has been looking at longest, so keeping
-- it is what makes a transfer already in flight still reconcilable.
--
-- The others become EXPIRED: the same terminal state the sweep would have given them a
-- moment later, with `resolved_at` stamped because `payments_resolved_check` is an
-- equality between the two. `resolved_by_admin_id` stays NULL — no administrator decided
-- this — which `payments_resolution_reviewer_check` requires anyway, since it admits a
-- reviewer only on FAILED.
--
-- Only PENDING rows are touched, so `payments_confirmation_frozen` (which guards rows
-- whose OLD.state is CONFIRMED) cannot fire.

UPDATE "payments" AS p
SET
  "state" = 'EXPIRED',
  "resolved_at" = now(),
  "resolution_note" = 'Closed by migration 0074: a second open top-up for this customer.',
  "updated_at" = now()
WHERE p."state" = 'PENDING'
  AND p."order_id" IS NULL
  AND p."method" = 'MANUAL_TRANSFER'
  AND EXISTS (
    SELECT 1
    FROM "payments" AS older
    WHERE older."tenant_id" = p."tenant_id"
      AND older."customer_id" = p."customer_id"
      AND older."state" = 'PENDING'
      AND older."order_id" IS NULL
      AND older."method" = 'MANUAL_TRANSFER'
      AND (older."created_at", older."id") < (p."created_at", p."id")
  );
