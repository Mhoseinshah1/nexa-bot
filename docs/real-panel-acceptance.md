# Real-panel acceptance

Two panels, two suites, one rule: **an adapter this repository wrote and a fake
this repository wrote can only prove they agree with each other.** Both halves
of this document exist because that agreement was green while the code was
wrong.

- [MHSanaei/3x-ui v3.7.0](#real-panel-acceptance--mhsanaei3x-ui-v370) — below
- [Gozargah/Marzban v0.8.4](#real-panel-acceptance--gozargahmarzban-v084) — the
  second half

---

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

# and, for the tunnel check below
export NEXA_ACCEPTANCE_XRAY_BIN="$ACC/bin/xray-linux-amd64"
scripts/real-panel-tunnel-check.sh <sub-id> [expected-uuid]
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

## Does the link actually carry traffic?

A4 proves the served config names the right UUID and the right port. That is not
the question the customer is asking. A config can name both and still not
connect — a `flow` the inbound refuses, a `limitIp` it does not support, an
inbound the panel accepted and Xray will not serve. Each produces a service that
looks provisioned and does not work, which is the shape of most of the legacy
failures in `docs/research/`.

`scripts/real-panel-tunnel-check.sh` connects. Given a `subId` Nexa provisioned,
it fetches the subscription the customer would fetch, builds an xray-core client
from the `vless://` URI in it **and nothing else**, stands up an origin that
exists only for that run carrying a random payload, and moves bytes through.

Measured against an account created by the shipped adapter
(`acc-863ca278-27`, `accsub863ca27827`):

```
ok    the origin answers directly
ok    the subscription serves a vless link
ok    the link carries the UUID Nexa provisioned
ok    the tunnel carried the payload for this run, end to end
```

Separately and by hand, six megabytes were pulled through the same tunnel in
three requests, to rule out a result that only holds for a few hundred bytes.

### Why a script and not an acceptance case

It was written as `tests/acceptance/real-panel-usable.test.ts` first, and that
file did not work. An xray client **spawned from inside the vitest worker**
failed every request with `proxy/http: failed to read response ... unexpected
EOF`, while the same generated config file, run from a shell, moved bytes fine.
It was bisected far enough to rule out:

- the account — a UUID known to work from a shell failed the same way;
- the origin — a separate-process origin on a fixed port failed the same way,
  and the in-process origin answered a direct control fetch during the same run;
- the upstream address, the inbound port, and the panel's deferred xray reload
  (asking for `restartXrayService` explicitly changed nothing);
- a stale listener holding the client's proxy port.

The cause is not known. Shipping that file would have been shipping a red suite;
claiming it passed would have been worse. So the proof lives in a script that
runs, and this section says exactly why.

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

- **Usage counters after real traffic.** Nexa reads what the panel reports, and
  A3 proves it reads it faithfully. Whether the panel's figure MOVES after real
  traffic is not established here: six megabytes went through the tunnel and
  `up`/`down` stayed at 0 for the client **and for the inbound**, across more
  than a minute and a job whose cadence is `@every 5s`. `stats` and
  `policy.levels.0.statsUser*` are enabled in the panel's generated config and
  its gRPC API port is open, so this is a property of the disposable panel that
  was not run down. It is recorded rather than glossed because "usage reads
  correctly" and "usage counts correctly" are different claims and only the
  first is made.
- **One release.** v3.7.0 at `f727d04f6522bb94a8fb52e8352fdcafb51c11e1`, and
  nothing about any other.
- **Bearer mode against a real panel.** The acceptance runs username/password,
  which is the mode that was broken and the mode a fresh install uses. Bearer is
  covered against the fake only.
- **Marzban.** Covered now, but by its own suite and its own panel — see the
  second half of this document. Nothing in the 3X-UI section says anything
  about it.
- **SUSPEND, RESUME and TERMINATE for 3X-UI.** Not implemented, and deferred:
  `docs/providers/sanaei-3xui.md` records that this repository holds no
  evidence for how v3.7.0 disables, re-enables or deletes a client, so the
  operations are refused with `CAPABILITY_UNSUPPORTED` rather than attempted.

---

# Real-panel acceptance — Gozargah/Marzban v0.8.4

A second panel, a second suite, and the same rule: an adapter this repository
wrote and a fake this repository wrote can only prove they agree.

Marzban's turn cost a defect of exactly that shape. `MarzbanAdapter.createUser`
sent `inbounds` only when the operator had configured tags, and its docblock
said absent means "every inbound for those protocols, which is Marzban's own
documented default". It is the opposite: `UserCreate.excluded_inbounds`
excludes every inbound NOT named. The panel answers `200`, returns a
`subscription_url`, adds the account to Xray — and the customer's subscription
is **zero bytes**. Measured on the binary, two users differing only in that key:

| create payload                      | `links` | subscription body             |
| ----------------------------------- | ------- | ----------------------------- |
| `inbounds: {"vless":["VLESS TCP"]}` | 1       | 228 chars, one `vless://` URI |
| `inbounds` omitted                  | `[]`    | **0 chars**                   |

It had shipped in Phase 4D behind a green suite, and the service half of the
Marzban adapter had no test of any kind at the time.

## What the Marzban acceptance drives

`tests/acceptance/real-panel-marzban.test.ts` drives the **shipped**
`MarzbanAdapter` over the **real** `SafeHttpClient` against an upstream panel
running from the pinned commit. The OBSERVER is
`tests/acceptance/real-marzban-harness.ts`, on plain `fetch` with its own
token, sharing no code with the adapter.

Twenty-seven cases, in eight groups:

| Group | What it establishes                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------- |
| A1    | A and B are created, are distinct accounts, and each subscription carries **its own** credential        |
| A2    | A lookup finds A; an absent name is ABSENT; unlimited reads back as no limit, never as zero             |
| A3    | Suspending A disables A, leaves B serving, does not rewrite A's allowance, and is idempotent            |
| A4    | Resuming A re-enables A, leaves B alone, is idempotent, and an account the panel lacks is `found:false` |
| A5    | Terminating A removes A, leaves B serving, and a replayed terminate succeeds with `wasPresent:false`    |
| A6    | A username shaped like a path cannot reach B, through terminate or through suspend                      |
| A7    | No outcome — success or failure — carries the password, the username or an authorization header         |
| A8    | `applyAllowance` leaves the panel holding the TARGET — renew, add traffic and add time — and moves only the account named   |

## Standing one up

```bash
ACC=/srv/marzban-acceptance            # anywhere disposable
mkdir -p "$ACC" && cd "$ACC"

# 1. The panel at the pinned commit. Python, so no compile step.
git clone --depth 1 --branch v0.8.4 https://github.com/Gozargah/Marzban.git src
python3 -m venv venv && ./venv/bin/pip install -r src/requirements.txt

# 2. xray-core, or the panel restarts it in a loop and no inbound listens.
#    Any recent release; the acceptance does not depend on its version.
mkdir -p bin assets && cp /path/to/xray bin/xray
cp /path/to/geoip.dat /path/to/geosite.dat assets/

# 3. An inbound with a TAG, because the tag is what the activation names.
cat > xray_config.json <<'JSON'
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "tag": "VLESS TCP", "listen": "127.0.0.3", "port": 21443,
    "protocol": "vless",
    "settings": { "clients": [], "decryption": "none" },
    "streamSettings": { "network": "tcp", "security": "none" }
  }],
  "outbounds": [
    { "protocol": "freedom", "tag": "DIRECT" },
    { "protocol": "blackhole", "tag": "BLOCK" }
  ]
}
JSON

cat > .env <<ENV
SQLALCHEMY_DATABASE_URL=sqlite:///$ACC/db.sqlite3
UVICORN_HOST=127.0.0.1
UVICORN_PORT=8000
XRAY_JSON=$ACC/xray_config.json
XRAY_EXECUTABLE_PATH=$ACC/bin/xray
XRAY_ASSETS_PATH=$ACC/assets
XRAY_SUBSCRIPTION_URL_PREFIX=http://127.0.0.1:8000
ENV
cp .env src/.env

# 4. Schema, then a disposable sudo admin. The password never appears in argv.
(cd src && "$ACC/venv/bin/python" -m alembic upgrade head)
(cd src && MARZBAN_ADMIN_PASSWORD="$(cat "$ACC/.pass")" "$ACC/venv/bin/python" marzban-cli.py    admin create --username "$(cat "$ACC/.user")" --sudo --telegram-id '' --discord-webhook '')

# 5. Run it, detached, so it outlives the shell that started it.
(cd src && setsid nohup "$ACC/venv/bin/python" main.py > "$ACC/panel.log" 2>&1 < /dev/null &)
```

Marzban refuses to bind anything but localhost without `UVICORN_SSL_CERTFILE`,
and says so on startup. That is fine here and is the reason the URL above is
`127.0.0.1` rather than another loopback address: unlike the 3X-UI suite, this
one does not run against the container's real URL policy.

Then:

```bash
export NEXA_ACCEPTANCE_MARZBAN_URL=http://127.0.0.1:8000/
export NEXA_ACCEPTANCE_MARZBAN_USERNAME=...      # the disposable admin
export NEXA_ACCEPTANCE_MARZBAN_PASSWORD=...
export NEXA_ACCEPTANCE_MARZBAN_PROTOCOL=vless
export NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG='VLESS TCP'

pnpm test:acceptance
```

The harness refuses to start against a panel that does not serve the tag it was
given, and names what the panel does serve. An acceptance run against a tag the
panel lacks would create accounts with no configuration and call it a pass —
which is the defect this suite exists for, reached by a different road.

## What a real Marzban corrected, beyond the `inbounds` default

Each of these was **read** from `app/routers/user.py` and `app/db/crud.py` at
the pinned commit and then **run**; `docs/providers/marzban.md` holds the full
table.

- **A repeated disable and a repeated enable are both `200`.** Neither is an
  error, so a replayed `SUSPEND` or `RESUME` is naturally idempotent.
- **A repeated delete is `404`** — the same status an absent user gives on a
  read, which is why `terminateUser` reports it as success and `lookupUser`
  reports it as absence.
- **`status` on a modify takes only `active`, `disabled` or `on_hold`.**
  `expired` is `422`. `UserStatusModify` is a narrower enum than `UserStatus`.
- **Disabling really stops the account serving,** and the sibling on the same
  inbound keeps serving. Measured end-to-end through the inbound by
  `scripts/marzban-lifecycle-check.sh`, with a never-created UUID as the
  control. A run against the pinned binary:

  ```text
  L0 baseline
     panel A=active   B=active   | traffic A=SERVED     B=SERVED     control=NOT-SERVED
  L1 suspend A  -> HTTP 200
     panel A=disabled B=active   | traffic A=NOT-SERVED B=SERVED     control=NOT-SERVED
  L2 resume  A  -> HTTP 200
     panel A=active   B=active   | traffic A=SERVED     B=SERVED     control=NOT-SERVED
  L3 delete  A  -> HTTP 200
     panel A=ABSENT   B=active   | traffic A=NOT-SERVED B=SERVED     control=NOT-SERVED
  L4 delete  A again -> HTTP 404 {"detail":"User not found"}
  ```

- **Nothing re-enables a disabled user.** `app/jobs/review_users.py` iterates
  `status=active` only.
- **`subscription_url` is minted fresh on every response.** The token embeds
  `ceil(time.time())`, so two reads of an unchanged user return two different
  URLs; older tokens keep working. Nothing may treat a changed URL as evidence
  that anything changed.

### Two harness bugs, recorded because each reported the subject as broken

The lesson from the 3X-UI tunnel check, twice more.

**`no_proxy` made every probe pass.** The environment sets
`no_proxy=…,127.0.0.0/8,…`, so `curl -x http://127.0.0.1:10811` ignored the
proxy entirely and fetched the origin directly. Every account, including one
whose UUID had never existed, read as SERVED. `curl --noproxy ''` is what makes
`-x` authoritative.

**Xray 26.7.28's `freedom` outbound blocks private targets by default**, which
made every probe read as NOT-SERVED once the first bug was fixed —
`proxy/freedom: blocked target: tcp:127.0.0.4:9111, blackholing connection for
43s` in the server's error log. `settings.finalRules: [{action: "allow", ip:
[...]}]` on the DIRECT outbound is the knob, and it is only needed because the
origin is on loopback.

A negative control is what caught both: a UUID the panel never held must be
refused, and while it was being served the harness was measuring nothing.

## What the Marzban acceptance does NOT cover

- **Usage counters after real traffic.** Same boundary as the 3X-UI suite:
  A2 proves the adapter reads what the panel reports, not that the panel's
  figure moves.
- **One release.** v0.8.4 at `7f396db3e703d71a28060bc9ce4a532ec64cb1f4`.
- **Nexa's own machinery.** That an UNKNOWN outcome reconciles rather than
  guesses, that no provider call happens inside a database transaction, and
  that one tenant's operation cannot reach another tenant's service are
  properties of the executor, proved in
  `tests/integration/provisioning-delivery.test.ts` against a real PostgreSQL.
  A panel cannot observe any of them.
