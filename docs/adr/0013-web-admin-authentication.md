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

A CLI or API credential, if one is ever wanted, is a separate surface with its
own issuance, scope, lifetime and revocation. It is not this cookie wearing a
different header name.

Every state-changing request checks `Origin`, with no exceptions now that the
cookie is the only transport. SameSite is enforced by the client; a client that
does not enforce it leaves the cookie exposed, and the server-side check does
not depend on the browser behaving. An absent `Origin` fails closed.

## Client IP behind the reverse proxy

The client IP feeds brute-force throttling and audit rows, and production sits
behind Caddy — so the socket address is the proxy's and the real client is in
`X-Forwarded-For`, a header anyone can set.

`TRUSTED_PROXY_IPS` takes a **list** of upstreams. There is deliberately no
boolean: `trustProxy: true` believes the header from whoever connected, so a
client reaching the port directly picks its own IP, rotates it to evade
throttling, and writes an address of its choosing into the audit log.

The opposite misconfiguration — behind a proxy with nothing trusted — cannot be
prevented by configuration, so it is detected at the point of use. Every request
then appears to come from Caddy, and per-IP throttling would lock out every
administrator on one attacker's failures. When the resolved client IP is itself
a configured upstream, per-IP throttling is **skipped** for that attempt and the
per-username throttle carries the load alone. The username throttle is the one
that protects an account; the IP throttle limits breadth.

## Password rotation is atomic

A successful password change revokes **every** session for that administrator,
including the one making the request, and the rotation and the revocation commit
in one transaction with the audit row and the outbox event.

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

## Throttling

Five failures per username and twenty per IP in a fifteen-minute window, then a
fifteen-minute lockout. Held in the database rather than in Redis, for two
reasons: an attacker must not be able to clear their own counter by waiting out
a cache eviction or a restart, and the window advances by the injected `Clock`
so the tests are deterministic without sleeping.

Keyed on the **submitted** username rather than a resolved admin id. Throttling
only real accounts would turn the lockout into the username oracle the error
text refuses to be. A lockout also refuses the _correct_ password — a lockout
that let it through would only ever throttle an attacker's last guess.

## Costs accepted

A username and password is one more secret for an operator to manage, and there
is no self-service reset in v1 — recovery is another owner, or the bootstrap CLI
against a database with no administrators. Second-factor authentication is not
built. Both are deliberate omissions for a single-operator self-hosted install,
and both are additive later.
