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

## Corrections from the adversarial pass

A read of the whole diff against this ADR's own standard found that the
management-alerts classification was itself an example of what the ADR is
against: it asserted coverage the server could not deliver.

**Four of the ten declared codes could not appear.** `internal.unhandled` is an
HTTP error-response code and `notification.attempts_exhausted` is a
delivery-attempt `errorCode`; neither is ever recorded as an operational event.
The two `panel.monitor.scheduler_capacity_*` codes are recorded, but under
`SYSTEM_SCOPE` with a null tenant, and the log reader begins with
`requireTenantId` — so no query could return them. And
`MANAGEMENT_EVENT_CODE_PREFIXES = ['admin.']` matched nothing at all, because
`admin.create` and its siblings are audit-log `action` values. Every test that
covered this classification invented its own code, so none of it was visible.

Three consequences, and they are the shape of the fix:

- The registry now carries only codes some production path writes, enforced by
  a test that names the recorder for each and fails if that file stops writing
  it. Owner revision 24's administrator changes are delivered by RECORDING
  them — `admin.created`, `admin.status_changed`, `admin.roles_changed`,
  `admin.password_changed`, beside the audit rows they already produced — not
  by a prefix that matched the wrong vocabulary.
- The installation capacity condition reaches the operator through
  `GET /system/monitor`, which is installation-scoped by construction and so
  can answer for a row the tenant-scoped reader deliberately cannot reach.
- The scope is **split**. `MANAGEMENT_CONDITIONS` holds only codes something
  closes; `MANAGEMENT` holds those plus the one-shot records. This matters
  because `access.permission_denied` writes a fresh row per denial with no
  dedupe key and no recovery, and this product has no "mark as seen" by
  design. On a card headed "needs attention" those rows accumulate for the life
  of the installation — the same burial the management scope exists to prevent,
  reached from the other direction. The dashboard asks for conditions; the
  alerts page shows the management scope as history.

**`GET /system/monitor` is guarded by `panels.view`, and that is a deliberate
choice rather than an oversight.** The response describes the whole
installation — batch size, concurrency, tick, the global ceiling — while
`panels.view` is a tenant-scoped, LOW-risk permission, and this codebase
otherwise puts cross-tenant reads behind `tenant.cross_read` (CRITICAL). The
facts here are configuration an operator needs in order to read their own
panels' freshness correctly, they name no other tenant and no secret, and a
separate permission nobody could be denied would be a permission that exists to
be looked at rather than enforced. Revisit if the product ever serves tenants
who are not colleagues.

**Owner revision 25's cost is accepted and worth stating.** Removing the
general log browser leaves the routine operational stream — panel health
transitions, delivery attempts — readable only through the Telegram report
group, which is gated twice by default: `ops.notifications.min_severity`
defaults to `ERROR`, and `ops.notifications.telegram_chat_id` defaults to
empty. On a fresh installation that has not configured an ops chat, a `WARN`
health flap is therefore recorded and surfaced nowhere. The owner asked for the
browser to go, so it went; the System screen names where the stream is meant to
land, and this paragraph is the record that the default configuration does not
yet send it anywhere.

## The content-security policy is part of the component contract

The production document policy is `style-src 'self'`, which blocks element
`style` **attributes**, not just `<style>` blocks. Four components set one, so
in the deployment — and nowhere else — the dashboard's distribution bars lost
their widths, both reorder chevrons pointed the same way, and table alignment
was dropped. jsdom applies inline styles, Vite emits them, and every test was
green.

Three of the four became classes. The fourth could not: a distribution bar's
width is a continuous value, and every way of expressing one — a `style`
attribute, a CSS custom property written through one, an injected `<style>`
block — is what the policy blocks. It is now an SVG `rect`, whose geometry is
a presentation **attribute** and therefore outside `style-src` entirely.

`tests/web/csp.test.tsx` holds the rule in both directions: the policy still
says what the components assume, and no source or rendered element carries a
`style` attribute. Loosening the policy to `'unsafe-inline'` would fail that
test rather than quietly widen it, which is the point — a deliberate change to
the policy should be a deliberate change to this file.
