# Phase 4H falsification — the lane that tells a customer

Every rule Phase 4H introduces, reverted one at a time, with the committed test
that fails as a result. `scripts/falsify.sh` applies the mutation, runs the named
file, restores the tree and refuses to report anything if the restore is not
byte-identical.

This file grows with the phase. It starts with the contracts commit, because a
vocabulary can be wrong in exactly one interesting way — a machine nothing
validates — and that is worth proving before anything is built on it.

## The vocabulary

| #      | Rule                                                                  | Mutation                                      | Named test                                                        | Result |
| ------ | --------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- | ------ |
| F4H-01 | `CUSTOMER_NOTIFICATION_MACHINE` is registered and therefore validated | the `PENDING → SUPERSEDED` transition deleted | `contracts-invariants.test.ts` › validates every declared machine | KILLED |

F4H-01 is the row this phase's vocabulary needed most, and the reason is the
shape of the machine rather than the machine being new. Every state in it except
the initial one is terminal, so a dropped edge does not leave a dead end — the
failure a reader notices — it leaves a state UNREACHABLE, which nothing about
reading the file would reveal. Deleting the `SUPERSEDE` edge produced exactly
that, naming the machine:

```
"machine": "CustomerNotification",
"message": "State \"SUPERSEDED\" cannot be reached from \"PENDING\".",
"state": "SUPERSEDED",
```

Registering a machine in `STATE_MACHINES` is one line and forgetting it is
silent, which is why the mutation is worth running rather than assuming: a
machine declared and not registered is a machine nothing checks, and it would
have passed every other test in the suite.
