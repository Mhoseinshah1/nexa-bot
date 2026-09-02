# ADR-0015 — Trial allowance semantics

**Status:** Accepted as **product policy**. Resolves `UNK-GTL-002`, `UNK-GTL-006`
and `O-5`.

**Not implemented in Phase 1.** This ADR records the semantics; the tables and
the flow belong with service provisioning. Creating a `trial_allowance` table
now would be a table with no producer and no reader — the placeholder pattern
this codebase exists to avoid. What it changes today is that the design is
settled, so whoever builds provisioning is not guessing.

## The model

Two numbers, stored separately. Never one field doing both jobs.

| Concept   | Meaning                                                      |
| --------- | ------------------------------------------------------------ |
| **limit** | How many trials this customer may have in the current cycle. |
| **used**  | How many they have taken in the current cycle.               |
| remaining | Derived: `limit − used`. Never stored.                       |

There is a **global default trial limit** for the installation. A customer with
no override inherits it.

## Per-customer overrides

A customer may carry a **persistent custom limit** that replaces the global
default for them:

```
global limit = 1
customer A: custom limit = 5   →  A may take 5
```

The override is a property of the customer, not of a cycle.

## Global reset

An administrator can reset trial consumption for everyone:

```
used → 0
```

A global reset **does not touch custom limits**:

```
before:  custom limit = 5, used = 3
after:   custom limit = 5, used = 0
```

Removing an override returns that customer to the global default. It does not
set their limit to the default's value — it removes the override, so a later
change to the global default applies to them again.

That distinction is the whole reason the two are separate columns. A single
"remaining" field cannot express it: a reset would have to overwrite the
override to restore the allowance, and the override would be silently destroyed
by an unrelated administrative action.

## Zero means zero

`0` means **no trials allowed**. It never means unlimited.

If unlimited trials are ever needed, that is a separate, explicit policy state —
never `0` reinterpreted, and never a very large number standing in for it. This
is the direct answer to `UNK-GTL-002/006`, where the legacy system exposes one
number and nothing distinguishes "none left", "none permitted" and "unmetered".

## The administrative view this implies

"Customers with custom trial limits", showing per customer: the custom limit,
used, and remaining. With actions to set or change the custom limit, and to
remove the override.

Two constraints on that screen, both from documented legacy failures:

- It must **echo the stored value**. Roughly fifteen legacy settings screens
  never do, so the only way to read a price there is to overwrite it.
- The global reset is a bulk operation and therefore falls under ADR-0010:
  dry-run, affected count, explicit confirmation, audited execution, recorded
  result. The legacy system's bulk tools have none of these, and one button
  deletes six order classes on a single press.

## What Phase 1 does about it

Nothing in the schema. The semantics are recorded here and the corresponding
rows in `docs/open-questions.md` are closed against this ADR.
