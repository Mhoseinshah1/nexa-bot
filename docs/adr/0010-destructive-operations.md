# ADR-0010 — Protocol for destructive and bulk operations

**Status:** Accepted as a rule. Nothing enforces it yet, because Phase 0 has no
destructive or bulk operation. It is recorded now so the first one is built
correctly rather than retrofitted.

## Decision

Every destructive or bulk operation follows the same five steps:

1. **Dry run** — compute the effect without applying it.
2. **Counted preview** — state exactly how many records are affected, and show a
   sample.
3. **Confirmation proportional to blast radius and irreversibility** — a toggle
   for cosmetic changes; typed confirmation of the target's identity plus a
   mandatory reason for destructive ones; a second approver for the most
   dangerous.
4. **Audited execution** — actor, reason, before and after values, and the count.
5. **Recorded result** — a batch record that can be inspected afterwards, and
   reversed where reversal is possible.

Two corollaries:

- **A correction is a new ledger entry, never an edit.** Money is never rewritten.
- **A destructive action is never rendered identically to a cosmetic one.**

## The failures this prevents

Each of these is documented in `docs/research/`:

- Mass wallet top-up credits every account in scope. The success message never
  states how many accounts were affected, and the cancel button cancels the
  broadcast but not the money.
- A single "optimise bot" button deletes six classes of order, including unpaid
  ones, behind one inline button — no count, no dry run, no cancel, no record of
  previous runs.
- Bulk reseller-bot operations (mass update, webhook reset, command reset) fire
  immediately on press with no confirmation, no target count, no progress and no
  per-bot result. One of them caused an incident simply by being opened.
- The global trial-limit setter silently overwrites every per-user exception
  across roughly 197,000 rows.
- The whole-bot kill switch is rendered identically to the dice-game toggle.
- Admin deletion is a bare `❌` with no confirmation, and unblocking a user is
  unlogged and reasonless — while the _reversible_ block action does get a
  confirmation step. Confirmation strength is inverted relative to risk.

## Related

Broadcasts additionally need Telegram-compliant rate limiting and queueing.
There is no evidence of any rate-limit handling, batching or 429 handling in the
legacy system. That belongs to the broadcast design, not to this ADR.
