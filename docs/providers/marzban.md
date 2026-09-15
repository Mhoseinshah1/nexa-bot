# Gozargah/Marzban — the wire contract this adapter is written against

Pinned at **v0.8.4**, tag `v0.8.4`, commit
`7f396db3e703d71a28060bc9ce4a532ec64cb1f4`. `GET /api/system` on a panel built
from that commit answers `"version": "0.8.4"`, which is how a reader checks the
binary in front of them is the one this table describes.

Everything below was **read out of the upstream source AND run against a panel
built from it**, in that order. Where the two disagreed, the panel won and the
disagreement is recorded — twice, so far, and both times the reading was the
confident one.

## The routes

| What              | Method and path               | Body                                                | Success                                      | Absent                                 |
| ----------------- | ----------------------------- | --------------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| Token             | `POST /api/admin/token`       | form: `username`, `password`, `grant_type=password` | `200 {access_token, token_type}`             | —                                      |
| Panel self-report | `GET /api/system`             | —                                                   | `200 {version, total_user, …}`               | —                                      |
| Create a user     | `POST /api/user`              | JSON, see below                                     | `200` `UserResponse`                         | `409 {"detail":"User already exists"}` |
| Read one user     | `GET /api/user/{username}`    | —                                                   | `200` `UserResponse`                         | `404 {"detail":"User not found"}`      |
| **Disable one**   | `PUT /api/user/{username}`    | `{"status":"disabled"}`                             | `200` `UserResponse`, `status` disabled      | `404`                                  |
| **Re-enable one** | `PUT /api/user/{username}`    | `{"status":"active"}`                               | `200` `UserResponse`, `status` active        | `404`                                  |
| **Delete one**    | `DELETE /api/user/{username}` | —                                                   | `200 {"detail":"User successfully deleted"}` | `404`                                  |

`app/routers/user.py` at the pinned commit is the source for all seven. There is
no dedicated disable route and no dedicated enable route: both are the ordinary
modify call carrying nothing but a status.

## What the panel does that the source alone would not tell you

**A user is keyed by its name, and the name is the only identity.** `UserResponse`
carries no id that outlives a rename, so `providerUserId` is null for this provider
and the stored username is the identity. Marzban refuses to change a username on a
modify — the field is documented "Cannot be changed. Used to identify the user."

**`status` on a modify takes only `active`, `disabled` or `on_hold`.** Anything else
is `422 {"detail":{"status":"Input should be 'active', 'disabled' or 'on_hold'"}}`;
`limited` and `expired` are states Marzban puts a user INTO, never ones it accepts.
That is `UserStatusModify`, a narrower enum than `UserStatus`.

**A repeated disable, and a repeated enable, are both `200`.** Neither is an error and
neither is a no-op-with-a-different-code, so a replayed `SUSPEND` or `RESUME` is
naturally idempotent. `crud.update_user` assigns the status unconditionally.

**A repeated delete is `404`, and that 404 means the work is done.** It is the same
status an absent user gives on a read, which is why `terminateUser` reports a 404 as
SUCCESS and `lookupUser` reports it as absence: after a delete, "not found" is the
outcome that was asked for.

**Disabling a user removes it from Xray, not just from the database.** The modify route
dispatches `xray.operations.remove_user` whenever the resulting status is not `active`
or `on_hold`, and the running panel does it: an account disabled through this route
stopped carrying traffic within seconds, while a sibling account on the same inbound
kept carrying it. `scripts/marzban-lifecycle-check.sh` is that measurement, committed
rather than described — it drives the whole lifecycle and prints what each account
served at each step, with a never-created UUID as the control.

**Nothing re-enables a disabled user behind your back.** `app/jobs/review_users.py`
iterates `status=active` only, so `disabled` is a state the panel will not leave on its
own. A suspended service stays suspended until Nexa resumes it.

**`expire` is epoch SECONDS and `0` means never.** Both `expire: 0` and
`data_limit: 0` are stored as SQL NULL and come back as `null`, so "unlimited" reads as
an absent value rather than a zero — which is why `usageFromUser` maps `0` and `null`
to the same "no limit" and never to "an allowance of nothing".

**`expire` and `data_limit` on a modify are ABSOLUTE, and an omitted key is no change.**
`crud.update_user` assigns `dbuser.expire = (modify.expire or None)` and
`dbuser.data_limit = (modify.data_limit or None)`; a key that is absent or `null` is
skipped entirely. So the same PUT sent twice leaves the same values, which is what makes
`RENEW`, `ADD_TRAFFIC` and `ADD_TIME` idempotent when they are expressed as a TARGET
rather than as an increment. `scripts/marzban-allowance-check.sh` is the measurement.

**Raising `data_limit` re-activates a `limited` user and KEEPS `used_traffic`.** The same
function sets the status to `active` when the new limit is above what has been consumed,
and to `limited` when it is not — and it never touches the counter. Clearing consumption
is a different route, `POST /api/user/{username}/reset`, which Nexa does not call
anywhere: replayed after a customer has used more, it would erase real usage.

**Nothing in a modify re-enables a `disabled` user.** Both status branches in
`crud.update_user` exclude `disabled` — the `data_limit` branch by
`status not in (expired, disabled)`, the `expire` branch by `status in (active, expired)`.
A suspended account given more time and more traffic is still suspended, measured.

**Extending `expire` alone does not revive a `limited` user**, because `limited` is in
neither of those two sets. A renewal that buys both a period and an allowance must send
both fields in one call, and then the `data_limit` branch — which runs first — is what
brings the account back.

**`subscription_url` is minted fresh on every response and is not stable.** The token
embeds `ceil(time.time())` at render time (`app/utils/jwt.py: create_subscription_token`),
so two reads of the same unchanged user return two different URLs. Older tokens keep
working — `get_validated_sub` only rejects a token minted before the user was created
or before `sub_revoked_at` — so a URL Nexa delivered once stays valid, and nothing may
treat a changed URL as evidence that anything changed.

## The one that a green suite got wrong

**`inbounds` is NOT optional, and omitting it does not mean "all of them".**

`UserCreate.excluded_inbounds` is computed as _every_ inbound for each requested
protocol that is **not** listed in `inbounds`. Omit the key and the set of listed
inbounds is empty, so every inbound is excluded, and `crud.create_user` writes that
exclusion onto the proxy row.

The panel still accepts the create with `200`, still returns a `subscription_url`, and
the account is still added to Xray — so a create looks entirely successful. What the
customer gets is an **empty subscription**: `links` is `[]` and fetching the
subscription URL returns a zero-byte body.

Measured on the pinned binary, two users differing only in that key:

| create payload                      | `links` | subscription body             |
| ----------------------------------- | ------- | ----------------------------- |
| `inbounds: {"vless":["VLESS TCP"]}` | 1 link  | 228 chars, one `vless://` URI |
| `inbounds` omitted                  | `[]`    | **0 chars**                   |

The adapter's own docblock had asserted the opposite — "Absent means every inbound for
those protocols, which is Marzban's own documented default and not a guess of ours" —
and the unit suite was green, because the fake had been written from the same sentence.
`marzbanActivationSchema.inboundTags` is required as of the commit that found this, and
a panel that does not name its inbound tags is `PANEL_NOT_OPERABLE` rather than a source
of accounts that connect to nothing.

## Authentication

One bearer token per call sequence, from the token route, never stored. `401` on a
bad or absent token; `403 {"detail":"You're not allowed"}` when a non-sudo admin
reaches for a user it does not own — the ownership check is `get_validated_user`, and
it is the panel's own guarantee that a credential cannot reach another admin's
accounts.

## What guards this table

`tests/unit/marzban-adapter.test.ts` runs the adapter against
`tests/support/fake-marzban.ts`, and that is agreement between two things this
repository wrote — it proves the adapter has not drifted, nothing more.

`tests/acceptance/real-panel-marzban.test.ts` runs the shipped adapter over the real
`SafeHttpClient` against a panel binary built from the pinned commit. It is what found
the `inbounds` defect above. `docs/real-panel-acceptance.md` is how to stand one up.
