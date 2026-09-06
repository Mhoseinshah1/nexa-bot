# ADR 0024 — The Web Admin says what it can actually do

Status: accepted (Phase 3D)

## Context

Phase 3D turns the approved Web Admin V2 preview into the production admin. The
preview drew fifteen product areas over mock data. The system it is being built
onto has nine endpoints' worth of behaviour: panels and providers, settings,
feature flags, templates, the operational log, notifications, readiness, build
info, administrators. There is no customer, service, order, product, payment,
wallet, reseller, discount, report, gateway or bot-runtime endpoint anywhere in
`main`, and there is no Telegram runtime.

That gap is the whole design problem. A preview is allowed to draw a Users table
over invented rows; an admin panel is not, because an operator acts on what it
shows. The legacy system this product replaces is a catalogue of exactly that
failure: a settings screen that answers "saved" and changes nothing
(SOURCE_BUG-002), a statistics screen that counts CONFIGURED panels and calls
them connected (RSV2-BR-021), two surfaces that compute "total revenue"
differently and differ by 38%.

## Decision

**A capability is labelled with what it can do, in one vocabulary, everywhere.**
`AVAILABLE NOW`, `BACKEND READY`, `PLANNED`, `PROVIDER UNSUPPORTED`. The badge
is rendered by one component with one hover explanation per value, so the
distinction cannot be made differently on two screens.

**A surface with no backend draws no control.** Not a disabled button, not a
greyed table of sample rows, not a search box that returns nothing. A disabled
control asserts "this exists and you lack permission"; an empty table asserts
"you have none of these". Both are false, and both are more misleading than an
honest page saying the capability is not built. Nine routes render that page,
and a test asserts per route that it contains no `button`, `input`, `select`,
`table` or `a`.

**What a route may claim is decided by the server, not by the browser.** Three
consequences, each of which could have been done the easy way in the client:

- The **management scope** on the operational log is a query the SQL applies
  (`scope=MANAGEMENT`), not a filter over the answer. Filtering a page of fifty
  rows down to two in the browser leaves the cursor having already walked past
  the other forty-eight, so paging drops rows silently — in a subsystem whose
  stated rule is that silence is the one outcome it may not produce. The
  classification lives in `@nexa/contracts` and is shared by the query and by
  the predicate a test calls.
- The **monitor cadence** is read from `GET system/monitor` rather than printed
  from a constant. The shipped health interval is three minutes and a deployment
  can configure anything the schema accepts; a panel stating "every 3 minutes"
  from its own bundle would be describing an installation that may not exist.
  The two capacity ceilings on that response are computed by the same functions
  the monitor's capacity conditions use, so the screen and the alarm cannot
  disagree about whether a fleet fits.
- Whether a setting **has a consumer** is a declared field on the frozen
  registry (`consumer: 'ACTIVE' | 'PLANNED'`), not a list held in the admin. A
  browser-side list of inert keys goes stale, silently, on the release a
  consumer lands.

**Money has exactly one renderer, and it cannot abbreviate.** It takes its unit
from the value rather than from the call site, and it scales exact decimal
strings rather than parsing them into a double. The preview's dashboard called
`tomanShort()` and rendered `۱۳ میلیون تومان` on every monetary tile, and its
`toman()` appended a hardcoded Toman to whatever it was handed.

## Consequences

Nine of fifteen navigation entries lead to a page that does nothing. That is
the point: an operator can see the product's shape and cannot mistake any of it
for working software. Each of those pages also carries the owner decisions
already fixed for the surface — no user tags, no protocol column, no
least-loaded routing, no receipt storage, server-side ordering, the one-hour
payment expiry — so the rules are recorded where whoever builds the surface
will find them rather than being rediscovered the expensive way.

The maturity vocabulary has to be maintained. A capability that ships and keeps
its `PLANNED` badge is a new lie in the same place the old ones were, so moving
a label is part of the commit that ships the behaviour, and for settings it is a
one-word contract change that makes that hard to forget.

Four settings ship with no consumer at all — the store currency, the support
accounts, the channels and the top-up minimum. They are genuinely stored,
validated, versioned and audited, and the screen says plainly that nothing reads
them yet. The risk accepted here is real and narrow: an operator can configure
required channel membership that nothing enforces. The alternative — refusing to
store what the owner asked to configure — would have left the same operator with
no way to record the decision at all.

## What this does not decide

The per-gateway minimum top-up in owner revision 24 is **blocked**, not
deferred. No payment gateway is registered anywhere in this system, so there is
nothing for a per-gateway override to be keyed by, and the precedence rule
cannot be expressed without inventing a gateway registry. The global default
ships; the setting's own description and the Settings screen both say why the
override is missing.
