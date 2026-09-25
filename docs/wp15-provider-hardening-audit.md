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

## 3. Found, and deliberately not changed here

Each needs a decision, a measurement or a schema change.

| Id     | Finding                                                                                                                                                                                                                                                                                                                                             | Why not here                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | A TERMINATE of a `PENDING_PROVISION` service whose create never started still sends a DELETE by username. On a panel that already held that name for another customer of the same admin, that deletes their account.                                                                                                                                | Skipping the provider call is a change to the terminate state path. It races a PROVISION being claimed at the same moment, and it has refund consequences for the order. It needs its own design and review. Proposed: terminate Nexa-side only when no PROVISION for the service has `call_started_at` or SUCCEEDED, decided under the service row lock. |
| **G2** | A commercial operation (RENEW / ADD_TRAFFIC / ADD_TIME) whose 2xx answer is unreadable, or that exhausts five TIMEOUT/5xx attempts, is refunded although the panel may hold the change. If RickPanel echoes `expire`/`data_limit` as strings, which is what its document types them as, every applied renewal would read MALFORMED and be refunded. | It changes when money is given back (CLAUDE.md money rules). Proposed: a verifying READ before a commercial refund, comparing the panel's expiry and limit with `operation.target`. First settle `OQ-WP15-RICK-NUMBERS`, which one PUT on a disposable user answers.                                                                                      |
| **G3** | After "accepted, not readable yet", the RECONCILE is due at once, and one 404 counts as ABSENT. The re-create then meets a 409 and refunds, while propagation is still in progress.                                                                                                                                                                 | The grace value is policy, and propagation time is unmeasured (`OQ-RP-04`).                                                                                                                                                                                                                                                                               |
| **G4** | A RECONCILE that ends terminal FAILED (MALFORMED, AUTH, attempts exhausted) leaves the service `UNRECONCILED` until an operator requests another. Its ops message says a paid service "could not be created".                                                                                                                                       | A re-plan needs a bounded round in the reconcile id. A distinct message needs a new operational-event CODE, which is schema (CLAUDE.md). That belongs with WP16's operations surfaces.                                                                                                                                                                    |
| **G5** | `lookupUser` refuses a found RickPanel/Marzban record with no `used_traffic` (MALFORMED), although the port allows `usage: null`.                                                                                                                                                                                                                   | Relaxing it would adopt with the ORDER's expiry instead of the panel's, silently. Settle `OQ-WP15-RICK-USED-TRAFFIC` first.                                                                                                                                                                                                                               |
| **G6** | A socket reset after the request was flushed is UNREACHABLE (safe to replay) for every adapter (`OQ-PROV-01` / `OQ-RP-09`).                                                                                                                                                                                                                         | The shared client classifies every probe and adapter. Changing it moves health semantics too, and it pairs with making Marzban's 409 non-adopting. It is its own reviewed change. H1 and H4 remove the two adapter-side and transport-side halves.                                                                                                        |
| **G7** | Adoption on reconcile has no provenance check for any provider (`OQ-RP-05`).                                                                                                                                                                                                                                                                        | Needs durable per-operation provenance: a schema change.                                                                                                                                                                                                                                                                                                  |

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
