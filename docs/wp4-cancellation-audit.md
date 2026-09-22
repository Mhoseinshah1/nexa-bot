# WP4 — order-cancellation concurrency and audit correctness

Written before any code, against `main` at `0885b99`. Its job is to say what
already holds, what does not, and which of the brief's requirements are
therefore already met — because the expensive mistake here is re-implementing a
guarantee that exists and calling the duplicate a fix.

The reported symptom: two concurrent customer cancellations leave **one state
transition and two `order.cancel` audit rows**.

---

## 1. The surface, and how two requests get two idempotency keys

`OrderService.cancelByCustomer` has exactly one production caller:
`BotRuntime.cancelOrder` (`bot-runtime.ts:6853`). **There is no HTTP route.** A
search for the method across `apps/api/src` finds the service, the Telegram
caller, and tests — nothing else.

The key is per-UPDATE:

```
webhook.controller.ts:159   telegramUpdateKey(botInstance.id, updateId)
bot-runtime.ts:6854         `${idempotencyKey}:cancel-order`
```

That distinction decides which of the brief's two concurrency requirements is
which, and they are different mechanisms:

| what the customer does         | update id         | idempotency key        | collapsed by the replay guard? |
| ------------------------------ | ----------------- | ---------------------- | ------------------------------ |
| taps the button twice, fast    | two different ids | **two different keys** | **no**                         |
| Telegram redelivers one update | the same id       | the same key           | yes                            |

So "two different idempotency keys racing" is not a theoretical HTTP-retry case.
It is a customer double-tapping an inline button, which is the single most
likely thing a customer does when a reply is slow.

## 2. What already holds — do not rebuild these

Verified by reading the code, not assumed:

- **Authorization is already rechecked inside the mutation transaction.**
  `runAuthorizedMutation` opens the unit of work and then calls
  `assertSessionStillLive` and `guard.check(scope, actor, permission, tx)`
  INSIDE it (`authorized-mutation.ts:81-85`). The brief's "recheck authorization
  inside the mutation transaction when stale authorization could matter" is met.
- **Tenant scope is inside too** — the same transaction, and
  `repository.findById(scope, …)` is scope-argumented.
- **`assertScopeActive`** runs inside the transaction, per the repository-wide
  rule.
- **Both releases are genuinely idempotent**, structurally rather than by
  convention. Each is a single `DELETE … WHERE tenant_id = ? AND order_id = ?`
  returning a boolean — `drizzle-panel-capacity.repository.ts:260` and
  `drizzle-service-username.repository.ts:195`. A second call deletes nothing
  and returns `false`. So the brief's "duplicate hold release" and "duplicate
  username release" are ALREADY safe. They still need tests, because the brief
  names them, but they do not need code.
- **A paid, settling, fulfilled, provisioning or refunded order is already
  protected**: anything other than `AWAITING_PAYMENT` throws
  `ORDER_STATE_INVALID`, and a claimed pending transfer throws
  `ORDER_TRANSFER_UNDER_REVIEW` — asked twice, once before the withdrawal and
  again after it, which is the PR #30 Codex fix.
- **A lost transition is not reported as a cancellation.** The guard that throws
  when nothing moved and the order is not already `CANCELLED` is the PR #30 fix
  for exactly that.
- **`runAuthorizedMutation` is not a second audit writer.** It records only
  DENIED rows, and only for this permission's own denial.

There is exactly **one** writer of a SUCCESS `order.cancel` audit row
(`order.service.ts:1303`); the other two occurrences of the action string are
denial descriptors.

## 3. The defect, exactly

Two racers, both entering with `before.state === 'AWAITING_PAYMENT'`.

The winner transitions and commits. The loser's conditional UPDATE matches no
row, so `changed === false` — but by then the winner has committed, so its
re-read gives `after.state === 'CANCELLED'`, and the guard at
`order.service.ts:1262` lets it **fall through**. The loser then:

1. writes a second `order.cancel` audit row with `result: 'SUCCESS'`,
   `changed: false` and `paymentsWithdrawn: 0`;
2. writes its own `rememberOnce` record under its own key;
3. re-runs both releases (harmless — see §2).

Falling through is correct for the RESULT: the customer asked for the order to
be cancelled and it is cancelled, so answering them with the row is right, and
that behaviour must be preserved. What is wrong is that the loser **claims to
have performed** the cancellation in the audit log.

**The asymmetry is what proves it is a defect rather than a policy.** A request
arriving after the cancellation has committed — `before.state === 'CANCELLED'`
at the first read — takes the early return at `order.service.ts:1165`, which
writes `rememberOnce` and **no audit row at all**. Same customer, same intent,
same end state; one audit row or two depending purely on interleaving. An audit
log whose row count depends on timing cannot answer "who cancelled this order,
and when" — which is the only question it exists to answer.

## 4. Verified negatives — things the brief lists that are not reachable here

Recorded so the tests assert them rather than guarding against them:

- **No duplicate notification.** `cancelByCustomer` enqueues no customer
  notification and writes no outbox row. The `ORDER_CANCELLED` fallback at
  `bot-runtime.ts:6864` is a surface-level fallback for an undeliverable
  interactive reply, outside the transaction; two taps produce two replies
  because the customer tapped twice, which is correct.
- **No duplicate payment-side effect.** `withdrawPendingFor` is a conditional
  UPDATE over `PENDING` rows; the loser's finds none and returns `[]`.

## 5. The fix

One rule: **the audit row belongs to the transaction that performed the
transition.** Write it only when `changed` is true, which also makes the two
already-cancelled paths symmetric — neither claims a cancellation it did not
perform, and both still answer the customer with the order.

Everything else in §2 stays exactly as it is. The releases stay unconditional
and are deliberately re-run, because a winner that cancelled and then died
before releasing would otherwise leave the hold standing until its deadline.

## 6. What the tests must prove

Beyond the brief's list, two shapes matter most:

- a **genuinely concurrent** pair — both transactions open before either
  commits — rather than two sequential calls, which cannot reproduce this at
  all; and
- the **symmetry**: the after-the-fact request and the losing racer must leave
  the same number of audit rows, because that difference is the defect.

Required mutations, each reverted alone: the conditional state-transition guard;
the winner check before the audit; the transaction boundary; the
idempotency/replay guard; tenant and authorization scoping. Every result
recorded, including any that survives.

All of them were run, and the results are in `docs/wp4-falsification.md`: M1 the
transition guard, M2 the winner check, M3 the replay guard, M5 ownership, M6
tenancy, and M7–M9 authorization. Two results are recorded there in prose rather
than as table rows, because neither kills a test and a row must name one:

- the **transaction boundary** — dropping `tx` from the audit write SURVIVED, and
  the reason is structural. No path in this suite rolls back after the audit
  write is reached, so there is no interleaving that could observe it. Recorded
  as a rule with no test rather than reported as covered.
- the **inner permission check** alone. Charging the permission twice — once
  before the replay lookup, once inside the transaction — means removing either
  one by itself leaves every case green. That is two guards, not an untested
  rule, so M9 removes both at once; M8 isolates what only the early one does.
