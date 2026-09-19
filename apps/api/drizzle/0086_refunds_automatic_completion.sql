-- An automatic refund is completed by nobody, because nobody decided it.
--
-- `refunds_completed_check` bound three facts together: COMPLETED, a timestamp,
-- and an administrator. Two of them still belong together and the third does
-- not. A settlement or a provisioner that discovers a paid order cannot be
-- delivered gives the money back in that transaction, with no operator present
-- on either side of it.
--
-- WHY NOT WRITE AN ADMIN ID
--
-- The obvious way to keep one check is to store the confirming operator's id on
-- the refund. That is a fabricated actor on a money record — it says a person
-- decided to return this money, when what they decided was to approve an
-- unrelated bank transfer. `CLAUDE.md` forbids it outright, and
-- `refunds.requested_by_admin_id` exists precisely to answer "who wanted this".
--
-- WHAT STILL HOLDS
--
-- The timestamp half is unchanged and unconditional: COMPLETED means completed
-- at a time, which is the "money marked returned because a refund was
-- requested" defect the original check was written for.
--
-- The administrator half now applies exactly where it means something — a
-- refund an operator REQUESTED is completed BY an operator, and the new check
-- is an equality, so such a row cannot reach COMPLETED anonymously and an
-- automatic one cannot acquire a completer it never had.
-- `requested_by_admin_id IS NULL` identifies the automatic lane and cannot be
-- an operator refund with the field forgotten: `RefundService.request` is
-- guarded by `refunds.issue`, which `SYSTEM_JOB_PERMISSIONS` does not carry.
--
-- No existing row changes meaning. Every refund written before this release was
-- requested and completed by an administrator, so both old conjuncts held and
-- both new checks hold.

ALTER TABLE "refunds" DROP CONSTRAINT "refunds_completed_check";--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_operator_completion_check" CHECK ((state = 'COMPLETED' AND requested_by_admin_id IS NOT NULL) = (completed_by_admin_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_completed_check" CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL));