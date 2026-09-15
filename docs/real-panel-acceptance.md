# Real-panel acceptance — MHSanaei/3x-ui v3.7.0

Every other test of the Sanaei adapter runs against `tests/support/fake-3xui.ts`,
a fake this repository wrote from the same reading of upstream that the adapter
was written from. `tests/unit/provider-wire-routes.test.ts` names that
circularity in its own header and says plainly that it cannot close it: a fake
and an adapter that agree with each other prove agreement, not correctness.

It has now cost three defects on one code path.

| Found by                                | Defect                                                    | Symptom on a real panel              |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| Reading upstream, after Phase 4D merged | `panel/api/inbounds/addClient` and the v2.x form envelope | 404 on every create                  |
| Reading upstream, same round            | `panel/api/inbounds/getClientTraffics/:email`             | 404 on every usage read              |
| **Running a real panel**                | the CSRF token was dropped after login                    | **403 on every session-mode create** |

The first two were caught by re-reading the Go source. The third could not be:
the sentence in the adapter asserting that `/panel/api/*` is exempt from the
CSRF check read exactly like a verified wire fact, and the fake had been written
to match it. Only a panel disagreed.

This document is how to run one.

## What the acceptance drives

`tests/acceptance/real-panel-sanaei.test.ts` drives the **shipped**
`SanaeiAdapter` over the **real** `SafeHttpClient` against an upstream panel
binary. Nothing is mocked, stubbed or hand-rolled: no request in the suite is
constructed by hand.

The one thing that is hand-written is the OBSERVER. `real-panel-harness.ts`
reads the panel back through its own operator API on plain `fetch`, sharing no
code with the adapter — because the thing under test may not also be the thing
that checks the answer. If the adapter wrote `totalGB` wrongly and read it back
through the same helper, the two mistakes would agree and the suite would be
green.

## Standing one up

Nothing here may point at an installation carrying real customers. The panel is
built for the run, given a disposable database, and thrown away.

```bash
# 1. The panel, at the pinned commit. Not a container image: ghcr.io blobs are
#    not reachable from every environment, and the source builds in ~3 minutes.
git clone --depth 1 --branch v3.7.0 https://github.com/MHSanaei/3x-ui
cd 3x-ui
git rev-parse HEAD     # must be f727d04f6522bb94a8fb52e8352fdcafb51c11e1

# 2. The frontend, because internal/web/web.go embeds `all:dist` and go:embed
#    refuses to compile without it. The API routes do not need the UI; the
#    compiler needs the directory.
(cd frontend && npm ci && npm run build)

# 3. The binary. GOTOOLCHAIN=auto fetches the go.mod toolchain if needed.
CGO_ENABLED=1 go build -o ./3xui-real .

# 4. xray-core, or the panel restarts it in a loop and no inbound ever listens.
mkdir -p "$ACC/bin"
curl -sfLRO https://github.com/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip
unzip -q Xray-linux-64.zip && mv xray "$ACC/bin/xray-linux-amd64"

# 5. A disposable panel. NOT on 127.0.0.1: the container's real URL policy
#    denies whatever DATABASE_URL and REDIS_URL name, and in a dev environment
#    that is 127.0.0.1. Binding elsewhere on loopback is not a way around the
#    policy — it is the production case, where a self-hosted panel in private
#    space is reachable while this installation's own data services are refused.
export XUI_DB_FOLDER="$ACC/db" XUI_BIN_FOLDER="$ACC/bin"
./3xui-real setting -port 54321 -listenIP 127.0.0.2 -webBasePath /acc/ \
  -username "$(cat "$ACC/.user")" -password "$(cat "$ACC/.pass")"
./3xui-real run
```

The `webBasePath` is deliberately not `/`. Every adapter path is relative for
exactly this reason — a leading slash would discard the configured path and land
on the origin root — and a panel served at the root cannot tell whether that
rule still holds. A8 asserts the base path is non-root before probing.

Then one inbound (`POST panel/api/inbounds/add`, VLESS over TCP), and:

```bash
export NEXA_ACCEPTANCE_PANEL_URL=http://127.0.0.2:54321/acc/
export NEXA_ACCEPTANCE_PANEL_USERNAME=... NEXA_ACCEPTANCE_PANEL_PASSWORD=...
export NEXA_ACCEPTANCE_PANEL_INBOUND_ID=1 NEXA_ACCEPTANCE_PANEL_INBOUND_PORT=20443
export NEXA_ACCEPTANCE_SUB_URL=http://127.0.0.2:2096/
pnpm test:acceptance
```

Without `NEXA_ACCEPTANCE_PANEL_URL` the suite **fails with an explanation**
rather than skipping. A skipped acceptance suite reports the same green as a
passing one, and the thing being acceptance-tested is the claim that this
adapter works against a real panel.

`pnpm verify` does not name the project and CI does not run it, because CI has
no panel.

## What it proves

Twenty-five cases, grouped as the eight things an operator needs true.

| Group | Proves                                                                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1    | A create reaches the panel and the panel holds the account. A create naming an inbound the panel does not have is a failure that leaves nothing behind.                                                                                            |
| A2    | A lookup finds that exact account; an unknown name is a POSITIVE absence (`ok: true, found: false`), which is what makes a fresh create legal; one account is never answered with another's figures.                                               |
| A3    | Usage is the panel's figure — zero used against the promised total on a new account, unlimited read back as unlimited rather than as zero remaining, and a missing account reported as a failure rather than as zero usage.                        |
| A4    | The subscription listener serves a config carrying **this client's own UUID** and the inbound's port; another customer's `subId` does not serve it; and the link is built from the activation's subscription domain, never from the panel address. |
| A5    | Volume, expiry and device limit are stored as sent — read back through the panel's OWN operator API, not through the adapter. No device limit is 3X-UI's `limitIp: 0`; no duration is `expiryTime: 0`, not an expiry in 1970.                      |
| A6    | A replay does not give the customer two accounts, a different identity cannot take a name already in use, and two concurrent creates leave exactly one account.                                                                                    |
| A7    | No credential reaches an outcome, an error or a thrown stack — on success, on a rejected login, and against an unreachable panel.                                                                                                                  |
| A8    | Two services never collide on one panel; a lookup addressed at a different panel is a FAILURE and never `found: false`; the panel's `webBasePath` is honoured.                                                                                     |

## What a real panel corrected

### The CSRF token is required on `/panel/api`, in session mode

`internal/web/controller/api.go`'s `initRouter` mounts, in order:
`checkAPIAuth`, `enforceTokenScope`, `ConfigEnvelopeMiddleware`, then
`middleware.CSRFMiddleware()` — on the whole `/panel/api` group.
`CSRFMiddleware` short-circuits on exactly one condition,
`c.GetBool("api_authed")`, which `checkAPIAuth` sets for a **Bearer** caller and
never for a session one. `isSafeMethod` then exempts GET, HEAD, OPTIONS and
TRACE.

So: reads worked, the panel probed healthy, and **every** create on a panel
configured with a username and password was `AbortWithStatus(403)` with no body.

The token survives the login. `login` reaches `session.SetLoginUser`, which does
`s.Set` and `s.Save` and never `s.Clear`, so the `CSRF_TOKEN` minted by
`csrf-token` is still what `ValidateCSRFToken` compares against.

### A repeated create is an idempotent no-op, not a refusal

The adapter's docblock said "v3.7.0 answers a duplicate email with a message".
It does not, for the case that matters. `ClientService.AddInboundClient` runs
`checkEmailsExistForClients`, which **exempts a matching `subId`**, then drops
anything already on the inbound and returns `(false, nil)` when that leaves
nothing — reported as success. Upstream made that the behaviour deliberately
(#5770, `TestAddInboundClient_SkipsClientsAlreadyOnInbound`) because retried and
raced adds were duplicating one email inside one settings array.

Nexa's three identities are derived per service, so a replay carries the same
email _and_ the same subId. The PROVISION operation simply succeeds; no
reconcile is needed, because nothing was ever unknown. A **different** identity
claiming a taken name is still refused with `Duplicate email: <email>`.

### The client UUID is `uuid`, and `id` is a row id

`panel/api/clients/get/{email}` answers
`{obj: {client: {...}, inboundIds, externalLinks, usedTraffic}}`, and inside
`client` the VLESS UUID is `uuid` while `id` is the database row id — an
integer. This bit the observer first, which reported an empty string for every
field because it was reading one level too high and then at the wrong key. It is
recorded because it is easy to repeat.

The adapter is unaffected: it sends the UUID as `id` in the create body, which
v3.7.0 binds into `model.Client.ID`, and A4 proves the served config
authenticates with the value Nexa sent.

### The route constants, confirmed by upstream's own spec

The frontend build emits `internal/web/dist/openapi.json`, generated from the Go
source by `tools/openapigen`. At the pinned commit it lists 183 paths, among
them exactly the four this adapter uses: `/login`,
`/panel/api/server/status`, `/panel/api/clients/add` and
`/panel/api/clients/traffic/{email}`. That is an upstream-generated artifact
rather than a transcription, and it is stronger evidence than the table in
`tests/unit/provider-wire-routes.test.ts`, which remains a hand transcription
and still says so.

## What this does NOT cover

- **One release.** v3.7.0 at `f727d04f6522bb94a8fb52e8352fdcafb51c11e1`, and
  nothing about any other.
- **Bearer mode against a real panel.** The acceptance runs username/password,
  which is the mode that was broken and the mode a fresh install uses. Bearer is
  covered against the fake only.
- **Marzban.** No real Marzban has been run. Its adapter's routes are verified
  by reading source at `7f396db3e703d71a28060bc9ce4a532ec64cb1f4`, which is
  where the Sanaei adapter was before this document existed.
- **SUSPEND, RESUME and TERMINATE.** Not implemented, and deliberately not in
  this file. They get their own acceptance pass, against disposable accounts,
  before they ship.
