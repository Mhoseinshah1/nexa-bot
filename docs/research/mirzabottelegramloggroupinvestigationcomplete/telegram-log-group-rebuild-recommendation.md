# Rebuild Recommendation — logging & eventing
### Section A is what MirzaBot does. Section B is what we should build. They are kept strictly separate.

## A. OBSERVED MIRZABOT BEHAVIOUR (summary)
- One Telegram forum group; one topic per event class; 38 hand-written message templates.
- Append-only, no ids, no correlation, no dedup, no severity, no retention.
- Timestamps mix Jalali and Gregorian; amounts mix separated and unseparated forms;
  the same label carries different meanings in different templates.
- Success and failure of one operation land in different topics with no shared key.
- Admin mutations are essentially unlogged; two exceptions (wallet adjust, receipt approve).
- Scheduling: backup 120 min · cleanup 10 min · nightly 23:59 · notifications continuous.
- Lifecycle: warn at ≤5 GB and at 2 days; remove at −3 days or on exhaustion.
- Retention: unpaid invoice 5 days → delete; incomplete payment 1 day → expire.

## B. OUR REBUILD RECOMMENDATION
1. **Make the database the log, and Telegram a renderer.** Every event is a row in an
   append-only `events` table with `event_id`, `type`, `actor`, `subject`, `payload
   (jsonb)`, `occurred_at (UTC)`, `correlation_id`. Telegram delivery is a projection.
2. **One correlation id per business transaction.** A purchase, its payment, its
   commission, its provisioning attempt and any error all carry the same
   `correlation_id`. This single change removes BUG-LGR-019 and LGR-BR-082.
3. **One schema per event type, generated from a definition** — never hand-written
   Persian strings. Rendering is a template over typed fields, so labels, units and
   separators cannot drift (removes ~15 of the 32 catalogued bugs by construction).
4. **Store UTC, render local.** Never emit two calendars. Jalali is a display concern.
5. **Store money as integer minor units with an explicit currency**, and render with a
   single formatter. Never print a raw float FX rate.
6. **Explicit enums**, validated at write time: `service_status`, `payment_method`,
   `payment_status`, `user_tier`. `cart to cart` becomes `CARD_TO_CARD` with a display
   label; the misspelling does not survive.
7. **Log every admin mutation** — actor, target, before, after, reason. Non-negotiable.
8. **Redact by policy at the edge**: never log wallet addresses, tokens, panel
   credentials, or raw provider bodies. Log a reference to a secured record instead.
9. **Backups leave the chat.** Encrypted object storage, per-object keys, a retention
   policy, an integrity check (row counts + checksum) and a *notification* in Telegram —
   `backup_YYYY-MM-DDTHHMM` names, never a date alone.
10. **Dedup and severity.** Group identical errors within a window with an occurrence
    count; carry `severity` on the event so routing is a rule, not a topic choice.
11. **Emit a recovery event.** Every error class gets a matching "resolved" event so an
    operator can tell an ongoing incident from a historical one.
12. **Fix the specific correctness bugs**: read the pre-renewal expiry *before* updating;
    never emit `NaN` (clamp remaining volume at 0); report "expired N days ago" instead
    of a negative day count; log the lucky-wheel prize and the referral source.
13. **Keep MirzaBot's good decisions**: the threshold set (5 GB / 2 days / −3 days), the
    120-minute backup cadence, the 5-day / 1-day retention windows, the 23:59 aggregate,
    and the revenue decomposition — all of these are sound and are the reason the three
    audited surfaces reconcile exactly.
