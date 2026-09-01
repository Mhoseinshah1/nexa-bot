# Unknown register

### UNK-GTL-001 — What was the global limit before the write?
- **Evidence:** none. The section never displays a current value.
- **Missing:** the prior setting.
- **Note:** this is unrecoverable — not an investigation gap but a product limitation. The two users
  whose records are known both read `1` beforehand, which is *consistent with* a prior global value
  of 1 but does not establish it.
- **Priority:** P2 · **Status:** NOT_EXPOSED.

### UNK-GTL-002 — Is the number a CAP or a REMAINING balance?  ← the crux
- **Evidence:** the field is an integer named "number of test-account creations"; both known users
  read `1`.
- **Missing:** whether it decrements when a user creates a test account.
- **Why it matters:** if it decrements, writing `1` genuinely restores one test to every user — the
  owner's intent. If it is a static cap compared against a separate usage count, writing `1`
  restores nothing for users who already consumed their allowance.
- **Safe verification:** read one user's `محدودیت اکانت تست` immediately before and after that user
  creates a test account. Read-only on the admin side; needs a customer to take a trial. Or read the
  source.
- **Priority:** **P1** · **Status:** OPEN.

### UNK-GTL-003 — Did the write actually change any user's value?
- **Evidence:** user `[TELEGRAM_USER_ID_REDACTED]` read `1` before and `1` after — no delta, as expected when the
  value written equals the value held.
- **Missing:** a user whose limit differed from `1`.
- **Safe verification:** read a third, ordinary user's record (read-only). Any user reading `1` is
  consistent; a user reading something else would disprove the bulk write.
- **Priority:** P2 · **Status:** PARTIALLY_RESOLVED — the write was accepted and caused no damage, but
  no delta was observable.

### UNK-GTL-004 — Does the allowance do anything while `نمایش تست` is OFF on every panel?
- **Evidence:** Panel Management recorded `نمایش تست` as OFF by default on the panel examined.
- **Missing:** the current state of that toggle across the live panels, and whether eligibility is
  even consulted when no panel offers a trial.
- **Priority:** P2 · **Status:** OPEN.

### UNK-GTL-005 — Bot/tenant scope in a multi-bot deployment
- **Evidence:** reseller sub-bots exist. The success message says "all users" without naming a bot.
- **Missing:** whether sub-bot users are included.
- **Safe verification:** compare against a reseller sub-bot's own settings.
- **Priority:** P2 · **Status:** OPEN.

### UNK-GTL-006 — What do `0` and other values mean?
- **Evidence:** none. No help text, no min/max, no `0` semantics anywhere in the flow.
- **Missing:** whether `0` disables trials for everyone, or means unlimited.
- **Safe verification:** source reading, or a clone bot. **Do not probe on production** — a mistaken
  `0` would silently switch off trials for ~197,000 users with no confirmation and no visible state
  to notice it by.
- **Priority:** **P1** (operational risk) · **Status:** OPEN.

### UNK-GTL-007 — Runtime customer effect
- **Evidence:** none — no test account was created.
- **Missing:** confirmation that a customer who had used their trial can now take another.
- **Safe verification:** would require creating a test service, which this phase is not authorised
  to do.
- **Priority:** P2 · **Status:** NOT_TESTED (by design).

### UNK-GTL-008 — Are the underlying historical test order/service rows preserved?
- **Evidence:** the derived statistic `اکانت‌های تست ساخته‌شده` survived at 40,665.
- **Missing:** direct inspection of the order rows.
- **Priority:** P3 · **Status:** PARTIALLY_RESOLVED — STRONGLY_INFERRED that they are intact.
