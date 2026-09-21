# RickPanel

A Marzban-derived panel, and a **separate provider type** in Nexa. If your panel
is a RickPanel, register it as `rickpanel` — not as `marzban`, however much the
two look alike.

`docs/rickpanel-adapter-audit.md` is the full comparison. This page is the part
an operator needs.

---

## Read this first if you already have a RickPanel registered as "Marzban"

You are not alone: the legacy system did the same thing — its own test panel was
labelled `TEST_MARZBAN_RICKPANEL` — and so did this deployment, which is how
order `01a0c54b` came to take a customer's money and refund it seven minutes
later.

**Nothing has been changed for you, deliberately.** Every panel you have stays
exactly the provider type you gave it. Nexa cannot tell from a stored row whether
the host behind it is a Marzban or a RickPanel, and guessing would silently
change which API your next customer's account is created through.

A panel's provider type cannot be edited after it is created — that is by design,
because the type decides how every future operation is performed. So the move is:

1. **Add a new panel** of type RickPanel, pointing at the same address, with the
   same admin credentials.
2. **Test Connection** on it. Until a connection test has succeeded against the
   panel's current configuration, it is not sellable and the panel page says so.
3. **Point your products at the new panel.**
4. **Disable the old one** once nothing sells through it. Do not delete it:
   services already created through it are still yours to manage, and they are
   still managed through the adapter that created them.

Existing services keep working throughout. Nothing about this is automatic and
nothing about it is urgent — but while a RickPanel is registered as a Marzban, it
will keep asking you for two configuration fields it does not have, and it cannot
be sold onto until you supply them.

---

## What you configure

An address, an admin username and an admin password. **That is all.**

There is no protocol to choose and no inbound to name, and that is not an
omission. RickPanel's own API documentation says of user creation:

> `inbounds` and a partial `proxies` set are accepted but ignored: every user
> gets every protocol and every inbound.

So there is nothing to configure, and Nexa does not pretend otherwise. A
RickPanel with working credentials and a successful connection test is sellable
immediately.

This is the opposite of Marzban, where naming your inbounds is mandatory and
omitting them produces an account that answers 200 and serves zero bytes. Two
panels, two rules, two provider types — which is why the two must not be merged.

### The panel page's three answers

- **Connection** — can we reach and authenticate against this panel.
- **Configuration** — is everything this provider needs present. For RickPanel,
  always yes.
- **Sellable** — may a new order be taken for it. This is the one that decides
  whether the catalogue offers it, and a green connection alone is never enough.

---

## What Nexa does on your panel

| Nexa operation               | What it sends                                                 |
| ---------------------------- | ------------------------------------------------------------- |
| Health check                 | `POST /api/admin/token`, then `GET /api/system`               |
| Create a service             | `POST /api/user`, then `GET /api/user/{username}` to confirm  |
| Read usage                   | `GET /api/user/{username}`                                    |
| Suspend / resume             | `PUT /api/user/{username}` carrying a status and nothing else |
| Renew, add traffic, add time | `PUT /api/user/{username}` carrying the new figures           |
| Terminate                    | `DELETE /api/user/{username}`                                 |

### Why a create is two calls

RickPanel's own documentation says "The response returns before the nodes have
the user." A successful create is therefore an acknowledgement, not a delivery,
and Nexa reads the account back before it sends a customer anything. If the
account is not readable yet, the order does not fail: the service is marked
unreconciled and a later read adopts it. **Nexa never creates a second account to
resolve the first.**

### Refusals that are yours to fix, not ours to retry

RickPanel answers `400` when one of your own rules is hit — your user limit is
reached, your service will not accept a subscription this short, or it refuses a
data limit or an on-hold user. A `403` on a delete means your service only allows
deleting expired users.

Nexa treats all of these as **decisions, not faults**: the operation fails once,
the customer is refunded in full and automatically, and the order page shows the
reason. It does not retry them, because the same rule would be applied the same
way every time — which is exactly what cost a customer seven minutes and this
release a hotfix.

A `429` is different and is retried, and a `5xx` is different again: that one may
have created the account, so it reconciles rather than refunding.

---

## What has NOT been verified

**No RickPanel has been contacted by this code.** The adapter was written from the
OpenAPI document the owner supplied, and verified against a fake this repository
wrote. `docs/real-panel-acceptance.md` is blunt about what that is worth: a fake
we wrote and an adapter we wrote can only prove they agree with each other, and
four defects reached `main` that way.

Before deploying this against customers, run:

```bash
NEXA_ACCEPTANCE_RICKPANEL_URL=https://panel.example \
NEXA_ACCEPTANCE_RICKPANEL_USERNAME=admin \
NEXA_ACCEPTANCE_RICKPANEL_PASSWORD=... \
pnpm test:acceptance
```

against a **disposable** panel, never one carrying real customers. It fails rather
than skips without one, on purpose.

Four things that run would settle, each recorded as an open question in the audit
rather than guessed at here:

- which field of the user record carries the subscription (`OQ-RP-01`);
- whether the create accepts a status (`OQ-RP-02`);
- what the create actually returns (`OQ-RP-03`);
- how long node propagation takes (`OQ-RP-04`).

Until then, the capabilities RickPanel advertises rest on a document and a fake.
A Marzban acceptance result says nothing about any of this and must never be
reported as though it did.
