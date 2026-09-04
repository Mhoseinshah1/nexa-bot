# ADR-0023 — Providers, panels, credentials and health

**Status:** Accepted. Implemented in Phase 3A. Phases 3B–3D extend it without
changing the decisions here.

## The problem

Nexa has to talk to the panels an operator already runs. The legacy product did
that, and the corpus records how badly:

- A panel was accepted with a provably unreachable host and a bogus token, and
  the operator was told `تبریک پنل شما با موفقیت اضافه گردید` — "your panel was
  added successfully" (`SOURCE_BUG-XUI-001`). Whether the panel worked was
  discovered later, if at all.
- The web admin rendered a panel's stored password as readable text on its
  detail page (`WEB-BR-007`).
- The statistics screen counted panels that were _configured_ and reported them
  as _connected_, which is the same mistake in reverse: a state nobody measured,
  displayed as a measurement.

Those are three faces of one problem — the system never distinguished "an
operator typed something" from "the thing they typed works" — and everything
below is arranged so that distinction cannot collapse again.

## What this phase is not

No purchase, no provisioning, no subscription delivery, no reseller flow, no
Telegram surface. A panel can be configured, its credentials replaced, and its
connection tested. Nothing consumes a panel yet.

## Decisions

### Provider types are code, not rows

`PROVIDER_TYPES` is a frozen contract enum and `PROVIDER_DESCRIPTORS` is a
catalogue of code. A provider type is a _capability of this release_ — the
adapter either ships or it does not — so a persisted definition would be a
promise the binary cannot keep. Rows would let an operator name a provider this
build cannot construct, which is the same shape as the legacy bug above.

Two checks, in two layers, and both are load-bearing:

- the `panels_provider_type_check` CHECK constraint stops an unknown type being
  written at all;
- `providerAdapter()` refuses to construct one if a migration or a direct write
  ever gets past the constraint.

Either alone leaves a row that names an adapter nothing can build.

The registry distinguishes two refusals because they are different operator
problems. A string that is not a provider type is refused by the request schema
with `providerType` named. A type the contracts declare and _this release_ has
no adapter for — `sanaei`, until 3C — is refused as
`PROVIDER_TYPE_UNSUPPORTED`, at create time rather than at the first probe. A
panel that cannot be operated should not become a row.

### Capabilities are declared, never persisted

A capability describes what an adapter can do. It belongs to the code that does
it, so it is read from the descriptor at request time and stored nowhere.

Persisting discovered capabilities would create a cache that can be wrong in the
one direction that matters: a panel that has lost a capability still listed as
having it, driving an operation that then fails half-done. The brief asks that
stale capability state must not cause destructive behaviour; the cheapest way to
guarantee that is to have no stale state. If a later phase needs per-panel
_discovered_ capabilities — as opposed to per-adapter _declared_ ones — that is a
new column with a new freshness rule, and it should be argued for then.

### The panel record is columns, not a blob

`id`, `tenant_id`, `name`, `provider_type`, `base_url`, `status`, `archived_at`,
`created_at`, `updated_at`. No metadata JSON column. Every field a panel needs
today has a stable meaning, and a JSON column added "for later" is where the
next unmodelled concept goes to avoid review.

`status` is `ACTIVE | DISABLED | ARCHIVED` with a CHECK built from the contract
enum. `archived_at` and `status` are constrained to agree
(`(status = 'ARCHIVED') = (archived_at IS NOT NULL)`), so neither can lie.

The name is unique among a tenant's _live_ panels only. Archiving releases the
name, because a panel replaced by a rebuilt one should be able to keep its
label; a plain unique index would make archiving permanent in a way archiving is
not supposed to be.

### Delete is archive

There is no hard delete. Later phases attach services, orders and users to
panels, and a deleted panel is how history becomes "محصول حذف‌شده" — the
legacy system's collapse of every deleted product into one placeholder, which
made past reports unreadable.

Archiving hides the panel from lists, refuses edits, credential changes and
probes, and keeps the row addressable by id so a later phase can still explain a
service that was provisioned through it. Restoring is a status change and keeps
the credentials. This lifecycle does not need a breaking redesign when
dependents arrive: the row is already permanent.

### Credentials

Three purposes, not one: `panel.username`, `panel.password`, `panel.api_token`.

They share a table and a row, so the tenant and the entity are identical for all
three, and the purpose is the only thing separating their AEAD contexts. One
generic `panel.secret` would make a password ciphertext copied into the username
column of its own row decrypt cleanly. Three purposes make it fail.

The context is `(purpose, tenantId, panelId)` and it is rebuilt from the caller's
arguments on every read, never stored beside the ciphertext. A stored context
would be a claim about where a ciphertext belongs, written by whoever could
write the ciphertext.

The table has no plaintext column and no column that could hold one. Each
credential's three columns — ciphertext, key id, set-at — are constrained to be
all null or all present.

**A credential travels one way.** The repository's projection selects the three
set-at timestamps and never a ciphertext, so `PanelView` has nowhere to carry a
credential and a response builder cannot acquire one by accident. The only
function that produces a panel credential in plaintext is the credential store's
`read`, whose one caller is the probe.

What a surface receives is `configured` and `lastReplacedAt`. Not the value, and
deliberately not a masked stand-in either: `********` can be resubmitted as if
it were the real password, which turns a form redisplay into a credential
overwrite.

### Credential edits say one of three things

Per field: absent leaves it, null removes it, a value replaces it.

An operator editing a panel's name must not erase its password by not mentioning
it, and an operator who means to remove a credential must be able to say so. A
shape that could not tell those apart would have to pick one, and either choice
is data loss for the other case.

Replacing a credential is a different route from editing a name because it is a
different permission: `panels.credentials.rotate` is CRITICAL and `panels.edit`
is HIGH. One endpoint accepting both would have to hold the higher, and every
rename would need the right to rotate credentials.

The audit records which kinds changed and whether each was replaced or removed.
Never a value, never a before, never a ciphertext.

### The adapter contract is narrow, and its result type has no free-text field

An adapter answers one question in 3A: `probe(target, http)` returns a
`ProviderProbeOutcome`. Success carries an optional provider version; failure
carries a normalized kind and an optional HTTP status.

There is deliberately no `detail` string. That field is where a
`WWW-Authenticate` header, a redirect target containing a session id, or an
echoed request body ends up. Its absence is what makes "a health result cannot
leak a secret" a property of the type rather than a rule someone has to follow.

Adapters receive a `ProviderHttpClient` rather than constructing one. An adapter
cannot widen its own timeout, follow a redirect, or reach a host the policy
refuses, because it never holds a client that could.

Provider DTOs stay inside the adapter. Nothing shaped like a Marzban response
crosses into the application layer.

### Health: latest state only

One row per panel, replaced on each probe. Not an event table: an unbounded
health history is a retention problem bought before anyone has asked a question
that needs it, and the operational log already exists for transitions worth
narrating.

Stored: state, checked-at, latency, normalized failure kind, HTTP status,
provider version, and last-healthy-at.

`lastHealthyAt` is carried forward across failures. "Unreachable, last worked
four minutes ago" and "unreachable, last worked in March" are the same state and
completely different problems.

Two states are **projected, never stored**:

- `DISABLED` comes from the panel's status. The health of a panel nobody is
  probing is not a fact about the panel, and storing it would mean re-enabling
  one required a health write.
- `UNCHECKED` is the absence of a row. Inventing a row to record that nothing
  has happened makes a never-checked panel look checked — the legacy statistics
  mistake exactly.

Staleness is computed server-side against one constant, so two surfaces cannot
disagree about what "recent" means.

**A probe result changes health and nothing else.** It never disables, archives
or erases a panel, and never touches a credential. A transient outage that
disabled a panel would turn a five-minute network problem into a manual
recovery.

A probe runs against a `DISABLED` panel on explicit operator request, because an
operator disables a panel precisely when something is wrong with it and "re-
enable it to find out whether you should" is not a workflow. It never runs
against an `ARCHIVED` one.

The probe runs **outside** the transaction that records its result. A network
call inside a transaction holds a database connection for the length of somebody
else's timeout, which at pool exhaustion is an outage caused by a panel being
slow.

### SSRF: refuse what is never a panel, allow what is

Panel URLs are operator-controlled and cause server-side requests. Blocking all
private space is not available to us: a self-hosted panel on `10.0.0.0/8` or a
VPS's internal network is Nexa's ordinary case, not an attack.

So the policy refuses the destinations that are _never_ a legitimate panel and
allows the rest:

| Destination                                 | Verdict                                    | Why                                                                                    |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| schemes other than http/https               | refused                                    | nothing else is a panel                                                                |
| URL-embedded credentials                    | refused                                    | they leak through logs and redirects, and they are never needed                        |
| link-local `169.254.0.0/16`, `fe80::/10`    | refused                                    | every cloud metadata service; an SSRF here returns credentials for the hosting account |
| multicast, reserved, broadcast, unspecified | refused                                    | not a host                                                                             |
| loopback                                    | refused unless explicitly enabled          | in a container the API's loopback is the API                                           |
| private RFC1918 / ULA                       | **allowed**                                | the legitimate self-hosted case                                                        |
| this installation's own data network        | refused                                    | the API shares a bridge with PostgreSQL and Redis; see below                           |
| public addresses                            | allowed over https; plaintext http refused |                                                                                        |
| any redirect                                | refused, never followed                    |                                                                                        |

The one carve-out inside the permissive rule is **this installation's own
network**. "Private is allowed" also meant an operator with `panels.edit` could
aim a panel at the compose bridge the API shares with PostgreSQL and Redis. No
response body ever comes back, which does not settle it: `UNREACHABLE` versus
`TLS_FAILED` versus a timeout is a port scanner with three states, and the
services behind that bridge are unauthenticated by design because only Nexa is
supposed to be on it.

Two rules, because either alone has a gap:

- **`PANEL_HTTP_DENIED_SUBNETS`**, checked against the RESOLVED address, so a
  hostname pointing into the network is refused as surely as a literal. It
  defaults to `172.29.1.0/24` and the installer substitutes the real
  `NEXA_DATA_SUBNET` — the same value compose pins so `TRUSTED_PROXY_IPS` can be
  exact — because an operator who moves the network to avoid a collision must
  not silently lose the protection.
- **The hostnames in `DATABASE_URL` and `REDIS_URL`**, refused by name. This
  covers the arrangement the CIDR list cannot: a managed database on a public
  address is in no denied subnet at all.

Everything else about private space is unchanged: `10.20.30.40:2053` is a panel
and stays reachable; only the network Nexa itself is on is not. The refusal
names the rule and never the host, address, port or network — a message that
described what it refused would be the oracle the rule exists to close.

Three implementation points matter more than the table:

- **The socket is pinned to a pre-validated address.** The client resolves the
  host, checks the address, and hands that exact address to
  `node:http`'s `lookup`. A name that resolves to an allowed address at check
  time and a refused one at connect time cannot happen, because there is no
  second resolution. `fetch` cannot express this, which is why this code is on
  `node:http`/`node:https`.
- **Redirects are never followed.** A 30x from a panel is either a
  misconfiguration the operator should fix or somebody moving the request to a
  host the policy already refused. Following it would re-open every question the
  policy answers, one hop later.
- **The pin applies to NAMES, and it is tested against a real socket.**
  `net.connect` skips resolution entirely for an IP literal, so `lookup` is
  never called there — correct, because a literal is its own address and was
  already judged. It fires for the case that matters,
  `https://panel.example.com`.

  `tests/unit/safe-http-dns-pin.test.ts` proves it end to end. Two HTTPS
  servers listen on the same port on different loopback addresses and answer
  with different bodies: `127.0.0.2`, which the client's resolver returns and
  the policy approves, and `127.0.0.1`, which is what the system returns for
  `localhost` and therefore where a second resolution would land. Both present
  the same certificate, issued by a CA generated in the test and trusted only
  through `caCertificates`, so TLS succeeds against either and the body is the
  only difference. The test asserts the approved body. Deleting the pin, or
  re-resolving inside it, makes the request SUCCEED against the other server —
  so the test fails on the destination rather than on an error, which is the
  failure this defence exists to prevent.

  Fixing the test found a defect the pin had all along: Node calls `lookup`
  with `all: true` (happy-eyeballs, on by default since Node 20) and requires
  an array, while the callback answered with the three-argument form. Every
  request to a hostname failed with `ERR_INVALID_IP_ADDRESS` — which is to say
  every real panel, since panels are addressed by name, and the operator would
  have read it as an unreachable panel. Nothing caught it because an IP-literal
  URL never calls `lookup` and every other test used one.

  A second finding from the same test: the pin is only sound with connection
  pooling off. `https.globalAgent` keys sockets by host and port, not by the
  address they were opened to, so a pooled socket outlives the check that
  authorised it. The client now sets `agent: false`; a probe is one request
  every few minutes, so a fresh socket costs nothing worth having.

  One line inside the pin is still not covered: the re-check of
  `addressAllowed` before the callback answers. It cannot fire as the code
  stands — `pinned` is chosen from an already-filtered list — and a mutation
  deleting it leaves every test green. It is kept for one future edit (a change
  to how `pinned` is selected) and its comment says plainly that it is
  unreachable today, so nobody mistakes it for covered ground.

- **Normalisation is the WHATWG parser's.** `2130706433`, `0177.0.0.1`,
  `0x7f.0.0.1` and `127.1` all canonicalise to `127.0.0.1` before any check
  runs, and `::ffff:192.168.1.1` is unmapped to its IPv4 form by the one helper
  both the allow rule and the plaintext rule use.

**A private CA is supported, and verification is never disabled.**
`PANEL_HTTP_CA_FILE` adds an operator's own certificate authority to the ones
trusted for panel calls. Additional to the system trust store, never instead of
it: there is no `rejectUnauthorized: false` anywhere in this codebase, and the
alternative for an operator whose panel sits behind an internal CA would be
exactly that. Unset — the default, and what a normal installation runs — means
ordinary public verification.

**Plaintext to a hostname is refused, even a private one.** `isPublicAddress`
treats a name as public, so `http://panel.lan:2053` is refused while
`http://192.168.1.10:2053` is allowed. The rule is about what crosses the wire
in the common case and it cannot resolve the name before deciding. The cost is
real: an operator whose panel is plain http behind a private DNS name must use
its address or put TLS in front of it. The refusal names the reason, so it is at
least self-explanatory at the point it happens.

**The tradeoff, stated precisely.** Allowing private space means an operator who
can configure a panel can direct a request from the Nexa host into its own
private network — to any private address, on any port, over http or https. That
is inherent: the feature _is_ "make requests to the operator's own
infrastructure". What is bounded is the damage — no redirect, no metadata
service, no loopback, no response larger than the cap, no response body ever
returned to the caller, and a normalized failure kind rather than anything the
target said. What is _not_ solved is a malicious operator using Nexa as a
port-scanner against their own network, distinguishing hosts by failure kind and
latency. Closing that needs an egress proxy on a network that can reach panels
and nothing else, which is a deployment topology decision and not a code one. It
is recorded here rather than implied.

### One connection test per panel per cooldown, claimed in the database

A connection test is an operator-triggered outbound request that logs into
somebody else's panel, and repeating it is two separate problems. It multiplies
the network-probing surface the section above bounds — an address the policy
allows can be swept as fast as the button can be pressed — and a login retried
on a loop locks the provider account it authenticates with, which several panel
packages do after a handful of failures.

So a probe must first take a **claim** on the panel: one row in
`panel_probe_claims`, written by a single `INSERT … ON CONFLICT DO UPDATE …
WHERE … RETURNING` on the pool, outside any transaction.

Three properties follow from that shape, and none of them survives a different
one:

- **Two simultaneous requests cannot both probe.** PostgreSQL takes a row lock
  on the conflict path and re-evaluates the `WHERE` against the row as it stands
  after the wait, so exactly one of them sees a claimable row. A `SELECT` then
  an `UPDATE` — which is what any decision made in the process looks like —
  lets both read "free" and both proceed.
- **It holds across containers.** The claim is state two API processes share;
  an in-memory cooldown is per process, and the deployment runs more than one.
- **Nobody waits.** The refused request returns immediately with the panel's
  stored health and `probed: false`. There is no sleep inside an HTTP request,
  and no error either: a cooldown that threw would make "I clicked twice" look
  like a failure and teach an operator to retry through it.

The claim is keyed by the panel and carries the tenant, so one tenant's cooldown
is invisible to another; the tenant predicate is in the statement as well as in
the service that resolved the panel.

**A claim is only ever for one configuration.** It stores a digest of the same
identity the in-flight guard compares — address, status, and the three
credential set-at timestamps — and a claim taken under a different one never
blocks. Replacing a credential or an address is exactly when an operator needs
an answer now, and it must not be the previous answer: the throttled path
returns stored health, so without this it would return a result measured against
the configuration they just changed. Nothing about a credential's VALUE is
hashed or stored — the set-at timestamps move when a credential is replaced and
say nothing about what it is, and a digest of the credentials themselves would
put a verifier for a panel password in a table that is not the credential table.

The identity is a timestamp tuple, so two writes inside the same millisecond are
indistinguishable. That is the resolution the in-flight guard has always had and
the same window it accepts; closing it would mean a revision column on every
panel write path, which is a larger change than the case justifies.

`PANEL_PROBE_COOLDOWN_MS` defaults to ten seconds, is floored at one second by
the schema, and is raised to `PANEL_HTTP_TIMEOUT_MS` when that is larger — a
window shorter than a probe can run would let a second request start while the
first is still on the wire. There is no off switch.

### Every write path takes a scope and an actor

Every method takes a `ScopeContext` and an `ActorContext` and checks its
permission through the guard. Every query carries `eq(panels.tenantId,
scope.tenantId)`, including primary-key lookups: a lookup that omits the tenant
returns another tenant's row and leaves the caller to decide what to do with
something it should never have seen.

Another tenant's panel id answers exactly what a nonexistent one does. A
distinguishable "forbidden" turns any id into an oracle for whether it exists
somewhere on the installation, and panel ids appear in URLs.

The permission is checked **before** the idempotency store is consulted, not
only inside `runAuthorizedMutation`. A replay never reaches the transaction, and
a panel replay returns a live view rather than a stored snapshot, so without the
earlier check an admin whose permission was revoked could replay a key from when
they still had it.

## Consequences

- Adding a provider is: a contract enum entry, a descriptor, an adapter, a
  registry line. No migration, no panel-model change.
- `sanaei` is declared and unimplemented, so creating one is refused with a
  precise code until 3C. That is deliberate and visible rather than a panel that
  half-works.
- Capabilities cannot be filtered on in SQL. If a later phase needs "every panel
  that supports X", that is a new decision with a new freshness rule.
- Health carries no history. "When did this panel start failing" is not
  answerable from `panel_health` alone; the operational log is where that
  belongs when someone asks for it.
- The SSRF policy is deliberately permissive about private space. Nexa's own
  data network is carved out of that permission; the residue — an operator can
  still distinguish reachable from unreachable across the rest of a private
  network — is accepted until a deployment-level egress control exists.
- A panel cannot be tested twice inside the cooldown, including by two
  different operators. That is the point, and the cost is that the second one
  sees a result they did not cause, with its own `checked at`.
- An operator who runs the database somewhere the denied list does not name and
  under a hostname the connection string does not use is not covered. That is a
  deployment this repository does not produce, and the remedy is a CIDR in
  `PANEL_HTTP_DENIED_SUBNETS` rather than more code.
