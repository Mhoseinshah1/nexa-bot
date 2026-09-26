# WP15 — Provider / RickPanel hardening: audit and what was done

Branch `claude/wp15-provider-hardening`, from `origin/main` at `4e6fb39`. It is
independent of WP12–WP14.

## Rules for this package

The owner's rules:

- **Invalidation.** Old-link invalidation was never proven, so nothing may claim it.
- **Secrets.** No subscription URL or token is exposed.
- **Guarantees.** No provider guarantee is invented.
- **No live panel.** Harden in code and tests, and record what stays unproven.

No panel was reachable from this session. So every change below is proven against the
fakes and the real `SafeHttpClient`, and every question that needs a panel is written
up as open: §4, and `docs/open-questions.md` › `OQ-WP15`.

---

## 1. What was audited, and the verdict

| Area                                 | Verdict                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RESET_USAGE**                      | A capability NAME only. It has no operation type, no adapter method and no descriptor declaration for any provider; tests pin it undeclared. It is deliberately never called: RickPanel's `/reset` route exists, but its effect with non-zero usage is unmeasured. The fakes have no reset route. **Nothing to harden, and nothing may be built until measured** (`OQ-WP15-RESET-USAGE`). |
| **Old-link invalidation**            | The code claims only that the link read back differs from the stored one (`rickpanel.adapter.ts` rotation read-back; `provider.ts` "claimed nowhere"). The rotate audit records both links answering 504. **One customer sentence contradicted this**: `bot.service.rotate_hint` said pressing "change link" cuts other people off. Fixed in H5.                                          |
| **Ownership / provenance**           | RickPanel never adopts on a create 409 (Codex C2). Marzban's 409 and 3X-UI's duplicate email are UNKNOWN and reach RECONCILE, which adopts whatever `lookupUser` finds. No provider proves ownership at adoption (`OQ-RP-05`, needs a schema change). Suspend, resume, allowance, rotate and terminate address the stored username without re-proving ownership.                          |
| **Reconciliation**                   | ADOPT, ABSENT (re-plan, bounded at 3 cycles) or UNDECIDED. Gaps G3–G5 in §3.                                                                                                                                                                                                                                                                                                              |
| **Transport / write ambiguity**      | Every success is proven by a read-back or the response record; nothing ambiguous is classified as success. **One path classified ambiguity as safe to replay** (H1), and one latent path could retry a write (H4). Both are fixed.                                                                                                                                                        |
| **Mutation idempotency**             | Targets are absolute and computed once at settlement; no delta reaches the wire. ROTATE is convergent. One open commercial action per service. Sound, with the residual G2.                                                                                                                                                                                                               |
| **Failure recovery**                 | Attempt ceiling 5, backoff 30 s doubling to 15 min. Five sweeps in a fixed order. Stranded-call reaping: UNKNOWN for PROVISION, PLANNED for idempotent operations. Operator reconcile, retry-provision and the management requests. Gap G4.                                                                                                                                               |
| **RickPanel vs Marzban consistency** | Same method set plus `rotateSubscription`. No method without a declaration and no declaration without a method. Marzban's declared capabilities are all backed by the real v0.8.4 acceptance. **RickPanel's are not** (a recorded deviation), and READ_USAGE rests on `used_traffic`, which has never been observed (`OQ-WP15-RICK-USED-TRAFFIC`).                                        |
| **Secrets in logs / audit / errors** | Redaction is key-based and fails closed on `subscription*`. Execution results carry ids and enums only. Audit rows record `hasSubscription`. The Web DTO omits the URL. **No leak found.** Residual: the redactor matches keys, not string contents.                                                                                                                                      |

## 2. What this package changes

### H1 — an accepted create whose read-back is lost is UNKNOWN, never safe to replay

- **File:** `rickpanel.adapter.ts` `createUser`.
- **Before.** After a 2xx create, a read-back failure was returned in its own kind. A
  transport failure or a 429 on that GET came back as UNREACHABLE / TLS / BLOCKED /
  RATE_LIMITED, which are in `SAFE_TO_REPLAY_FAILURE_KINDS`.
  - That made the PROVISION `FAILED` and retried it.
  - The retry met the account this create had made, and the panel answered 409.
  - The 409 was `PROVIDER_REFUSED`, so the order was refunded.
  - The account stayed on the panel, owned by nobody.
- **After.** Such a failure is `MALFORMED_RESPONSE`, which is UNKNOWN for a create. That
  is the kind "accepted, not readable yet" already used: the service goes `UNRECONCILED`
  and a READ adopts the account. A read-back failure that was already UNKNOWN (5xx,
  timeout, unreadable body) keeps its own kind.
- **Tests:**
  - `tests/unit/rickpanel-adapter.test.ts`: rate-limited and dropped read-backs (UNKNOWN,
    one POST, the account present), and a 5xx read-back keeping `PROVIDER_ERROR`.
  - `tests/integration/rickpanel-new-service.test.ts`, "adopts, never refunds, an
    accepted create whose read-back was rate-limited": one create, ACTIVE, no refund,
    order PAID.
  - New fake knobs: `userReadMode` in the unit fake, `rateLimitedReads` in
    `tests/support/fake-rickpanel.ts`.

### H4 — the transport never retries a write

- **File:** `safe-http.ts`.
- **Before.** The retry loop applied to every method. `PANEL_HTTP_RETRIES` is 0, so this
  was latent. Raising that constant would have silently re-sent a POST or DELETE on a
  timeout, which is a second create or a second anything.
- **After.** Only a GET is retried by the client. Whether a write may be tried again is
  the operation layer's decision (`IDEMPOTENT_MUTATIONS`, `failureOutcome`).
- **Test:** `tests/unit/safe-http.test.ts`, "retries a read on a transient failure and
  never a write".

### H5 — no customer sentence claims the old link stops working

- **Change.** `bot.service.rotate_hint` is now neutral: rotating makes a new link.
- **Template rule.** The template's description in `packages/contracts/src/templates.ts`
  says it must not claim invalidation (a contract text change, in its own commit).
- **Guard.** `tests/unit/rotation-wording.test.ts` scans every rotation key in both
  catalogues for the claim's vocabulary, and fails on the old sentence.
- **Owner note.** The old line was listed among "approved lines" in
  `docs/customer-ux-completion-audit.md` §H. It is replaced because it states what
  `OQ-RP-07` says is unproven, which the owner's WP15 rule forbids.
  - Operators can still override the template body per tenant.
  - Restoring the old sentence would need the measurement `OQ-RP-07` names first.

### Ledger corrections (`docs/open-questions.md`)

- `UNK-XUI-010` and `Q-MARZBAN-PROBE` are marked closed, with the evidence that closed
  them.
- `OQ-PROV-01`'s containment argument is corrected. The username is no longer derived
  from the service id, and on RickPanel a 409 now refunds.
- `OQ-RP-01…09` are collected into the ledger, plus three new questions:
  `OQ-WP15-RESET-USAGE`, `OQ-WP15-RICK-USED-TRAFFIC` and `OQ-WP15-RICK-NUMBERS`.

## 3. The seven findings — the owner's decisions, and what now holds

Section 3 of the first pass listed G1–G7 as found and not changed, each waiting for a
decision. The owner decided all seven (PR #79, "owner decisions for the WP15 G1–G7
findings"); commits `9290086` (contracts) and `7740470` (implementation, migration
`0121_wp15_provider_provenance` — the number is temporary and is renumbered at
integration) carry them. Each row separates what the CODE now guarantees from what only
a LIVE panel can settle; a row is never closed on the second half by the first.

| Id     | Decision (owner)                                                                                                                                                                | What the code now does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Code-side  | Live-provider evidence                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | Customers cannot terminate. A TERMINATE never DELETEs by name without provenance; a create that never reached the provider is ended Nexa-side only. Refund Request is deferred. | TERMINATE leaves `CUSTOMER_SERVICE_OPERATIONS`; `requestFromCustomer` refuses it at run time; no end button; a stale `t:`/`k:` tap answers `bot.service.capability_unsupported` and plans nothing. The executor decides a PENDING/UNRECONCILED terminate under the service row lock: no provenance → Nexa-side end, lost creates ABANDONED, no DELETE; a create on the wire → put back (`PROVISION_IN_FLIGHT`); provenance → ordinary DELETE. A create stamps its call under the same lock, from PENDING_PROVISION only. | **CLOSED** | None needed: no provider call is made on the new path.                                                                                 |
| **G2** | An ambiguous RENEW/ADD_TRAFFIC/ADD_TIME is verified, not refunded. Bounded reads, existing backoff, compare with the persisted absolute target. No extra reads on success.      | Any failure outside `SAFE_TO_REPLAY_FAILURE_KINDS` → `UNKNOWN`, first read one backoff later. One read per tick, three per row (`ALLOWANCE_VERIFICATION_READS`). Reached/exceeded → SUCCEEDED, allowance recorded, no refund. Below target or account gone → FAILED and the existing refund. Unanswered → stays UNKNOWN, `next_attempt_at` null, `ALLOWANCE_UNVERIFIED`. UNKNOWN is open in `provisioning_operations_open_commercial_key`.                                                                               | **CLOSED** | `OQ-WP15-RICK-NUMBERS` answered in code (strings accepted); what a real RickPanel echoes after a PUT is still unmeasured.              |
| **G3** | One early 404 after an accepted create is not enough to re-create. First read ~30 s, second after the next backoff.                                                             | `planReconciles` plans with `notBefore = now + 30 s`. The first ABSENT stamps `absence_observed_at` and re-plans the same reconcile at `backoffMs(attempts + 1)` (≈60 s); only a second ABSENT re-plans the create.                                                                                                                                                                                                                                                                                                      | **CLOSED** | `OQ-RP-04`: real propagation time. Two reads ≈90 s apart is a policy, not a measurement.                                               |
| **G4** | A failed reconcile round gets ONE more automatically; a second failure waits for an operator. Durable budget; no new event code unless required.                                | Rounds are counted on the lost create's own row (`verification_attempts`), conditionally, so replicas agree and a restart neither resets nor double-spends. Round 2 is planned `backoffMs(5)` after round 1 ends; when it ends the stalled condition says `RECONCILE_EXHAUSTED`. No new code: `provisioning.stalled` carries the reason. A reconcile retries `MALFORMED_RESPONSE` within its own ceiling (G5).                                                                                                           | **CLOSED** | —                                                                                                                                      |
| **G5** | `used_traffic` is never fabricated. Present → normalised; absent → incomplete, bounded retry. Diagnostic distinguishes "found, usage missing" from "not found".                 | `provider-numbers.ts` is the one reading of `expire`/`data_limit`/`used_traffic` for RickPanel and Marzban: safe non-negative integers or canonical decimal strings; anything else `VALUE_MALFORMED`. Absent `used_traffic` → `MALFORMED_RESPONSE` + `USAGE_FIELD_MISSING` (the failure note says so), never zero; "not found" is still `found: false`.                                                                                                                                                                  | **CLOSED** | `OQ-WP15-RICK-USED-TRAFFIC`: if a real RickPanel never sends it, every RickPanel reconcile ends `RECONCILE_EXHAUSTED` for an operator. |
| **G6** | A write whose connection failed after it may have been sent is ambiguous, never replayed by the transport. GET keeps its retry; health semantics unchanged.                     | `SafeHttpClient` tracks whether the connection (TLS: the handshake) was up; a WRITE failing after that is `TIMEOUT` + `CONNECTION_LOST_AFTER_SEND`. Token exchanges are declared `effect: 'READ'`. Probes are unchanged: they are reads.                                                                                                                                                                                                                                                                                 | **CLOSED** | `OQ-PROV-01`/`OQ-RP-09` closed in code; the socket behaviour of each real panel under a reset is not re-measured.                      |
| **G7** | No blind adoption. Adopt only with durable evidence; 409, duplicate email, collision, pre-existing account never adoptable. H1 (2xx, read-back lost) IS provenance.             | `create_accepted_at` is stamped on a PROVISION whose create was answered 2xx and whose follow-up failed (`accepted` on the port). RECONCILE adopts only when the service has that stamp or a SUCCEEDED create; otherwise the reconcile FAILS, the rounds are spent, `FOUND_WITHOUT_PROVENANCE`, no refund. Marzban's 409 is `PROVIDER_REFUSED`; a 409 on a service that HAS provenance goes UNKNOWN.                                                                                                                     | **CLOSED** | No provider metadata is used or invented. A real panel's create answer shape (`OQ-RP-03`) decides how often the 2xx path is reached.   |

### What the decisions cost, stated plainly

- **A create whose answer is lost is no longer adopted.** A timeout, a reset after the
  request was sent, or a 5xx that the panel had in fact applied now ends
  `UNRECONCILED` with `FOUND_WITHOUT_PROVENANCE` when the account is there — nothing is
  refunded, nothing is re-created, an operator decides. The customer holds no link, so
  the operator's exit is a TERMINATE (Nexa-side, no DELETE by name, lost creates
  ABANDONED) and then the ordinary operator refund. There is no "adopt anyway" action;
  that is `OQ-WP15-ADOPT`.
- **An ambiguous renewal the reads cannot settle stays paid and undelivered** until an
  operator acts (`ALLOWANCE_UNVERIFIED`). No operator action re-arms the verification
  or resolves the row today; that is `OQ-WP15-ALLOWANCE-EXIT`.
- **Reconcile is slower by design**: ≈30 s before the first read, ≈60 s more before a
  second absence re-creates.
- **An unverified renewal also blocks the next purchase on that service.** UNKNOWN is
  open in `provisioning_operations_open_commercial_key`, so while a renewal sits
  `ALLOWANCE_UNVERIFIED` a second RENEW/ADD_TRAFFIC/ADD_TIME is refused
  `SERVICE_ACTION_IN_PROGRESS`, and an operator refund of the order is refused as
  `purchaseInProgress`. That is the price of never charging twice for one allowance; the
  missing exit is the same `OQ-WP15-ALLOWANCE-EXIT`.
- **A rolling update can overlap two transports for one tick.** A replica still running
  the previous image retries a write on a transient failure; the new one does not.
  Production configures `maxRetries: 0` for panel writes, so the window is empty there,
  and the Sanaei adapter's login (a POST) is declared `effect: 'READ'` deliberately — a
  login creates nothing, and retrying it is what the old code did.

### The review round

An adversarial read-only review of `9290086`/`7740470` returned twelve findings. Ten were
fixed in the follow-up commit and falsified (`docs/wp15-falsification.md` WP15-18..22):
a verified expiry is compared in whole seconds; a verification whose last read never
finished is stopped and reported rather than claimed forever; a verified FAILED carries
no date, so the announcer answers it; a commercial write stranded by a dead worker is
verified, never replayed; a terminate of a paid service whose create never started
refunds it through `refundPurchase`; the verification checks scope activity in its claim
and survives a thrown read; a service in a state that cannot be read is not verified; a
missing usage figure is undecided, not zero; a RECONCILE takes the service lock before
deciding; and a TLS error after the handshake on a write is ambiguous like any other. The
remaining two are the two costs stated just above.

## 4. What stays unproven, and how each is settled

Every item needs a disposable panel. None is claimed anywhere in code or copy.

- **Old-link invalidation after rotation** (`OQ-RP-07`): fetch both links from a
  reachable subscription host.
- **RESET_USAGE with non-zero usage:** the procedure in `docs/rickpanel-rotate-audit.md`
  lines 158–162.
- **RickPanel `used_traffic`, numeric echoes, propagation time, the unseeded-create
  status** (`OQ-WP15-RICK-*`, `OQ-RP-04`, `OQ-RP-06`).
- **Every RickPanel capability.** The acceptance suite
  `tests/acceptance/real-panel-rickpanel.test.ts` (A1–A7) exists and has never been run.
  It has no rotation case.

## 5. Evidence

Mutations, each reverted after its run:

| Mutation                                                   | Failed                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| H1 reverted: `return readBack` for every read-back failure | 2 unit cases; integration: the service ended **TERMINATED and refunded** instead of ACTIVE        |
| H4 reverted: `budget = maxRetries` for every method        | "retries a read on a transient failure and never a write"                                         |
| H5 reverted: the old `rotate_hint` sentence restored       | `rotation-wording.test.ts` "no bot rotation sentence says the old link or anyone's access is cut" |

The G1–G7 decisions are falsified in `docs/wp15-falsification.md`: twenty-two rules, each
reverted alone, twenty-two killed by a named test, and one further mutation — the bot surface's own refusal
of a stale terminate tap — surviving because the service guard behind it refuses the
same request, which is recorded there rather than hidden.
