# Phase 6A falsification — the service lifecycle, on every surface

Every production rule Phase 6A introduces, reverted one at a time, with the
committed test that fails as a result. A rule with no test is a rule the next
commit reverts silently; a test that stays green under mutation is not a test.

The phase landed in three pull requests. 6A-1 gave the product the operator's
seven service actions, the availability evaluator behind them and the routes
that charge their permissions; 6A-2 and 6A-3 put those actions on the Web Admin
and gave a customer a second page of services; 6A-4 built the Telegram
management panel's services section and 6A-5 settled what a failure does and who
is told about it. This record covers the last two — the first two are certified
in their own pull requests, and nothing here inherits their rows.

## 6A-4: the admin panel's services section

Fifteen mutations against `apps/api/src/surfaces/telegram/bot-runtime.ts`, each
run against `tests/integration/telegram-admin-services.test.ts`.

| #      | Rule                                                                | Mutation                                           | Named test                                                                             | Result |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| F6A-01 | every `ADMIN_*` intent is routed to `adminTurn`                     | the services intents excluded from `ADMIN_INTENTS` | _queues the two states nothing resolves on its own, and nothing else_                  | KILLED |
| F6A-02 | `services.view` alone opens the panel                               | the third arm dropped from `adminTurn`'s gate      | _draws the Services button for an administrator who holds services.view_               | KILLED |
| F6A-03 | the Services button is drawn only for `services.view`               | the condition replaced with `true`                 | _draws no Services button for an administrator whose role does not hold services.view_ | KILLED |
| F6A-04 | the main menu offers the panel to a services-only administrator     | the third arm dropped from `isAdmin`               | _opens the panel for an administrator whose ONLY section is Services_                  | KILLED |
| F6A-05 | a button needs the administrator's permission                       | the permission half of the filter removed          | _offers an administrator holding services.view alone no action at all_                 | KILLED |
| F6A-06 | a button needs the server's verdict                                 | the availability half of the filter removed        | _offers an owner the actions the service allows, and the end button only ASKS_         | KILLED |
| F6A-07 | the detail's terminate button ASKS                                  | its prefix pointed at the destructive callback     | _offers an owner the actions the service allows, and the end button only ASKS_         | KILLED |
| F6A-08 | the confirmation screen re-checks `services.terminate`              | the permission check deleted                       | _refuses the terminate question to an administrator without services.terminate_        | KILLED |
| F6A-09 | the confirmation screen re-reads the verdict                        | the verdict check made unreachable                 | _answers the terminate question with a refusal once the service is already ended_      | KILLED |
| F6A-10 | the queue searches undelivered services too                         | the second search dropped from the list            | _queues the two states nothing resolves on its own, and nothing else_                  | KILLED |
| F6A-11 | the queue de-duplicates by service id                               | the `seen` check made unreachable                  | _queues a service that is BOTH unreconciled and undelivered exactly once_              | KILLED |
| F6A-12 | a queued row is labelled with the provider username                 | labelled with the subscription ref instead         | _labels a queued service with the provider username and never with a credential_       | KILLED |
| F6A-13 | the detail carries no subscription URL                              | the username field fed the subscription URL        | _carries no subscription URL, subscription ref, client id or panel credential_         | KILLED |
| F6A-14 | a service refusal is answered, not thrown                           | the `isServiceRefusal` branch removed              | _draws no action a 3X-UI panel cannot perform, and refuses it if asked anyway_         | KILLED |
| F6A-15 | the detail reports the latest operation's STATE as well as its type | the state dropped from the rendered value          | _carries the identity, both states, usage, expiry and the latest operation_            | KILLED |

F6A-01 is the row this file exists for, because the defect was live rather than
hypothetical. `ADMIN_INTENTS` was a hand-kept list of every intent named
`ADMIN_*` — a duplicate of a naming convention — and the ten intents this phase
added went into `BOT_INTENTS`, into `adminTurn`'s switch, and not into the list.
So `act` never routed them and every services button answered
`bot.unknown_command`: the same reply an ordinary customer gets, which is
exactly why nothing about it looked broken. The set is derived from the names
now, and the mutation re-creates the omission.

F6A-05 and F6A-06 are the same filter reverted in two directions, and both
halves are load-bearing. Without the permission half, an operator holding
`services.edit` is shown a terminate button whose every press records a denial.
Without the verdict half, a 3X-UI service is offered a suspend the provider
cannot perform. Neither is authorization — every action re-checks its own
permission and all its conditions inside its own request, which the cases that
send each callback anyway assert separately.

F6A-07 is one letter. `P:` asks and `Q:` acts, the two differ by a single
character in a table, and a mis-wiring makes the detail screen a one-tap
deletion of somebody's account.

### The two mutations that survived, and the checks they removed

`/service <id>` re-validated its argument with `safeParse`, and refused a bare
`/service` before looking anything up. Both were reverted and both SURVIVED:
`ServiceAdminService.get` runs every id through `serviceIdOrNotFound`, so a
malformed id and an empty one are already `SERVICE_NOT_FOUND`, which this
handler renders as `bot.admin.service_gone` either way.

Both were deleted rather than given tests they could not fail. The danger is not
the dead code — it is the next reader taking a guard that cannot fail for the
one holding the line, and removing the one that is. The answer now has a single
place it is decided, which is also where the permission is charged first, so an
administrator without `services.view` cannot learn whether an id is even
well-formed. _answers a malformed or missing /service argument as unknown, not
as a failed cast_ covers both shapes against the surviving mechanism.

## 6A-5: who is told about an operation

| #      | Rule                                                        | Mutation                                  | Named test                                                                       | Result |
| ------ | ----------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| F6A-16 | only an operation a CUSTOMER requested is announced to them | the `requestedByCustomerId` check removed | _says nothing about an operation an OPERATOR asked for, of any requestable type_ | KILLED |

The rule replaces one that had been sound until 6A-1 and silently stopped being
so. `CUSTOMER_REQUESTABLE_OPERATIONS` decided from the operation's TYPE, which
worked while `SUSPEND`, `RESUME` and `TERMINATE` were reachable only from the
customer's own detail screen. An operator's suspend writes an identical row, so
the customer received «درخواست شما با موفقیت روی سرور اعمال شد» — YOUR request
— having made none, and on the failing side was invited to retry a terminate an
operator had ordered.

Reverting the check queues `SERVICE_ACTION_SUCCEEDED` for an operator-requested
`SUSPEND`:

```
× says nothing about an operation an OPERATOR asked for, of any requestable type
  AssertionError: SUSPEND/SUCCEEDED asked for by an operator:
    expected [ { customerId: 'customer-1', …(2) } ] to deeply equal []
```

Two cases guard the narrowing from spreading. _still announces a PROVISION delay
that no customer requested_ covers the branch 4H added — a customer waiting on a
link they paid for is owed that message precisely because they did not ask for
anything — and _still tells the customer about a suspend they asked for
themselves_ covers the same operation type on the same service with the only
difference being the column.
