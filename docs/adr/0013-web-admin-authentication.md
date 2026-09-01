# ADR-0013 — Web Admin authentication: username and password

**Status:** Accepted for Phase 1. Supersedes the open question in ADR-0009.

## Decision

The Web Admin authenticates with a **username and a password**, against the
`admins` table, scoped to the installation's tenant.

The Telegram Login Widget is **not** the Web Admin credential in v1.

## Why not the Login Widget

It looked attractive because every administrator already has Telegram. Three
things decided against it.

It makes Telegram an availability dependency of administering the system — and
the most likely reason to need the admin panel urgently is that something is
wrong with the bot. It makes account recovery Telegram's problem: an
administrator who loses their Telegram account loses the installation, and there
is nothing an operator can do about it locally. And it binds an administrator's
identity to an external id we do not control, which is precisely the shape that
produced `C-ADM-004` in the legacy system, where one surface identifies an admin
by numeric id and the other by username.

`admins.telegram_user_id` exists so a Telegram admin surface can attach to the
same identity later. That is a link, not a credential.

## Password storage

**scrypt**, from Node's own `crypto`, at the OWASP minimum: N = 2¹⁷, r = 8,
p = 1.

Argon2id is the first recommendation and we are not using it, deliberately.
Every Node binding for it is either a native build — which makes a CI runner's
toolchain a dependency of being able to log in, and makes a restore on a fresh
box a gamble — or a prebuilt binary from a single maintainer. scrypt is
memory-hard, is in the standard library, and OWASP accepts it at these
parameters.

The stored value is self-describing: `scrypt$N$r$p$salt$digest`. Moving to
Argon2id later is a branch in `verify` plus `needsRehash` returning true, so
passwords migrate as people log in. No migration, no forced reset.

A hash stored below the current profile is re-stored at full strength on the
next successful login — the only moment the plaintext exists is the only moment
that is possible. The new hash is computed outside the transaction, because it
is deliberately slow, and **written inside it, under the row lock, after the old
hash has been confirmed still current**. Writing it as a separate
compare-and-set before the session transaction is what broke every below-cost
account: the rehash replaced the stored value, and the session's own predicate
then demanded the hash it had just overwritten, so a correct password was
refused. A cost increase must never lock out the accounts it is meant to
protect.

Cost is selected by `PASSWORD_HASH_PROFILE`, which the config schema **refuses**
in production. Inferring it from `NODE_ENV` would mean a self-hosted install left
on `development` stored every password at a thousandth of the intended cost
without ever saying so.

## Sessions

An opaque 32-byte random token, stored only as its SHA-256.

A plain hash is right here, where it is wrong for a password: the input is
already 256 bits of uniform randomness, so there is nothing to brute-force, and
a slow KDF would add latency to every authenticated request. The property that
matters is that a database read cannot be replayed as a login.

Carried as an httpOnly `SameSite=Strict` cookie, and **only** as that cookie.
The login response body contains no session credential at all.

An earlier version also returned the token in the body, and accepted
`Authorization: Bearer`, so a non-browser client had a way in. That handed the
same bearer credential to every script running on the admin page and undid most
of what `HttpOnly` buys — one XSS, one `fetch('/auth/login')` away from a token
that outlives the page. Removing it from the body also made bearer an
authentication path no legitimate client could obtain a credential for, so that
was removed too: an unreachable way in is not a feature.

The contracts say so too, now. A `SESSION_TRANSPORTS` constant listing `COOKIE`
and `BEARER` survived that removal, referenced by nothing and advertising as
supported the very path this decision forbids. A frozen contract is read as
permission by whoever comes next, so an unused abstraction naming a forbidden
credential path is a trap rather than a spare part. It is gone.

A CLI or API credential, if one is ever wanted, is a separate surface with its
own issuance, scope, lifetime and revocation. It is not this cookie wearing a
different header name.

Every state-changing request checks `Origin`, with no exceptions now that the
cookie is the only transport. SameSite is enforced by the client; a client that
does not enforce it leaves the cookie exposed, and the server-side check does
not depend on the browser behaving. An absent `Origin` fails closed.

### The cookie name carries a guarantee

In production the session is issued as **`__Host-nexa_admin_session`**. A browser
refuses to store a cookie under that prefix unless it is `Secure`, has `Path=/`,
and names no `Domain` — and the last condition is the one that matters.

Without it, a sibling host under a shared parent domain (`evil.example.com`
beside `admin.example.com`) can set a cookie of the session's name for
`Domain=example.com` with a longer `Path`. Browsers send longer-path cookies
first, and every conventional parser — ours included — takes the first
occurrence of a name. The attacker's value is then the one read: enough to keep
a victim permanently logged out, and enough for anyone holding any
administrator credential to toss their own session into a victim's browser and
recreate the account confusion the login `Origin` check was added to prevent.
The prefix removes the possibility rather than arguing about the ordering: such
a cookie can no longer be set at all.

The prefix requires `Secure`, which a plain-HTTP development server cannot
offer and for which a browser silently refuses the cookie — presenting as
"login succeeds and nothing is signed in". So the unprefixed spelling is issued
outside production, and **in production it is not accepted at all**.

Preferring the prefixed name was the first attempt and was not enough. Ordering
only decides between two cookies a request actually carries; a _logged-out_
victim carries neither, so the sibling's plain-named cookie would simply be
believed — and nothing could clean it up afterwards, because a host-only
`Set-Cookie` cannot delete another domain's cookie. The plain name therefore
survives only where the prefix is unusable, which is a deployment without TLS.

Which is also why **every production admin origin must be a canonical `https`
origin**, checked at boot: parsed as a URL, with `url.origin` required to equal
the configured string. A trailing slash is enough to break it — a browser sends
`Origin: https://admin.example.test` and the check compares exactly, so
`https://admin.example.test/` would validate, boot, and then reject every login
and every write on a deployment whose configuration looked correct. Parsing also
disposes of paths, queries and embedded credentials. An `http://` origin would otherwise start, pass the Origin check, log
in successfully, and leave the administrator unauthenticated with nothing to
point at, because the browser refused to store a `Secure` cookie from an
insecure page. HSTS cannot rescue that first response — a browser ignores HSTS
received over HTTP.

## Client IP behind the reverse proxy

The client IP feeds brute-force throttling and audit rows, and production sits
behind Caddy — so the socket address is the proxy's and the real client is in
`X-Forwarded-For`, a header anyone can set.

`TRUSTED_PROXY_IPS` takes a **list** of upstreams. There is deliberately no
boolean: `trustProxy: true` believes the header from whoever connected, so a
client reaching the port directly picks its own IP, rotates it to evade
throttling, and writes an address of its choosing into the audit log. A `/0`
prefix is refused for the same reason — it is the same thing spelled
differently — and every entry is validated at boot, so a typo fails the boot
instead of silently voiding or widening the trusted set.

The opposite misconfiguration is **`DEPLOYMENT_TOPOLOGY`**, which the
installation must state:

- `reverse-proxy` — the standard deployment. Requires a non-empty list.
- `direct` — nothing in front of the process. Requires an _empty_ list, so
  `X-Forwarded-For` is ignored and the client IP is the unforgeable socket
  address.

An earlier version claimed running behind a proxy with nothing trusted was
"detected automatically". **That was wrong.** With an empty list `request.ip` is
simply the proxy's socket address, and nothing at runtime distinguishes it from
a real client connecting from that address — so the whole installation would
share one throttle subject and one failed-login burst would lock everyone out.
An empty list is correct for one topology and dangerous in the other, so the
topology is declared and the combination is validated.

`ipThrottleSubject`'s trusted-address check survives as a second line, for a
request that arrives without a forwarded header under a correct configuration.
It is a safety valve, not a detector. When it fires, per-IP throttling is
skipped for that attempt and the per-username throttle carries the load alone —
the username throttle protects an account, the IP throttle limits breadth.

## Password rotation is atomic, and compare-and-set

A successful password change revokes **every** session for that administrator,
including the one making the request, and the rotation and the revocation commit
in one transaction with the audit row and the outbox event.

Verification and hashing happen **outside** that transaction, and must: scrypt
is deliberately slow, and holding a transaction open across it would turn one
password change into contention for every other writer in the tenant. That
leaves a time-of-check-to-time-of-use window measured in hundreds of
milliseconds, in which a second rotation can commit. Both requests validated
against the same old password; the slower one would then overwrite the newer
credential — from a session the first rotation had already revoked.

The fix is not a longer lock. The verified hash travels into the UPDATE's own
predicate:

```sql
UPDATE admins SET password_hash = :new
 WHERE tenant_id = :tenant AND id = :admin AND password_hash = :verified
   AND status = 'ACTIVE'
```

Status is part of that predicate, not the hash alone. A disable committing
inside the hashing window revokes the actor's sessions and ends their access;
without the status check the now-disabled administrator would still commit a
credential of their choosing, sitting ready for any later re-enable. A disable
that commits first now makes the rotation lose, exactly as a concurrent
password change does.

Check and write become one atomic statement. A request whose view of the
credential is stale updates no rows, and everything else is abandoned: no
revocation, no success audit row, no event. It is told to sign in again, which
it must do anyway — the winner revoked its session.

They used to be two steps. If the second failed — dropped connection, restart,
deadlock — the result was the worst outcome available: the credential the
administrator believed they had replaced was gone, and every session opened with
the old one was still live. A partial success that looks like a success is worse
than a clean failure.

All sessions rather than "all but this one", because an administrator rotating a
password they think is exposed cannot know which live session is the attacker's.
The surface clears the cookie afterwards — that is not the revocation, which
already committed; it stops the browser presenting a credential the server will
now refuse.

**A revoked session performs no writes.** The re-read takes `FOR UPDATE` on the
session row, not a plain select: reading it closes the window before the check
and leaves the one after it, where a logout starting once the read returned
commits on its own connection while the mutation is still working. The lock
makes that logout wait for the transaction instead. Validity is established once, when
the request arrives, and then the request does work — so a logout or a rotation
committing in that window would otherwise still let it commit. Every
administrator mutation and the password rotation re-read the session on the
LOCKED connection, beside the actor's permissions, which is what makes "a
rotation revokes every session" true of the requests already in flight and not
only of the rows. System work carries no session and is fenced by the boundary
check instead.

The generic refusal a paused tenant returns **gives its throttle reservations
back**. That attempt presented the right password; the refusal is about the
installation, not about them, and at a limit of one a single correct attempt
during a maintenance window would otherwise leave the operator rate limited the
moment it ended. A wrong password, or a disabled administrator, keeps its
reservation — those are failures against a real credential.

**Sessions carry identity, never authority.** Permissions are resolved from the
database on every request. This answers the third question ADR-0009 left open:
a role change takes effect on the next request, and disabling an administrator
revokes their live sessions immediately rather than at expiry.

## Failure reporting

A failed login reports exactly one thing, whatever went wrong: unknown username,
wrong password, and disabled account produce the same code, the same status and
the same message. An unknown username still spends a full hash, so the timings do
not separate either.

The audit row records which it actually was. Both properties matter and they are
not in tension — one is what the caller learns, the other is what the operator
can review.

## The session is bound to the credential that authorised it

Login verifies outside any transaction — scrypt is slow by design — so a
rotation can commit in the gap. Rotation revokes every session that EXISTS at
that moment, and a session inserted afterwards from the old password was not one
of them. It survived, and rotation had failed at the one thing it is for.

Session creation therefore happens in a transaction that first takes
`SELECT … FOR UPDATE` on the admin row with the verified hash as a predicate.
That serialises against the rotation's own compare-and-set: either the session
is created first and the rotation then revokes it, or the credential is already
gone and no session is created. The caller is told the password is incorrect,
which is precisely true.

The predicate carries the account's **status** as well as its hash, for the same
reason and against the same shape: the status was read outside any transaction,
and a disable committing in that gap revokes every session that exists at that
moment — one inserted afterwards would not be among them. Such a session could
never be used, since `authenticate` refuses a non-ACTIVE administrator on every
request, but a login should no more outlive the account's access than it
outlives its credential.

## Throttling

Five attempts per username and twenty per IP in a fifteen-minute window, then a
fifteen-minute lockout.

The attempt is **reserved before the password is verified**, not recorded after
it fails. Counting only failures left the check a pure read, so a concurrent
burst arriving while the counters were empty all passed it and every request
queued a production-cost, memory-heavy derivation — an unauthenticated caller
could saturate the crypto pool long after the limit had been crossed. Reserving
makes the request that crosses the line see its own increment and be refused
before it hashes.

A successful login **clears the username counter and gives back only its own IP
reservation** — including any lockout that reservation itself established. The
attempt that reaches the limit is still verified and may succeed; returning its
count while leaving the lock standing would refuse every administrator behind
that address for the full lockout period on the strength of a login that
worked, and at `LOGIN_MAX_ATTEMPTS_PER_IP=1` the first successful login would
poison the address outright. The lock lifts only when the decremented count
falls back below the limit, so failures accumulated by others still hold it. Clearing the IP outright let anyone holding one valid account
spray guesses across administrator names and reset the breadth limiter by
periodically signing into their own. Held in the database rather than in Redis, for two
reasons: an attacker must not be able to clear their own counter by waiting out
a cache eviction or a restart, and the window advances by the injected `Clock`
so the tests are deterministic without sleeping.

Every release names the **counting period its reservation belongs to**, and
matches nothing if that period has passed. A login can sit in the KDF longer
than the whole window — 30 seconds is the configured minimum and a saturated
crypto pool can exceed it — and by then a later attempt may have started a new
period. An unconditional decrement would take away that later attempt instead,
and could clear the lock it had just established.

A request refused for being **past** the limit gives both reservations back
before it throws. It never reaches the KDF and never checks a credential, so
counting it overstates what happened — and the overstatement sticks: an allowed
request that reserved the limiting count and then succeeded returns only its
own, leaving the leaked one holding the subject at the limit and the lock alive.
At `LOGIN_MAX_ATTEMPTS_PER_IP=1`, two simultaneous correct logins would refuse
one, admit the other, and still lock the address they share. A failure that was
actually verified keeps its reservation, which is the failure being counted.

A lockout that has **expired** ends the counting period with it. Without that,
a lockout shorter than the window never actually ended: the first attempt after
it expired still incremented the over-limit count, wrote a fresh lock, and was
refused before the password was checked — and every retry renewed it, so a
30-second lockout inside a 24-hour window was a 24-hour lockout. An _unexpired_
lock is still never cleared by a window reset, for the reason above.

Keyed on the **submitted** username rather than a resolved admin id. Throttling
only real accounts would turn the lockout into the username oracle the error
text refuses to be. A lockout also refuses the _correct_ password — a lockout
that let it through would only ever throttle an attacker's last guess.

`maxAttempts` is **how many attempts are allowed**, so the attempt that reaches
the limit is still verified and the one after it is refused. Rejecting the Nth
would give N−1 credential checks, and at a limit of 1 the very first login —
correct password and all — would be refused, leaving the installation no way in.
The lockout is recorded as an operational event from the moment it exists, which
is one attempt earlier than the moment anything is refused: the failure path is
not reached by a refused attempt, and the refusal path is not reached by the
attempt that merely reaches the limit, so neither alone would ever write it
down.

## Timing, once a cost profile has been raised

An unknown username spends a dummy derivation at the current profile. A stored
hash below that profile verifies _faster_, so after a cost increase the
difference says which usernames exist — until each happens to log in and be
rehashed.

The cheap verification is therefore topped up with the dummy derivation, run
**concurrently with it rather than after it**: total elapsed becomes
max(legacy, current), which is what an unknown username costs. Running it
afterwards made the total nearly twice the unknown-username path — the same
oracle, pointing the other way.

The cost accepted is peak memory: two derivations are briefly in flight, so that
login allocates the current profile plus the older, cheaper one rather than one
of them. It applies only to accounts not yet rehashed, and the number of logins
in flight is what the throttle bounds.

## A stopped tenant is closed

`STOPPED` and `DISABLED` on the tenant now refuse both a new login and an
already-open session. They used to change nothing at all: the installation's
tenant id was cached at boot, the permission resolver never read the tenant row,
and `TENANT_INACTIVE` was declared in the contracts as a login failure reason
that no code could emit. A status nothing enforces is a label, not a kill
switch.

Every **administrator mutation** — create, status, roles, password rotation —
re-reads the tenant's status under the lock it already takes, from the same
statement that takes it. Authentication establishes a status when the request
arrives, which is a snapshot; a stop committing in between would otherwise be
observed by the lock and ignored by the work the lock protects. The relay does
the same at dispatch rather than only at claim, taking `FOR SHARE` on the owning
tenant — the claim's `FOR UPDATE` locks the message, not its tenant, so a stop
could otherwise commit between deciding to deliver and delivering.

**Login is deliberately not on that list**, and the boundary is worth stating
rather than leaving to be discovered. It checks tenant status outside any lock
and then writes its session under a lock on the ADMIN row, so a stop committing
in between still issues one. That session is inert: `authenticate` re-reads
tenant status on every subsequent request and refuses it, so the row grants
nothing and expires unused. Taking the tenant lock on the login path instead
would serialise every sign-in against every administrator mutation — a real cost
on the hottest path, to prevent writing a row that can never be used.

It closes the Telegram surface and the outbox too. A bot's own status was the
whole check on the webhook, and the relay claimed any unpublished row — so a
stopped installation went on accepting Telegram updates and, worse, went on
_dispatching_ work to the outside world. Tenant-scoped messages for a tenant
that is not ACTIVE are now left **unclaimed**: not dropped, not marked
published, still in order when the tenant is started again. Platform work with
no tenant is always eligible.

Two further consequences of taking the switch seriously: `DEPLOYMENT_TOPOLOGY`
may not be `direct` in production, because this process serves plain HTTP and
the `Secure __Host-` cookie a production login issues would be discarded by
every browser — validating that the _origin_ is https does not put TLS on the
transport. A bot's own `STOPPED`/`DISABLED` status was
the whole check there, and an update acts as `SYSTEM_JOB`, which never consults
the permission resolver — so a stopped installation went on accepting Telegram
work while its Web Admin was shut. An installation switched off must be switched
off everywhere, not only where a human signs in.

The login check sits **after** the password, beside the administrator-status
check and for the same reason: an installation that has been stopped must not
answer differently before the password is known. Existing sessions are refused
but **not revoked** — a tenant can be started again, and the sessions its
operators held are not what was suspended.

## Costs accepted

A username and password is one more secret for an operator to manage, and there
is no self-service reset in v1 — recovery is another owner, or the bootstrap CLI
against a database with no administrators. Second-factor authentication is not
built. Both are deliberate omissions for a single-operator self-hosted install,
and both are additive later.
