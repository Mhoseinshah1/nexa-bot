# Phase 6C audit — what exists, what is partial, what is a genuine gap

Base: `main` at `75e62e2f15b37cad4ad61756fce4b19104bf1030` (PRs #50 → #51 → #52 → #53
merged; 90 integration files / 1814 tests green).

This audit exists to stop Deliverable A being built on an assumption. Five findings below
changed the design before any code was written; the rest is a map from each 6C requirement
to existing code, partial code, or a gap.

---

## Part 1 — Deliverable A: the username story as it actually is

### A-1. The CUSTOM/RANDOM modes do not exist in this codebase

The directive describes "the existing formal modes" and names two Telegram buttons,
`✍️ انتخاب یوزرنیم دلخواه` and `🎲 یوزرنیم تصادفی`. Neither string, nor any
customer-facing username choice, exists anywhere in `packages/i18n` or
`apps/api/src/surfaces`:

```
$ grep -rc "یوزرنیم" packages/i18n/src/catalogue.fa.ts
0
```

They come from the legacy MirzaBot corpus under `docs/research/`, which `CLAUDE.md`
classifies as **evidence, not specification**. A customer of the current product is never
asked for a username and never chooses between modes.

**Consequence for the work.** Deliverable A is not "preserve two modes that exist" — it
**builds** both modes. What exists today is a third thing, described next, which becomes
the legacy compatibility path required by directive item 5. Nothing is being removed,
because there is nothing yet to remove.

### A-2. What the product does today: one derived name, 34 characters

`packages/contracts/src/provisioning.ts`:

```ts
export const PROVIDER_USERNAME_PREFIX = 'nx';

export function providerUsernameFor(serviceId: string): string {
  const compact = serviceId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error('a provider username is derived from a UUID service id');
  }
  return `${PROVIDER_USERNAME_PREFIX}${compact}`;
}
```

So every username in production is `nx` + the service UUID's 32 hex characters — **34
characters, lowercase, letter-first**. There is no stored setting, no per-panel
configuration and no alternative path. Two production call sites:

| Site                                           | What it does                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `provisioning.service.ts:297`                  | writes `providerUsername` onto the new `services` row, in the settling transaction |
| `provision-executor.ts:115` (`providerRefFor`) | builds the `ProviderUserRef` for **every** provider call                           |

**This is the legacy generator the compatibility rule must preserve**, and it is
unambiguous: there are no legacy settings to read, because the behaviour is a pure
function with no configuration. Directive item 5's "if legacy settings are absent or
ambiguous, preserve the existing generation path for those rows" therefore resolves
cleanly — a panel with no template keeps `providerUsernameFor`, and the compatibility
decision needs no guess and no customer test.

### A-3. The derived name is load-bearing for reconciliation, and the docblock says so

> Deterministic from the service id, which is the property that makes adoption possible:
> after an unknown outcome, a reconcile can ASK the provider for this exact name. **A
> random or customer-chosen name would leave nothing to ask for**, and the only remaining
> move would be a blind create.

Taken literally this forbids Deliverable A. It is not literally true any more, and the
reason is already in the schema three columns away: `services.subscription_ref` used to be
derived too, and migration `0045_unguessable_service_identities` made it **stored**, with
this rationale:

> Stored rather than derived loses nothing: it is written BEFORE any provider call, so a
> create whose answer was lost can still be reconciled against it — which is the only
> property the derivation was there to provide.

**The same argument transfers exactly.** A username committed before the provider call is
askable-for after a lost answer whether it was derived, typed by a customer, or rendered
from a template. The property reconciliation needs is _committed before the call_, not
_recomputable_. Deliverable A's "freeze before payment, reuse everywhere" is the stronger
form of the same guarantee.

`providerUsernameFor`'s docblock is now wrong on this point and is corrected as part of
the implementation, not left to mislead the next reader.

### A-4. **The stored username and the username sent to the provider are two different expressions**

This is the finding that decides whether Deliverable A can work at all.

```ts
// provision-executor.ts — built for EVERY provider call
export function providerRefFor(service: { readonly id: string; ... }): ProviderUserRef {
  return {
    username: providerUsernameFor(service.id),   // ← recomputed
    subscriptionRef: service.subscriptionRef,    // ← read from the row
    clientId: service.providerClientId,          // ← read from the row
  };
}
```

`service.providerUsername` is **stored on the row and then never read on this path**.
The two agree today only because generation is a deterministic function of `service.id`.

The moment a username is customer-chosen or template-rendered, they diverge silently: the
`services` row records one name, the panel is asked to create another, `services_panel_provider_username_key`
guards a value nobody sent, and reconciliation asks for a name that was never created.
There is no test that would catch it, because every existing test asserts
`service.providerUsername === providerUsernameFor(service.id)` — the identity that is
about to stop holding.

**Fix, and it is one line plus its consequences:** `providerRefFor` reads
`service.providerUsername`. The two other fields already do. A falsification mutation on
this line is mandatory.

### A-5. Uniqueness is per panel; panels can share a provider namespace

`services_panel_provider_username_key` is `UNIQUE (panel_id, provider_username)` — added
in `0032_phase4_commerce`, with the stated purpose of making adoption safe.

`panels` has exactly one unique index, `panels_tenant_name_live_key` on the _name_. There
is **no constraint on `base_url`**, so two panel rows — in one tenant or in two — may point
at the same Marzban or 3X-UI host. Those panels share one provider account namespace, and
per-panel uniqueness does not see across them.

Today this is harmless: a derived name is globally unique because a UUID is. **A CUSTOM
name is not**, so the exposure is created by this deliverable.

Decision, recorded per the directive's instruction to resolve routine choices from existing
code and continue:

The CUSTOM baseline was corrected by the owner after this audit was written, and the
correction is recorded here rather than left to the commit log: usernames are
**case-insensitive**. A customer may type either case and `-` as well as `_`; the input
must carry at least one English letter and at least one digit; whitespace is **refused
rather than trimmed**; and the ASCII case fold is the only rewrite permitted, applied
once at the boundary so `Ali_2026` and `ali_2026` are one identity that collides on one
reservation. The letter-first rule this audit originally assumed is gone.

- the username **reservation** is keyed on a derived **namespace key** — `provider_type`
  plus the normalised host and port of `base_url` — not on `panel_id`, so two panels on one
  host contend for one name as they should;
- `services_panel_provider_username_key` is **left exactly as it is**. It is a different
  guarantee (at most one service row claims a name on a panel) and narrowing or widening it
  would be a migration against live rows for no gain;
- a definitive provider-side conflict that survives both — an account an operator created
  by hand, on a host this installation does not fully own — is a **definitive non-delivery**
  and follows the money table: refuse before debit, refund exactly once after it. The
  unrelated account is never adopted and never overwritten.

Cross-panel-same-host is a configuration an operator can create and this installation
cannot currently detect; the namespace key is the mitigation, and the provider conflict is
the backstop. Recorded as an evidence gap in Part 4.

### A-6. Reservation lifecycle: the capacity precedent does not transfer

`panel_capacity_reservations` has `expires_at`, and the capacity query filters on it rather
than relying on a sweep — deliberately, so an abandoned checkout cannot hold a slot for
ever.

**A username hold must not work that way.** The directive is explicit: "TTL expiry must not
make it reusable" once an operation is funded, and "never free an identity whose remote
existence is still ambiguous." A TTL that frees a funded name lets a second customer
reserve a name the first has already had created on a panel.

So the two lifecycles are separate, and the difference is _funding_:

| Hold          | Freed by TTL?           | Freed on terminal non-delivery? | Freed on success?                          |
| ------------- | ----------------------- | ------------------------------- | ------------------------------------------ |
| capacity slot | yes, while unfunded     | yes                             | consumed into the service                  |
| username      | **only while unfunded** | yes, once the refund commits    | consumed into `services.provider_username` |

An `UNRECONCILED` service is _ambiguous_, not terminal, and releases nothing.

---

## Part 2 — the money question the 6B report left ambiguous

The directive asks this to be inspected rather than assumed from the report's wording. It
was, and **the code is already correct**; the report's sentence was the imprecise thing.

`payment.service.ts` `confirmAndSettle`:

```ts
const onIneligible = confirmation.evidenceKind === 'WALLET_DEBIT' ? 'REFUSE' : 'REFUND';
```

- `WALLET_DEBIT` — the debit is written _in this transaction_. `REFUSE` throws, the
  transaction rolls back, and the debit dies with it. The customer's wallet is untouched and
  no refund credit is minted. This is **refusal before a committed debit**, exactly row 1 of
  the money table.
- `OPERATOR_REVIEW` — the bank transfer arrived days ago. `REFUND` confirms the payment
  honestly and credits the wallet. Row 3.

**Failure _after_ a committed wallet debit** — the provisioner discovering hours later that
the panel will not create the account — is row 2, and is handled by
`ProvisionerService.refundPurchase` → `UndeliverableOrderRefunder.refund(from: 'PAID')` →
`RefundService.refundUndeliverable`. The same single credit path. It does not distinguish
how the order was funded, and it should not: by then the money has moved either way.

So "a wallet purchase is refused, never refunded" is true **only of the settling
transaction**, and `CLAUDE.md` states it without that qualifier. That is a documentation
defect, not a code defect, and it is corrected in `CLAUDE.md` as part of this work rather
than left to be re-derived by the next reader.

No code change is required by the money table. The 6C flows reuse
`RefundService.refundUndeliverable` unchanged.

---

## Part 3 — Deliverable B: requirement → current state

| 6C requirement                                            | State                                | Where                                                                   |
| --------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Catalogue lists only eligible products                    | **exists**                           | `decideEligibility`, one evaluator, four callers                        |
| Deterministic pagination, no dupes                        | **exists**                           | keyset cursor, `SERVICES_PAGE_MAX`                                      |
| Ineligible between display and confirm                    | **exists**                           | re-decided under the panel lock at confirmation and again at settlement |
| New purchase: select → confirm → pay → settle → provision | **exists**, but has no username step | `OrderService`, `PaymentService`, `ProvisionerService`                  |
| Wallet eligibility checked immediately before debit       | **exists**                           | `confirmAndSettle`, `onIneligible = 'REFUSE'`                           |
| Definitive failure after debit → refund once              | **exists**                           | `refundPurchase` → one credit path                                      |
| Duplicate callbacks create nothing twice                  | **exists**                           | idempotency key + `ON CONFLICT` + conditional transitions               |
| Success shows username, sub link, expiry, allowance       | **partial**                          | shown; username will become the frozen value                            |
| My services: own services only, paginated                 | **exists**                           | `services-http`, Telegram `/services`                                   |
| Service detail: status, usage, expiry, sub link           | **exists**                           | usage via `SYNC_USAGE`, `usage_synced_at` rendered                      |
| Renewal preserves username and identity                   | **exists**                           | commercial actions act on the existing service                          |
| Add traffic / add time, no new capacity slot              | **exists**                           | R4-N1 fixed exactly this                                                |
| Failed renewal must not terminate the service             | **needs a test**                     | believed correct; no named test asserts it                              |
| Customer notifications for the six outcomes               | **partial**                          | `CUSTOMER_NOTIFICATION_KINDS` is a closed set; some kinds missing       |
| Admin notifications                                       | **partial**                          | operational events exist; some summaries missing                        |
| Expiry reminders (3d / 1d / expired)                      | **gap**                              | no reminder lane exists                                                 |
| Usage reminders (80 / 95 / 100 %)                         | **gap**                              | usage is synced; nothing reads it for thresholds                        |
| Provider unavailability ≠ zero usage                      | **exists**                           | `usage_synced_at` nullable and rendered                                 |
| One commercial action implementation                      | **exists**                           | `CommercialActionService`                                               |
| Integer money everywhere                                  | **exists**                           | `bigint` minor units + currency                                         |
| Currency-change guard preserved                           | **exists**                           | `SalesCurrencyChangeGuard`, merged in #50                               |
| Frozen order snapshots                                    | **exists**                           | order line carries the snapshot                                         |

**Genuine gaps: the username policy (all of Deliverable A), the reminder lane, and the
missing notification kinds.** Everything else is reuse, plus tests for rules that hold but
are unproven.

---

## Part 4 — evidence gaps, stated as gaps

1. **No real-panel acceptance in this work.** `pnpm test:acceptance` needs a disposable
   Marzban and 3X-UI and is not run here. Per `CLAUDE.md`, a fake this repository wrote and
   an adapter this repository wrote can only prove they agree with each other. Every
   provider-facing claim below rests on the fakes. The owner's deferred manual acceptance is
   what closes this, and the checklist is prepared at the end of the work.
2. **Provider username constraints are not declared by the adapters.** `ProviderAdapter`
   exposes no maximum length or character class, and Marzban's and Sanaei's real limits
   are unverified — `docs/open-questions.md`, OQ-6C-01.

   _Corrected during implementation._ This item originally recorded the directive's
   fallback of 64 characters. Sixty-four is a guess, and it is the wrong SHAPE of guess:
   it lets an operator save a 60-character template and makes the first customer past the
   provider's real limit discover it after their money moved. The shipped constant is
   `PROVEN_PROVIDER_USERNAME_MAX_LENGTH` = 34 — `nx` plus 32 hex, the only length this
   product has ever created an account with on a real panel. It is not a claim about
   either provider, and raising it is a real-panel acceptance task.

3. **Cross-panel-same-host namespaces** (A-5) cannot be detected from the schema; the
   namespace key mitigates and the provider conflict is the backstop.

---

## Part 5 — what this audit changed before any code was written

1. Deliverable A **builds** CUSTOM/RANDOM rather than preserving them (A-1).
2. The legacy path is a pure function with no settings, so compatibility is exact and needs
   no guess (A-2).
3. Reconciliation's requirement is _committed before the call_, not _recomputable_; the
   `subscription_ref` migration already made this argument (A-3).
4. `providerRefFor` must read the stored username. Without this one line the whole
   deliverable silently sends the wrong name to the panel (A-4).
5. Username holds are keyed on a provider namespace, not a panel, and are not freed by TTL
   once funded (A-5, A-6).
6. The money rules need no code change; `CLAUDE.md`'s wording needs a qualifier (Part 2).
