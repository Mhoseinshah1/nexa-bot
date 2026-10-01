# Deploying Nexa

How an installation is created, operated, updated and rolled back. The
reasoning behind these choices is in
[ADR-0022](adr/0022-deployment-topology.md); this is the operator's document.

## What is supported

|                  |                                                 |
| ---------------- | ----------------------------------------------- |
| Operating system | Ubuntu **22.04 LTS** or **24.04 LTS**           |
| Architecture     | `x86_64` (amd64) or `aarch64` (arm64)           |
| Disk             | at least 8 GB free on `/var`                    |
| Ports            | 80 and 443/tcp, and 443/udp, free and reachable |
| DNS              | a name already pointing at the host             |

The installer checks every one of these before it changes anything, and stops
with the specific problem if one fails. The port check covers **443/udp** as
well as TCP, because the edge publishes it for HTTP/3 and a service holding it
would let Caddy fail to bind after the install had otherwise succeeded. A rerun
on a host where Nexa's own edge already holds a port is not a conflict — but
that is established by asking Docker which containers PUBLISH the port and
whether every one of them carries this installation's own Compose project and
service labels. Not by a container name: a name is the operator's, so
`nexa-caddy-foreign` and a `nexa-caddy-old` left by a rename both satisfied the
prefix match this replaced. A preflight that cannot establish the holder
refuses.

## Architecture

Five containers on one host, behind Compose.

```
                    internet
                       │
                    :80 :443
                       │
                 ┌───────────┐
                 │   caddy   │  TLS, the Web Admin bundle, reverse proxy
                 └─────┬─────┘
                       │  edge network
                 ┌─────┴─────┐
                 │    api    │──────────────┬───────────────┐
                 └─────┬─────┘              │               │
                       │                    │  edge (Telegram, panels)
   data network ┌──────┴──────┐      ┌──────┴──────┐ ┌──────┴──────┐
                │             │      │   worker    │ │   monitor   │
          ┌─────┴─────┐ ┌─────┴────┐ └──────┬──────┘ └──────┬──────┘
          │ postgres  │ │  redis   │◄───────┴───────────────┘
          └───────────┘ └──────────┘
```

- **Caddy** is the only container that publishes a host port. It terminates
  TLS, serves the Web Admin, and proxies `/api/*`, `/health/*` and
  `/telegram/webhook/*` to the API.

  That last one is not optional. The webhook controller is at
  `/telegram/webhook/:botInstanceId` and is **not** under `/api`, so without its
  own route it falls to the SPA fallback and answers Telegram `index.html` with
  a 200 — which Telegram reads as "update accepted". Every update would be
  acknowledged and discarded, silently.

- **PostgreSQL and Redis publish nothing.** They are on an internal network
  that Caddy is not attached to, so the internet-facing container has no route
  to the database at all.
- **api**, **worker** and **monitor** are the same image with different
  commands — `dist/main.js`, `dist/main.worker.js`, `dist/main.monitor.js`. All
  three reach the internet through the edge network: the worker because the
  notification dispatcher calls Telegram, the monitor because it probes
  operators' panels.
- **monitor** is a third role rather than a timer inside one of the other two.
  A panel probe is an outbound call to somebody else's machine with a timeout
  measured in seconds; on the API's event loop a fleet of slow panels becomes
  slow Telegram replies, and inside the worker it delays notification delivery.
  Panel health is written by this process and nowhere else, which is why
  readiness requires it: an installation whose monitor is dead serves every
  request correctly and reports every panel's health frozen at whatever it last
  was.
- Redis stores nothing yet (see ADR-0022) and runs without persistence.

## Filesystem layout

Four locations, with four different lifetimes.

| Path                    | Mode     | Contents                                              | Survives an update |
| ----------------------- | -------- | ----------------------------------------------------- | ------------------ |
| `/opt/nexa/deploy`      | 0755     | compose file, Caddy config, the env template          | replaced           |
| `/opt/nexa/lib`         | 0755     | `nexa-lib.sh`, shared by botctl and the installer     | replaced           |
| `/etc/nexa`             | **0700** | `nexa.env`, `postgres.env`, `redis.env`, `deploy.env` | **yes**            |
| `/var/lib/nexa`         | 0750     | release manifests, `current`, `previous`, the lock    | **yes**            |
| `/var/lib/nexa/assets`  | 0750     | each release's host assets, so a rollback has them    | **yes**            |
| `/var/backups/nexa`     | **0700** | database dumps                                        | **yes**            |
| `/usr/local/bin/botctl` | 0755     | the operator CLI                                      | replaced           |

Every file under `/etc/nexa` is mode `0600` and owned by root. Docker reads
them as the daemon, which is also root, so no container needs permission to.

## Installing

```bash
# On a fresh Ubuntu host, with DNS already pointing here.
sudo ./install.sh \
  --domain admin.example.com \
  --acme-email ops@example.com \
  --version v1.0.0
```

The installer will:

1. Preflight the OS, architecture, disk, ports and inputs.
2. Install Docker Engine and the Compose plugin from Docker's apt repository,
   verified by a `signed-by` keyring — never `curl | sh`. An existing Docker
   without Compose v2 is reported, not replaced.
3. Check that the release is reachable in the registry.
4. Create the layout and **generate secrets once**.
5. Resolve the version to an immutable digest and pull it.
6. Start PostgreSQL and Redis, migrate, provision the installation.
7. Start the whole stack and wait for readiness.
8. Create the first owner.
9. Configure the Telegram bot: ask for the token, validate it with Telegram, and
   register the webhook.

It is **idempotent**: a run that fails at any step can be repeated. Secrets are
never regenerated — a second run that minted a new database password would lock
the installation out of its own data.

The one exception is a secrets directory that is partly written, which only a
kill between two of the three files can produce. The installer refuses it
instead of filling in the rest, because the missing file's contents depend on
the finished files' secrets and rescuing that state means more code reading
secrets back. Nothing has started at that point: move `/etc/nexa` aside and
rerun.

A rerun is also refused when the version is unchanged but its tag has been
**moved** — the resolved digest no longer matches the installed release's
manifest. That is an update wearing a rerun's name, and it would migrate and
start new bytes with no backup and no rollback target.

### Rerunning after the first owner exists

The first owner is created several steps before the release manifest and the
`current` pointer are written, so an install interrupted in that gap leaves a
healthy installation with a real owner and no recorded release — `botctl
version` reports "no current release is recorded". That happened on a real
Ubuntu 24.04 staging host.

A rerun handles it, and does so without weakening anything. Before prompting,
the installer asks the application which of three states the database is in:

| State          | Meaning                                                                     | What the installer does                                                                                                                 |
| -------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `none`         | No administrator exists                                                     | Creates the first owner, as on a fresh host                                                                                             |
| `bootstrapped` | Administrators exist **and this installation's own bootstrap created them** | Says so and carries on to the release commit. Nobody is asked for a password again                                                      |
| `foreign`      | Administrators exist with no record of this bootstrap                       | **Stops.** This is somebody else's installation, and recording a release for it would attach this host's release identity to their data |

The evidence is the audit record `BootstrapOwnerService` writes inside the same
transaction as the owner, so there is no window in which the owner exists and
the answer is "no" — which a marker file written after the bootstrap CLI
returned would have had, in exactly the interruption it exists to recognise.
`audit_logs` refuses DELETE at the database level and the retention sweeper
touches only sessions and login attempts, so the answer does not expire.

What this does **not** do is make bootstrap idempotent. `BootstrapOwnerService`
still refuses outright whenever any administrator exists, whoever created them;
it creates the first owner and nothing else. Only the installer's next step
changes, never who may create an administrator. An answer the installer cannot
read is refused too: creating an owner would risk a second one, and skipping
would leave an installation nobody can log in to.

### Non-interactive installs

The first owner's password is never a command-line argument, because `argv` is
readable by every user on the machine through `ps`. Either type it at the
prompt, or:

```bash
umask 077
printf '%s' "$OWNER_PASSWORD" > /root/owner-password
sudo ./install.sh --domain … --acme-email … --version v1.0.0 \
  --owner-username owner --owner-display-name 'Owner' \
  --owner-telegram-id 123456789 \
  --owner-password-file /root/owner-password
shred -u /root/owner-password
```

An install with no terminal and no `--owner-password-file` fails rather than
silently skipping the owner. The same holds for `--owner-telegram-id`: the
first owner is created **bound to a Telegram numeric id**, in the same
transaction as the owner row, because `/link` can only be sent by an
administrator who is already bound — so an owner created without one had no
supported way into the bot. On a terminal the installer asks for it; without a
terminal it refuses before creating anything. The id is not a secret and may be
an argument. It is the account's NUMERIC id (digits only), never a username.

A rerun of an installation that has already created its owner does not ask for
the id again and never rewrites the binding; an existing installation whose
owner was created without one connects it under **Web Admin → System →
Administrators**. Either way the owner has to open the bot and send `/start`
once before Telegram will deliver anything to that account.

The bot token follows exactly the same rule, for the same reason, and has the
same escape hatch:

```bash
umask 077
printf '%s' "$BOT_TOKEN" > /root/bot-token
sudo ./install.sh --domain … --acme-email … --version v1.0.0 \
  --owner-password-file /root/owner-password \
  --bot-token-file /root/bot-token
shred -u /root/bot-token
```

The file is **streamed on stdin** into the container, exactly as the owner's
password is, and is never copied anywhere. It is deliberately not bind-mounted:
the release image runs as `node` (uid 1000) and a file created under `umask 077`
is root-owned and mode 0600, so a mount is unreadable inside the container and
this whole path fails with `EACCES`.

A rerun that supplies a token file for a **different** bot is refused rather than
ignored — the file is read on every state so the bot id can be compared, and only
the id half is ever used. The secret half never replaces a stored credential.

### The Telegram bot

The installer's last step asks for the bot token:

```
==> configuring Telegram bot
Telegram Bot Token:
```

Nothing is echoed, and the token is never an argument, never an environment
variable, and never written to disk in plaintext. It is validated against
Telegram with `getMe` **before** it is stored, so a token Telegram refuses never
becomes a row — a stored credential that has never worked is indistinguishable
from one that stopped working, and an operator debugging the second would be
looking in the wrong place. The bot's identity comes from Telegram's answer, not
from anything typed.

The webhook is then registered at
`https://<your domain>/telegram/webhook/<bot instance id>`, authenticated by the
installation-wide `TELEGRAM_WEBHOOK_SECRET` the installer mints.

**A rerun reconciles; it never rotates.** If a bot is already configured the
installer does not ask for the token again, does not replace it, and does not
repoint the installation at another bot — a token for a different bot supplied
on a rerun is refused with a message saying so, rather than silently ignored.
Changing which bot an installation serves is a deliberate, separate act, because
every stored Telegram user and chat belongs to the bot it already has.

**A failed registration is not a failed install, and is not a successful one
either.** If Telegram cannot be reached — DNS not yet propagated, a certificate
not yet issued — the tenant, the owner, the encrypted token and the bot row all
survive, the release is recorded, and the installer reports the Telegram
bootstrap as INCOMPLETE and **exits non-zero**. Nothing needs undoing and
nothing needs typing again:

```bash
botctl telegram status     # none | incomplete | ready | unavailable
botctl telegram register   # resumes from the stored token; never asks for one
```

`status` writes **one of those four words to stdout and nothing else**, so a
script can compare it without parsing prose. `unavailable` is the fourth and this
section used to document only three, which meant automation written from it
rejected a legitimate answer exactly when something had been disabled.

It means the bot cannot receive an update for a reason a registration would not
fix — `TELEGRAM_WEBHOOK_ENABLED` is false, the tenant has stopped accepting work,
or the bot instance is not ACTIVE — and **which one is printed on stderr**, so it
is visible to a person and invisible to `$(botctl telegram status)`.

`--skip-telegram` leaves the bot unconfigured in this run and says what to run
later. It does not report an already-configured bot as unconfigured, and it is
not defeated by a Telegram state the installer cannot read — skipping is a
decision you already made.

A rerun asks Telegram whether the stored token still works **every time**,
including when nothing else is outstanding. That is the only way a revoked token
can be reported rather than assumed away.

**What this release cannot do: change the bot.** There is no command that
replaces a stored token, by design — the installer reconciles and never rotates.
The consequence is that a token revoked or rotated in BotFather leaves the
installation permanently incomplete, and the only way back is SQL. The deliberate
replacement workflow is `OQ-TG-01` in `docs/open-questions.md`; do not rotate a
bot token on a running installation until it exists.

Rotating the **webhook secret** is supported. Change it in `nexa.env`, restart,
and run `botctl telegram register`: the registration records a digest of the
secret it used, so a changed value reads as outstanding rather than as done.

An installation created before this release has no Telegram keys in its
`nexa.env`. A rerun of the installer adds `TELEGRAM_WEBHOOK_ENABLED` and a fresh
`TELEGRAM_WEBHOOK_SECRET`, and **never regenerates a secret that is already
there**: Telegram holds the value it was given at registration, so minting a new
one would make the API reject every update from a working bot.

### A private release package

If the GHCR package is private, authenticate before installing. The installer
deliberately embeds no token of its own:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
```

The token needs `read:packages` and nothing else. If the package is later made
public, remove the credential — nothing in the installer depends on it.

## Operating

```
botctl status              what is running, and whether it is ready
botctl version             installed version, source commit, image digest
botctl backup              a verified, timestamped PostgreSQL dump
botctl update <version>    update to a version
botctl rollback            return to the previous release
botctl logs [service]      follow logs
botctl restart             restart the stack
```

None of these print a secret. `botctl status` reports container state and the
resolved configuration by key and by presence, never a secret's value, so its
output can be pasted into a ticket.

`botctl status` reports a `capabilities:` section, because several settings
default OFF and that is correct — an upgrade must not start taking and delivering
backups, or start dialling an operator's panels, because a new release learned
how to. The cost of that correctness is that an installation which never added
the line is in the disabled state, and until this section existed no command
would say so. It applies the same defaults and the same PER-KEY vocabulary the
application applies — `PANEL_MONITOR_ENABLED`
is a `true`/`false` enum while the others also take `1`/`0`/`yes`/`no`, and a value
outside its own key's vocabulary reads as `invalid` rather than being guessed at.
Values come from `docker compose config`, not from reading the file. Compose resolves
`env_file` semantics — quoting, inline comments, trimming, values spanning lines, and
**interpolation**, so `${UNSET:-true}` arrives as `true` and `${HOME}` comes from the
ambient environment — and reproducing that in a shell script means reproducing
Compose's variable precedence. So `status` asks Compose what a container started now
would receive, and applies only the part that is the application's own: the per-key
vocabulary the schema accepts. It also surfaces the one answer that matters more than
any value, because Compose reports it directly: a configuration Compose REFUSES, from
which no container can be created or recreated — repeating Compose's own reason, cut
before any value Compose echoed back, and saying nothing about a container already
running, which keeps the environment it was created with. The backup delivery destination is
reported by PRESENCE only, because one of its two keys is a bot token. Neither
section's values reach a `bash -x` trace either: both run with tracing off, because a
trace of the resolved listing would carry the keyring, the database password and the
backup bot token into output an operator pastes into a ticket. `botctl secrets
migrate-config` and the `nexa.env` rewriter do the same, for the same reason.

Each line names the process that READS the value, which is the operator's next
question. The section claims nothing about what those processes are currently
running: a container keeps the configuration it was created with, so a value
changed since that container was CREATED is not yet in force in it, and the section
says so as a standing caveat rather than pretending to detect it. The caveat names
CREATION, and then names the four subcommands that recreate: `restart`, `update`,
`rollback` and `secrets disable-v1`. A recreation loads the edited file, because `up -d`
resolves `env_file` into the service environment before hashing it and that hash is what
decides recreation — established from the Compose binary in `UNK-DEPLOY-001`, which
records it after two rounds of claiming the opposite on the strength of
`docker compose config --hash`, a probe that does not resolve `env_file` and so answers a
different question.

But a successful command is NOT a recreation. Two of those four return 0 having recreated
nothing — `update` on the release already installed, and `secrets disable-v1` when the
setting is already false — so "a successful one of those has loaded the edited file", which
this paragraph said for two rounds, is false in exactly the states the rest of this document
describes. Each of those commands says what it did in its own output, which is why the
section points an operator at that output rather than guessing: naming the commands that CAN
recreate is a true statement `status` can make, and claiming one of them DID is not.

The one thing still unobserved is any of it against a real daemon; `docs/vps-acceptance.md`
step 12c is three numbered steps that settle it. The delivery
destination names three processes because three deliver — the worker schedules,
the API serves the Web Admin's manual run, and the recovery executor takes the
pre-restore backup.

So `scheduled backup   off` is not a fault report. It means no automatic backup
is taken, `botctl backup` still works, and a backup somebody remembers to run is
not a backup policy. `backup delivery    not configured` means a run still dumps,
verifies against a real scratch restore and retains locally, with its delivery
outcome recorded as `NOT_ATTEMPTED`.

`docs/config-upgrade-audit.md` classifies every configuration variable an
installation runs on: whether it must be set deliberately, whether a missing line
is a safe schema default, whether its absence is a real disabled state, and which
old spellings still map to the current model. It exists because `botctl update`
does not rewrite `nexa.env` — deliberately, so it cannot overwrite an operator's
choice — which makes "a missing line is safe" a claim about every variable added
after the first install.

`botctl update` does remove the three keys that audit classifies as obsolete:
`BUILD_VERSION`, `BUILD_COMMIT` and `BUILD_TIME`. The first production template
wrote them into `nexa.env`, `env_file` beats an image's own ENV, and nothing ever
took them out again — so `/health/info` reported what the installer substituted
rather than what was built. The removal is one atomic rewrite and is non-fatal: a
stale build label is not worth failing an update over.

Because that removal happens before the image is pulled, `botctl status` also asks
the running API whether its build identity is its own IMAGE's. Not whether it HAS
one — the release image stamps all three keys on every build, so that question
answers yes on every healthy installation — but whether the values agree with the
image they came from. A difference is a container created while the file still set
them, and the remedy is `botctl restart`.

`botctl status` also reports the installation's position on v1 ciphertext,
because an operator should not have to know that `botctl secrets status` exists
to learn they are still carrying the envelope this project is retiring. Two
facts, kept apart because they have different remedies:

- **whether v1 is accepted** — configuration, read from `/etc/nexa/nexa.env` by
  key presence only, with the same default rule the application applies
  (legacy `SECRETS_KEK` means on, canonical `SECRETS_KEYS` means off, an
  explicit `SECRETS_ACCEPT_V1` wins);
- **whether v1 rows remain** — data, asked of the application. When the stack
  cannot answer, the line says `unable to determine`, which is a different fact
  from `0`.

The section names the exact next commands for its state — `migrate-config`,
`rewrap`, `shutdown-check`, `disable-v1` — and prints no key, ciphertext or
token. When the shutdown is complete it repeats the caveat that matters then:
backups taken before the re-encryption still hold v1 ciphertext.

Readiness, for `status`, for `update` and for `rollback`, means **all three**
application containers healthy. The API's check is its own `/health/ready`.
Neither the worker nor the monitor serves HTTP, so each writes a heartbeat file
its container check reads — the worker's every ten seconds and only after a
round trip to the database succeeds; the monitor's under the same rule plus one
more, that its scheduling loop has made PROGRESS recently. A process whose timer
still fires while every tick throws is not monitoring anything, and a heartbeat
that only proved the process existed would report it healthy for ever — so
there is no startup grace either: before the first successful discovery the
monitor is not healthy, because it has not yet done the thing it exists to do.
Progress is marked as each panel in a sweep is finished with rather than only at
the end of one, so a bounded batch of slow provider calls stays healthy while it
works. A deliberately disabled monitor (`PANEL_MONITOR_ENABLED=false`) stays
healthy: it is a process doing nothing on purpose, not a broken one.

Any of the three in a crash loop, alive with a blocked event loop, or alive and
cut off from PostgreSQL goes unhealthy within a check or two, and a release in
that state is backed out exactly as one whose API never answered.

The required set is intersected with what the ACTIVE compose file defines, and
that is what keeps rolling back to an older release valid. Host assets are
release-versioned: a rollback activates the target's `compose.yml` and then
waits for readiness while the new library is still in memory. A release that
predates the monitor defines no such service, and demanding one would time out
every rollback to it — after the assets had already moved. The relaxation is
exactly one service wide; a monitor-less topology still requires its API and its
worker.

## What one installation can keep fresh

Panel health carries a freshness window (`PANEL_HEALTH_FRESH_FOR_MS`, fifteen
minutes), and meeting it takes more than a cadence that fits. The cadence check
at boot proves a panel that IS probed is refreshed in time; it says nothing
about whether every panel gets probed. That is throughput, and it has two
ceilings that live at different levels.

**Per tenant — the probe bucket.** Background probes spend the same bucket as an
operator's manual tests, so the long-run background rate cannot exceed its
refill rate:

    (PANEL_PROBE_TENANT_LIMIT / PANEL_PROBE_TENANT_WINDOW_MS)
      x PANEL_MONITOR_HEALTHY_INTERVAL_MS

Defaults: 100 tokens per 5 minutes over a 3-minute interval = **60 panels per
tenant**.

**Installation-wide — the scheduler.** A tick discovers at most
`PANEL_MONITOR_BATCH_SIZE` candidates IN TOTAL, shared out among the tenants
claimed that tick, so across one interval the loop can start at most

    PANEL_MONITOR_BATCH_SIZE x (PANEL_MONITOR_HEALTHY_INTERVAL_MS / PANEL_MONITOR_TICK_MS)

Defaults: 150 x 6 = **900 panels for the whole installation**.

These are different questions and the second is not a per-tenant number. A
hundred tenants of twenty panels each is comfortably inside every per-tenant
bound and asks the scheduler for two thousand starts an interval when it can
manage nine hundred — an overload no per-tenant check can see. What share of the
global ceiling any one tenant gets is decided by the fairness rotation against
whoever is due at that moment, so it changes minute to minute and is
deliberately not modelled as a constant.

**How many TENANTS get a turn — the fairness rotation.** A third ceiling,
independent of both panel counts above, and the one that was invisible. A tick
claims at most `PANEL_MONITOR_TENANTS_PER_TICK` tenants, so inside one interval
the rotation reaches

    PANEL_MONITOR_TENANTS_PER_TICK x (PANEL_MONITOR_HEALTHY_INTERVAL_MS / PANEL_MONITOR_TICK_MS)

Defaults: 10 x 6 = **60 tenants**. A tenant beyond that waits longer than the
healthy interval for its first probe of the cycle and its panels go stale no
matter how few it has — and because a hundred single-panel tenants is a hundred
panels, far under the 900-panel scheduler ceiling, neither of the panel bounds
above says anything about it. `GET /system/monitor` reports it as
`tenantTurnCeiling` beside the other two. Raising `PANEL_MONITOR_TENANTS_PER_TICK`
raises it, bounded by `PANEL_MONITOR_BATCH_SIZE`; shortening the tick raises it
too, at the cost of more discovery queries.

Neither number is a guarantee:

- **Latency is not modelled.** Throughput also depends on how long a probe
  takes, and that is a round trip to somebody else's server: a fleet answering
  in 40ms and one answering in 9s have identical configuration and very
  different capacity. `slowProbeLatencyModelFigure` exists to make that point
  and is explicitly not a completion count — the real loop does not overlap
  ticks and spends time on discovery, claims, budget and writes between probes.
- **The operator is not assumed idle.** Manual "Test connection" probes come out
  of the same bucket one for one, so sustained manual traffic lowers what is
  left for the monitor.

A population ABOVE either bound certainly cannot be kept fresh, which is what
makes it worth reporting; one below is not thereby guaranteed. The monitor
re-assesses on `PANEL_MONITOR_CAPACITY_INTERVAL_MS` (ten minutes by default) —
not once at startup, because the population an operator grows into is exactly
the one that matters — and records operational conditions rather than log
lines, so repeated unchanged overload collapses onto one row with an occurrence
count and the condition resolves when the population comes back under:

| condition                                   | scope                        | resolved by                           |
| ------------------------------------------- | ---------------------------- | ------------------------------------- |
| `panel.monitor.tenant_budget_exceeded`      | the tenant                   | `panel.monitor.tenant_budget_ok`      |
| `panel.monitor.scheduler_capacity_exceeded` | the installation (no tenant) | `panel.monitor.scheduler_capacity_ok` |

The pair is mutually exclusive: each closes the other, so a population that
crosses a bound twice produces two overloads and two recoveries rather than one
of each with a stale row left open beside it. Which of the four is open is read
from the rows on every assessment, so a monitor that restarts between the
overload and the recovery still resolves what the process before it opened.

Raising either bound is a deliberate act whose cost lands on somebody else's
server: `PANEL_PROBE_TENANT_LIMIT` is an outbound rate against a customer's
panels. `docs/vps-acceptance.md` is where a measured figure for a real
installation belongs. The monitor will not widen it on the installation's
behalf.

## Backups

`botctl backup` runs `pg_dump` inside the database container and writes
`/var/backups/nexa/nexa-<version>-<timestamp>.sql.gz`, mode `0600`.

It is written to a temporary name first and only renamed after three checks:
gzip integrity, at least 1 KB of **uncompressed** SQL, and `pg_dump`'s own
completion marker. A truncated dump is the one failure that produces a file
looking entirely normal until it is needed.

Copying the PostgreSQL data directory of a running server is **not** a backup
and nothing here does it.

Backups are not rotated automatically. Retention is an operator decision;
`/var/backups/nexa` is on the disk-space checklist.

## Updating

```bash
sudo botctl update v1.1.0
```

The algorithm, in order. An exclusive `flock` is held for the whole run, so a
second update, an install or a rollback is **refused** — it does not queue. A
command that silently waits out a long migration tells the operator nothing;
"another install, update or rollback is already running" tells them everything.

1. **Resolve** the version to an image digest. The tag is read exactly once.
2. **Pull** by that digest. A tag repointed a second later cannot change what
   is installed.
3. **Back up** the database.
4. **Install the target's host assets** — `botctl`, `nexa-lib.sh`,
   `compose.yml`, `nexa.env.template` and the Caddy configuration — read out of
   the target's own image. See below.
5. **Migrate**, using the _target_ release's own compiled migrator — so the
   schema change is the one the incoming code expects, by construction.
6. **Start** the target release.
7. **Wait** for the API's readiness probe.
8. **Commit**: write the release manifest, then the image pointer, then
   `previous`, then `current`.

Step 8 is the only durable moment. Everything before it leaves the previous
release current and running.

The order inside step 7 is deliberate. The image pointer — what a restart or a
reboot would actually start — is written before `current`, which is what every
command reports. So an interruption partway through leaves an installation that
still reports the previous release and is fixed by re-running the update, rather
than one that reports the new release while quietly starting the old one.
`botctl version` and `botctl status` compare the two and report a divergence
loudly if they ever disagree.

### Migration preflight

Between the backup and the migration, the update runs the **target** release's
migrator in check-only mode:

```
node dist/infrastructure/persistence/migrate.js --preflight
```

It reads the database with the connection string alone — no application secret
— and refuses conditions a migration would not survive. The one it exists for:
migration `0015_single_primary_tenant` creates a partial unique index that
requires at most one tenant with `kind = 'PRIMARY'`. A database seeded by an
early development build can hold more, and against it 0015 failed inside
PostgreSQL with a raw `23505`, after the backup, with a stack trace as the only
explanation. 0015 is applied everywhere and is therefore immutable, and no
later migration can help, because execution never reaches it.

When the check refuses, the update stops **before** migrating: the current
release is still current, the database was not changed, the host assets were
not touched, and the backup just taken is where the message says. The check
never repairs anything — which tenant is the real one is not a decision a
script may take on production data. Decide, remove or re-kind the others, and
run the update again. For a legacy **development** database whose extra
PRIMARY rows came from an old seed, resetting the database is the honest
remedy.

A tenants table without a `kind` column, or no tenants table at all, passes:
the check is about one condition and says nothing about anything older or
newer. `runMigrations` itself runs the same check first, so the installer, CI
and a developer's shell are under the same rule.

### The host assets move with the release

Most of a release lives in the immutable image. Six files do not:

| File                                  | What a stale copy costs                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `/usr/local/bin/botctl`               | the operator CLI is the previous release's              |
| `/opt/nexa/lib/nexa-lib.sh`           | botctl calls functions that do not mean what it expects |
| `/opt/nexa/deploy/compose.yml`        | the new image runs under the old topology               |
| `/opt/nexa/deploy/nexa.env.template`  | a rerun of the installer generates the old key set      |
| `/opt/nexa/deploy/caddy/Caddyfile`    | the edge serves the previous release's configuration    |
| `/opt/nexa/deploy/caddy/routes.caddy` | new surfaces are not routed                             |

These are release-versioned behaviour, so `botctl update` moves them with the
image. It reads them out of the **target image**, addressed by digest — never
from a git checkout, which is mutable, may be a different commit, and is not
required to exist on a production host at all.

Three steps, in this order:

1. **Stage** the target's set into `/var/lib/nexa/assets/<digest>`, extracted
   from its image. A pure read: a release that does not carry them fails here,
   before anything on the host has changed. The extraction writes to a
   `.partial` directory and renames it only once every file is present, so an
   interrupted one leaves nothing for a later activation to install from.
2. **Record** what is live now, under the digest that is running, so a failed
   update has something to put back.
3. **Activate** the target's set, before the migration and the start, so the
   target runs under its own compose file and Caddy routes. Each file is
   written beside its destination and renamed over it — atomic, so an
   interruption leaves either the old file or the new one and never a truncated
   `botctl`; and safe for a `botctl` that is replacing itself while bash is
   still reading it, because a rename swaps the directory entry and leaves the
   running process's inode alone.

**Sets are keyed by digest, never by version.** A version is a tag, and a tag
can be moved. Keyed by version, a set staged from one digest was silently
reused by a later attempt that had resolved the same tag to a different digest,
and the image ran one release's code under another's compose file and `botctl`.
The digest is the identity every other part of an installation already uses (a
release _is_ a digest), so a moved tag stages a new set rather than finding an
old one. Each directory carries a `release` marker naming the version, for a
human reading `/var/lib/nexa`; nothing reads it back.

**Activation is one unit.** Before the first file moves, the live copy of every
destination is saved under `/var/lib/nexa/assets/.activating/` and a journal
is opened; as each file is replaced, one line is appended; on any failure the
journal is replayed backwards and every saved copy goes back; on success the
directory is removed. An installation therefore never holds three files from
one release and three from another. If that directory exists when an update or
rollback begins — the previous activation was interrupted by a power cut or a
kill — the restore is replayed first, before anything else changes, and
`botctl status` says so until it has been.

Every failure path from step 3 onwards puts the outgoing release's set back
before restarting it, so a failed update leaves an installation whose tooling
matches what is actually running.

A rollback does the same in reverse: it activates the previous release's
recorded set before starting its image. The alternative — leaving the newer
tooling to operate the older image — would be a compatibility contract, and
nothing here proves one.

A rollback that does not work out backs out in full, exactly as a failed update
does: the current release's assets go back **and its containers are started
again**, and the message says whether that worked. Restoring only the assets was
not enough. On the readiness path `compose up -d` has already succeeded, so the
containers are running the previous release — while the recorded release and
`deploy.env` both still name the current one and agree with each other, which is
what the divergence check compares. It saw nothing wrong, and `botctl status`
named a release that was not running.

Neither back-out can be aborted by its own failure. The two helpers involved
report through `nexa_die`, which exits, so a restore that could not finish used
to replace the message telling the operator which release had started; they are
now called so that the caller survives them. For the same reason, recording the
outgoing release's assets is best effort on a rollback: a rollback whose target
is sound is never refused for the sake of its own undo, and the operator is
warned instead.

### A set that was never recorded is recovered from the image, by digest

An installation whose last update was performed by a `botctl` that keyed
host assets by **version** — every host that ran staging.7 or earlier when it
took staging.8 — has manifests and digests for both releases but no set under
either digest: only `/var/lib/nexa/assets/<version>` directories written by the
old tooling. That is exactly the state the first `botctl rollback` on the
staging host found, and it refused.

It no longer refuses; it recovers, and it does so from the only source it can
trust. A version-named directory is **not** identity: nothing records which
digest it was extracted from, a tag can be moved, and a directory on disk can be
edited. So the recovery reads the previous release's **manifest**, takes the
**digest recorded there**, pulls `IMAGE_REPO@<digest>` — the previous **version
tag is never resolved**, because a moved tag would install a different release
under the old name — and stages the set from that immutable image under
`/var/lib/nexa/assets/<digest>` through the same extraction, `.partial` rename
and completeness check an update uses. Where the image carries a source-commit
label and the manifest records a commit, the two must agree. Only a set that
came through all of that is activated.

If any of it fails — the image can no longer be pulled, it carries no complete
host-asset set, or its commit disagrees with the manifest — the rollback refuses
**before anything on the host has changed**, names the reason, and leaves the
current release exactly as it was. The version-named directories are left where
they are, inert: they are neither trusted nor deleted, and pruning them is the
operator's decision.

The current release gets the same treatment on the way out. If its own set is
not recorded under its digest, it is recovered from its image by digest — the
one that is live, read from the manifest — so a rollback whose activation fails
part-way has a set to put back. The `assets/<version>` directory that the old
`botctl` wrote for it is not used for that either, even though it is probably
right: "probably" is the property this mechanism exists to remove.

### Installations made before this mechanism existed

An update is performed by the `botctl` that is **already installed**, so a host
whose `botctl` predates this mechanism cannot be repaired by an update: the
script that would move the host assets is the one that is missing. That is not
a gap in the mechanism, it is what "the tool updates itself" means, and no
amount of work in a later release can reach backwards into a script already on
disk.

Rollback needs no repair on such a host: the section above recovers what it
needs from the image, by digest. An update does not, because an update is the
thing the missing script would have performed. Such a host needs one repair,
once, and then never again:

```bash
# On the host, for the version it is ALREADY running. The installer is
# idempotent: it recognises an existing installation, does not regenerate
# secrets, and reports that the first owner already exists.
sudo ./install.sh --domain <the same domain> --acme-email <the same address> \
  --version <the version botctl currently reports>
```

That reinstalls the host assets from the release's own installer and records
them, after which `botctl update` carries them forward on its own. Confirm with
`botctl version` and then update normally.

The mechanism itself needs no such repair on a host that already has it: an
installation with nothing recorded in `/var/lib/nexa/assets` has whatever is
live captured by the first update that runs, so there is always something to
roll back to.

### What happens when it fails

| Failure                             | Result                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The version cannot be resolved      | Current release untouched. Nothing pulled.                                                                                              |
| The image cannot be pulled          | Current release untouched. No backup, no migration.                                                                                     |
| The backup fails                    | **The update does not proceed.** Nothing is migrated.                                                                                   |
| The pre-migration check fails       | **The update stops before migrating.** Host assets untouched; the check's own message says what to fix.                                 |
| The image carries no host assets    | Refused before anything on the host changes.                                                                                            |
| The outgoing set cannot be recorded | Refused: a failed update would have nothing to put back.                                                                                |
| The migration fails                 | Host assets restored. The target does not become current. The pre-migration backup is named in the error.                               |
| The target does not start           | Host assets restored, then the previous release is restarted; it remains current.                                                       |
| The target is never ready           | Host assets restored, then the previous release is restarted; it remains current.                                                       |
| The target's worker is not healthy  | Treated as "never ready": a healthy API beside a dead or crash-looping worker is not a working release.                                 |
| The target's monitor is not healthy | Treated as "never ready" too: panel health has one writer, and a release that stops writing it looks perfectly well from every request. |
| Activation fails part-way           | Every file already replaced is put back from the saved copy; nothing else has changed.                                                  |
| The rollback is not healthy         | Reported loudly. **Neither release is deleted.**                                                                                        |
| The previous set was never recorded | Recovered from the previous release's image, by the digest in its manifest; the version tag is not read.                                |
| The previous image cannot be pulled | Rollback refused before anything changes. The current release is untouched.                                                             |
| The previous image has no assets    | Rollback refused before anything changes. No partial set is left under its digest.                                                      |
| The image's commit disagrees        | Rollback refused: the image was built from a commit the manifest does not record.                                                       |

The previous release is never deleted by the update that replaced it. Manifests
are pruned to the five most recent by an update — a rollback prunes nothing —
and the current release and the rollback target are never pruned, so an
installation keeps at most seven.

## Rolling back

```bash
sudo botctl rollback
```

Rollback returns the **application** to the previous release's image. It does
**not** restore the database.

That is deliberate and it is the most important sentence in this document. The
backup was taken before the migration, so restoring it would discard every
write made since — an outage turned into data loss by the tool meant to fix it.
Restoring a backup is a separate, explicitly destructive operation:

```bash
# Only when you have decided that losing everything written since the backup
# is the correct outcome. Stop the application first.
gzip -dc /var/backups/nexa/nexa-<version>-<stamp>.sql.gz \
  | docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
      exec -T postgres psql -U nexa -d nexa
```

Rollback is itself undoable: the release you just left becomes the new rollback
target.

### What a rollback can strand: a customer notification kind the old release cannot read

A release that adds a value to an enum a CHECK constraint pins makes the database
accept it immediately and does **not** make the previous release able to read it.
`botctl rollback` never restores the database, so rows the newer release wrote
outlive it.

There is one instance of this today, and it is bounded. The release that follows
`v0.2.0` adds the customer notification kinds `PAYMENT_TRANSFER_RECORDED` and
`ORDER_CANCELLED`, which are queued only when Telegram rate-limits one of two
interactive replies — a recorded transfer claim or a withdrawn order. Roll back
to `v0.2.0` with such a row still `PENDING` and that release's dispatcher cannot
render it: it logs `customer notification send failed` once per sweep and the
stranded-send reaper resolves the row `UNCONFIRMED`. The customer is never told,
and nothing tells them afterwards either.

**How to see whether it happened**, on the rolled-back installation:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT state, count(*) FROM customer_notifications
    WHERE kind IN ('PAYMENT_TRANSFER_RECORDED','ORDER_CANCELLED') GROUP BY state"
```

**The remedy is to roll forward, then requeue.** Update to the release that knows
the kinds — it defers rather than strands anything it cannot render — and then
reset the rows the old release resolved:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "UPDATE customer_notifications
      SET state = 'PENDING', resolved_at = NULL, next_attempt_at = NULL,
          send_started_at = NULL
    WHERE kind IN ('PAYMENT_TRANSFER_RECORDED','ORDER_CANCELLED')
      AND state = 'UNCONFIRMED'"
```

Do this ONLY for these two kinds and only after rolling forward. `UNCONFIRMED`
normally means "Telegram may have it", and requeueing one of those is how a
customer comes to read two contradictory messages; here it means the send was
never attempted, which is why this narrow case is safe and no other is.

Releases after that one carry a guard: a dispatcher that meets a kind it has no
template for defers the row, spending no attempt and writing no stamp, so a
replica that knows the kind delivers it. That covers every rollback to that
release or later. It cannot cover a rollback below it, because that code is
already published — see `docs/conventions.md`, "A widened enum is
write-compatible, not reader-compatible", for the staging rule that avoids
repeating this.

### What a rollback can misquote: a gateway attempt that carries a customer fee

WP18 lets a gateway route charge the customer a fee. The fee is snapshotted on the
attempt: `payments.amount` stays the principal, and `customer_fee_amount` and
`payable_amount` sit beside it. The provider is asked for the payable. The release
before WP18 knows nothing of those two columns. If an attempt that carries a fee is
still open when you roll back, that release shows the customer the principal as the
amount to pay, while the provider's invoice asks for the payable. The customer is told
one figure and asked for another.

It cannot happen unless an operator set a non-zero fee on a route, and an attempt lives
at most 70 minutes. So it is avoided, not repaired.

**Before rolling back past WP18**, set every route's fee to 0 in the Web Admin (Payment
Gateways). New attempts then carry no fee. Wait until no open attempt carries one:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT count(*) FROM payments
    WHERE method = 'GATEWAY' AND state = 'PENDING' AND customer_fee_amount > 0"
```

Roll back when that count is 0. It reaches 0 within the attempt deadline, 70 minutes.

**If you already rolled back** with such an attempt open, roll forward. The release
that knows the fee shows the three figures again. An approval is still decided only by
the provider's own inquiry, and the wallet or the order receives the principal, so no
money is credited wrongly in either release. Only the figure shown is wrong.

The financial log's own rows are `OPERATIONAL_EVENT` notifications with templates
under `ops.financial.*`. They have no kind of their own on purpose: that release's Web
Admin reads the kind as a strict list, and one unknown value would refuse its whole
notifications page. It lists these rows by their template key. Its dispatcher has no
template for them, so a pending one is abandoned rather than delivered. The payment and
refund rows remain the record.

### What a rollback delays or drops: customer refund requests (WP19)

WP19 lets a customer ask for a refund of a service. An administrator approves an
amount; the provider account is deleted; a sweep then credits the wallet. The release
before WP19 has none of this. Nothing in it crashes on WP19's rows, but four things
happen differently while it runs:

- **An executing request is not credited.** Its `TERMINATE` is an ordinary operation,
  so the old provisioner still deletes the account, but it has no sweep to credit the
  reservation. The customer has no service and no money until you roll forward. The
  reservation still counts against the payment, so nothing can be refunded twice. The
  first tick after the roll-forward credits it.
- **A new request's review cards are not sent.** A `ServiceRefundRequested` event the
  old relay meets has no consumer there and is marked published. The request itself
  stays in the Web Admin (Services) and is decided from there.
- **A reason being typed goes to the service note.** The old bot treats a text capture
  it does not know as a service note. A customer who opened the refund form in the ten
  minutes before the rollback, and sends the reason after it, has that text saved as
  the service's note and no request filed.
- **An operator can close a reservation by hand.** The old release's refund `complete`
  and `fail` accept a reserved refund. Its Web Admin offers neither for one, but a
  hand-made API call does. After the roll-forward the sweep refuses such a request
  rather than announce a credit that was never written. It stays EXECUTING, in front of
  an operator, and every other request is still decided.

Financial facts that happen while the old release runs are not written to the
financial log (WP18). Its relay has no consumer for them either.

**Before rolling back past WP19**, switch the `customer_refund_requests` flag off
in the Web Admin's feature flags, so no new request is filed. Wait until nothing is executing:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT count(*) FROM service_refund_requests WHERE state = 'EXECUTING'"
```

An OPEN request can wait through a rollback; it is decided after the roll-forward.

### What a rollback strands: extra-users rates (WP-A5)

WP-A5 adds a third service add-on kind, `ADD_DEVICES`: the per-user rate an operator
sets on the Web Admin's «افزایش کاربر / دستگاه» page. The release before WP-A5 maps every
add-on row it reads as either `ADD_TRAFFIC` or `ADD_TIME`
(`DrizzleServiceAddonRepository.specificationOf`), and an `ADD_DEVICES` row has neither a
traffic amount nor a duration, so it throws. That release has no add-on screen in its Web
Admin; what fails is its add-on API:

- `GET /service-addons` answers **500** whenever the page it reads holds an
  `ADD_DEVICES` row — with no `kind` filter, or with `status` alone. Filtered to
  `kind=ADD_TRAFFIC` or `kind=ADD_TIME` it is unaffected. Filtered to
  `kind=ADD_DEVICES` it answers **400**: its contract does not know the kind.
- `GET` and `POST /service-addons/:id`, `/activate` and `/deactivate` answer **500** for
  an `ADD_DEVICES` id.
- The price preview (Web Admin, Discounts) answers **500** for an `ADD_DEVICES` add-on id.

Nothing a customer sees is affected. The old bot lists add-ons filtered to its own two
kinds, so extra traffic and extra time are offered as before. A `dv:` or `dq:` button tap
reaches no handler there and gets the ordinary "unsupported" answer. Orders, operations
and commercial actions of kind `ADD_DEVICES` cannot exist yet: no provider declares
`DEVICE_LIMIT_ADJUSTMENT`, so nothing of that kind can be drafted, let alone paid for. The
release that first declares the capability must add its own note here. The old
provisioner abandons an operation type it does not know, and it does not refund it.

**During the update itself** the same failures can meet the new Web Admin page, if one
of its requests reaches an old API replica. They last only as long as old and new
replicas both run, and a reload after the update answers them.

**Before rolling back past WP-A5**, delete the extra-users rates. Withdrawing a rate is
not enough, because the old release reads inactive rows too. Nothing references a rate
yet, so the delete removes nothing else. If the database refuses it with a
foreign-key error, something does reference a rate; stop and do not roll back. First
save the rates so you can re-enter them after the roll-forward:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT id, title, status, price_amount, price_currency, max_quantity, panel_id, product_id
     FROM service_addons WHERE kind = 'ADD_DEVICES'"
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "DELETE FROM service_addons WHERE kind = 'ADD_DEVICES'"
```

Roll back when this count is 0:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT count(*) FROM service_addons WHERE kind = 'ADD_DEVICES'"
```

**If you already rolled back** with such a row present, roll forward. The release that
knows the kind reads it again, and nothing was written wrongly in between: every failure
above is a refused read.

### What a rollback strands: service location change (WP-A6)

WP-A6 adds the `CHANGE_LOCATION` order purpose, operation type and commercial-action kind,
two tables (`service_locations`, `service_location_changes`) and two service columns
(`location_key`, `location_label`). None of those can hold anything the release before
WP-A6 must read:

- The two tables are read by nothing in the older release. Locations an operator saved on
  the Web Admin's «تغییر لوکیشن» page simply stop being shown, and come back on the
  roll-forward.
- No `CHANGE_LOCATION` order, operation, commercial action or change request can exist
  yet, and no service can have a recorded location: no provider declares
  `LOCATION_CHANGE`, so a move is refused before anything is written. The release that
  first declares the capability must add its own note here — the older provisioner
  abandons an operation type it does not know, and does not refund it.

What CAN exist is the purpose's name in three operator-edited lists, because
`CHANGE_LOCATION` is discountable and reseller-grantable like every other commercial
action:

- a discount rule or a cashback rule whose «applies to» includes «تغییر لوکیشن»;
- a reseller tier grant whose operation is «تغییر لوکیشن».

The older release's pricing engine and entitlement check read those rows correctly — a
purpose they do not know simply never matches. But its **Web Admin** parses the list
responses with its own purpose vocabulary, so the Discounts, Cashback and reseller Tiers
pages fail to load while any such row exists. Nothing a customer sees is affected: the
older bot never offers a location change, and an `lc:`, `lt:` or `lf:` tap gets the
ordinary "unsupported" answer.

**Before rolling back past WP-A6**, untick «تغییر لوکیشن» on every discount and cashback
rule that names it, and remove it from every reseller tier's grants, in the Web Admin. No
sale of that purpose can have been made, so nothing a rule already priced changes. Roll
back when all three counts are 0:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT (SELECT count(*) FROM discounts WHERE 'CHANGE_LOCATION' = ANY(applies_to)) AS discounts,
          (SELECT count(*) FROM cashback_rules WHERE 'CHANGE_LOCATION' = ANY(applies_to)) AS cashback,
          (SELECT count(*) FROM reseller_tier_grants
            WHERE kind = 'OPERATION' AND subject = 'CHANGE_LOCATION') AS grants"
```

**If you already rolled back** with such a row present, roll forward: the release that
knows the purpose shows those pages again, and nothing was written wrongly in between.

### What a rollback strands: panel policies (WP-A8)

WP-A8 adds `panel_policies`: one row per panel an operator configured on the panel's
«قابلیت‌ها» tab — which customer actions that panel offers, the extra cooldowns and
per-purchase caps it adds, and whether its services are delivered with or without the QR
image. The release before WP-A8 neither reads nor writes the table, so nothing fails
there: every restriction simply stops applying.

- Every customer action switched off on a panel is offered again, wherever the adapter
  supports it and the tenant's own switches allow it: renewal, extra traffic, extra time,
  a customer's own suspend and resume, link rotation, subscription files and the usage
  refresh.
- A panel's longer cooldown for rotation or refresh falls back to the tenant's
  `services.link_rotation_cooldown_hours` and the built-in one-minute refresh interval.
- The per-purchase traffic and time caps and the device-limit ceiling vanish: every
  package the catalogue offers is offered on every panel again.
- A panel set to deliver the card as text sends the QR card again.

Nothing else is affected. The `panels.technical.view` rows the migration added to the
`owner` roles are skipped by the old release, which ignores a permission key it does not
know (`DrizzleRoleRepository`). `panel.policy_update` audit rows are ordinary audit rows.
Operator actions and the provisioner never read a policy, so no paid order changes course.

**During the update itself** the new Web Admin can meet an old API replica: its
Capabilities tab and the diagnostics card on the Health tab answer an error, and the
provider catalogue and the new-panel form refuse the old `/providers` answer, which has no
capability registry. They last only as long as old and new replicas both run, and a reload
after the update answers them.

**Before rolling back past WP-A8**, read the policies you would lose:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT p.name, pp.revision, pp.policy FROM panel_policies pp
     JOIN panels p ON p.tenant_id = pp.tenant_id AND p.id = pp.panel_id"
```

For any restriction that must hold while the old release runs, use the old release's own
tenant-wide control: switch the `customer_link_rotation` flag off, or deactivate the
add-on packages that must not be sold. Renewal, a customer's suspend and resume,
subscription files and the refresh have no tenant-wide switch there, and are offered
again until the roll-forward.

**If you already rolled back**, roll forward. The rows were never touched by the old
release, and every policy applies again as soon as the new release reads it.

### What a rollback delays or drops: support tickets (WP-A7)

WP-A7 adds support tickets: a customer opens and answers them in the bot, and support
answers in the Web Admin (Tickets). The release before WP-A7 has none of this. Its schema
checks already accept every new value, because the migration stays, and nothing in it
crashes on WP-A7's rows. Five things behave differently while it runs:

- **A message typed into an open ticket prompt is lost.** A ticket prompt is a text
  capture with purpose `TICKET_NEW_MESSAGE` or `TICKET_REPLY`. The old bot does not know
  either purpose, so it treats the capture as a service note: it closes the capture as read
  and passes the category's or the ticket's id to the note write as a service id. No service
  has that id, so nothing is written, and the customer is told «این سرویس در دسترس شما
  نیست.». No ticket message is filed and no service note changes. The customer has to send
  the message again after the roll-forward. A photo or document sent to a ticket prompt
  goes to the old bot's receipt path, as any file did before WP-A7. A prompt lasts ten
  minutes (`CUSTOMER_TEXT_CAPTURE_TTL_MS`), so only a prompt opened in the ten minutes
  before the rollback is affected.
- **The desk's buttons do nothing useful.** The old bot has no «🎫 پشتیبانی / تیکت‌ها»
  row and no `/tickets` command. A ticket button on an older message (`tkl:`, `tkn:`,
  `tkc:`, `tkv:`, `tkr:`, `tkq:`, `tkx:`) is a callback it does not know, and it answers
  `bot.unknown_command`.
- **A reply support wrote and the bot has not delivered yet waits.** The old dispatcher
  has no template for the `TICKET_REPLY` kind. It puts such a row back on the ordinary
  back-off, without spending an attempt or stamping it, and the first pass after the
  roll-forward delivers it. The reply itself is on the ticket either way.
- **Support is not told about a ticket or reply that is still in the outbox.** A
  `TicketOpened` or `TicketMessagePosted` event that the old relay reaches has no
  consumer there, so it is marked published. A support alert already queued has an
  `ops.support.*` template the old dispatcher does not declare. It is failed permanently
  (`notification.render_failed`) and not delivered, the same as the financial log's rows
  above. Its kind is `OPERATIONAL_EVENT`, so the old notifications page still lists it.
  The ticket is still in the Web Admin after the roll-forward.
- **Existing tickets are kept but out of reach.** The old release never reads or writes
  the ticket tables, and its Web Admin has no Tickets page. It skips the five `tickets.*`
  permissions granted to roles, so no role or permission page breaks. Everything comes
  back with the roll-forward.

No flag switches the ticket desk off. **Before rolling back past WP-A7**, hide every
ticket category in the Web Admin (Tickets → categories). New tickets can no longer be
started, although a customer can still open a reply prompt on an open ticket. Then wait
until no ticket prompt is open:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT count(*) FROM customer_text_captures
    WHERE purpose IN ('TICKET_NEW_MESSAGE', 'TICKET_REPLY')
      AND closed_at IS NULL AND expires_at > now()"
```

Roll back when that count is 0. Every open prompt has expired ten minutes after the last
one was opened. Show the categories again after the roll-forward.

**If you already rolled back** with a prompt open, roll forward. At worst each open prompt
cost the customer one message, answered with the sentence above. Nothing was written
wrongly in either release. Replies still waiting are delivered by the release that knows
their kind.

### What a rollback stops: the operations log group (WP-A4)

WP-A4 connects the operations log group by a one-time code, keeps the group and the
topics Nexa created in `ops_log_groups` and `ops_log_topics`, and routes every
operational event to a topic instead of filtering by severity. The release before WP-A4
has none of this. The migration stays and its tables are untouched; the old release never
reads them. While it runs:

- **New reports stop unless the manual chat id is set.** The old lane finds its
  destination in `ops.notifications.telegram_chat_id` only. On an installation that
  connected a group and never set that key, nothing new is queued. The operational events
  are still recorded, and the Web Admin's alerts page still shows them.
- **Severity filtering returns.** The old projector reads `ops.notifications.min_severity`
  again (default `ERROR`), so INFO and WARN events are no longer queued.
- **Reports already queued go to where the group was when they were queued.** The old
  dispatcher ignores the stored `opsTopic` and posts to the chat and topic snapshot on the
  row, from the tenant's active bot. A topic deleted since, or a group whose bot is not the
  tenant's first active bot, fails the message permanently. Nothing is deleted: after the
  roll-forward, «ارسال مجدد گزارش‌های ارسال‌نشده» on the ops group page queues it again.
- **The group cannot be connected or checked.** The old bot treats `/start ops-…` in a
  group as an ordinary contact and `/connect_ops` as an unknown command, and it ignores
  `my_chat_member`. A code issued before the rollback may expire unused; issue a new one
  after the roll-forward.
- **The old Web Admin shows the manual keys again** on the settings page, and has no ops
  group page. An `OpsLogGroupChanged` event still in the outbox has no consumer there and
  is marked published.

**Before rolling back past WP-A4**, if reports must keep reaching the group, put its chat
id in the manual setting. The chat id is not shown in the Web Admin; read it from the
database:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT chat_id FROM ops_log_groups WHERE status = 'CONNECTED'"
```

Then save that value as the group's chat id under «پیشرفته: مقصد دستی» on the ops group
page. It is used only while no group is connected, so leaving it set after the
roll-forward changes nothing. Topics are not carried over: the manual destination posts
to the group itself unless you also set a topic id.

### What a rollback delays or drops: reminders (WP-A9)

WP-A9 adds two expiry reminder slots (the week-out warning and the day of expiry), a
wallet low-balance alert, one reminder before a card-to-card payment or an unpaid order
lapses, and a send-time re-check of every reminder. The release before WP-A9 has none of
this. The migration stays: its new table (`wallet_threshold_alerts`) is never read by the
old release, and the widened CHECK constraints accept everything either release writes.
While it runs:

- **The five new kinds wait.** A `SERVICE_EXPIRY_EARLY`, `SERVICE_EXPIRY_DAY`,
  `WALLET_LOW_BALANCE`, `PAYMENT_PENDING_REMINDER` or `ORDER_PENDING_REMINDER` row still
  `PENDING` has no template in the old dispatcher, which defers it without spending an
  attempt. After the roll-forward it is re-checked before it is sent, so a payment that
  closed or a wallet that was topped up in the meantime is superseded, not announced late.
- **No new reminder of those kinds is raised**, and the reminders page is gone from the
  Web Admin. The old release's own expiry and usage reminders keep running.
- **The old defaults return** for a tenant that never stored a value: usage warnings at
  80/95/100 percent used instead of 80/90/95. A service already warned at 95 percent by
  WP-A9 has its final slot recorded for that period, so it is not told again at 100.
- **The old dispatcher does not re-check the six older reminder kinds**, so a reminder
  queued before a renewal can be sent after it, as it could before WP-A9.
- **The new settings and flags are kept but ignored.** The old release resolves only the
  keys it declares, so `reminders.expiry_early_days`, `reminders.payment_pending_minutes`,
  `wallet.low_balance.threshold` and the three new flags are untouched and come back with
  the roll-forward.

Nothing needs doing before rolling back past WP-A9. After the roll-forward, a wallet that
fell below its threshold during the rollback is told on the first low-balance pass, once.

### What a rollback can make unreadable: the location-change switch (HF-A6A8)

HF-A6A8 adds one entry to a panel's policy, `LOCATION_CHANGE` — the «تغییر لوکیشن سرویس»
switch on the panel's «قابلیت‌ها» tab. No migration: it lives in the existing
`panel_policies.policy` JSON. The release before it parses that JSON with a strict schema
that has no such entry, so a stored policy naming it reads there as UNREADABLE, and an
unreadable policy refuses every customer action on its panel until it is saved again.

In this release that row cannot be written through the product. The write path accepts the
entry only for a panel whose adapter implements AND declares `LOCATION_CHANGE`, and no
provider declares it (`docs/provider-capability-audit.md`). So nothing is expected to need
doing. **Before rolling back past HF-A6A8**, confirm it:

```bash
docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres psql -U nexa -d nexa -c \
  "SELECT panel_id, revision FROM panel_policies WHERE policy->'actions' ? 'LOCATION_CHANGE'"
```

If a row is listed, save that panel's policy without the switch before rolling back, or,
after the rollback, save the policy once from the old Web Admin, which writes it without
the entry.

### What a rollback hides: client app pictures (HF-A10)

HF-A10 lets an operator attach a PNG or JPEG picture to a client app entry. The bot
sends it ahead of that app's screen. The migration adds seven nullable `image_*`
columns and one CHECK to `client_apps`. The release before HF-A10 names its columns
explicitly and never reads or writes these, and its inserts leave them NULL, which
the CHECK accepts. While it runs:

- **No picture is sent.** Every app screen is the emoji-and-text screen it was
  before HF-A10.
- **The old Web Admin cannot show, upload or remove a picture.** An edit, a switch
  on or off, or a delete there leaves a stored picture as it was. A delete removes
  the picture with its row, as it does on either release.

Nothing needs doing before rolling back past HF-A10. After the roll-forward, every
picture that was not deleted with its entry is sent again.

### What a rollback keeps waiting: the durable operations log (HF-A4)

HF-A4 makes every event routed to the operations log durable: it is queued even while no
group is connected (with no chat on its destination, only its topic), a refusal that is
about the group rather than the message is retried rather than failed, a Telegram 429 is
not counted against the ten attempts, and a message that spends its attempts against a
healthy group asks for the group to be checked again, which requeues it once the check
passes. There is no migration. The release before it, while it runs:

- **Drops what is raised while no group and no manual chat exist**, as it did before, and
  counts every 429 as a failed attempt.
- **Files a queued message with no chat as FAILED** on its first claim ("The stored
  destination is not valid"), without sending anything. That keeps it: nothing deletes a
  notification. After the roll-forward, the next check that finds the group healthy, or
  «ارسال مجدد گزارش‌های ارسال‌نشده», queues it again.
- **Reads a raised `max_attempts`** on a message that met 429s as an ordinary larger
  allowance, which it honours.

Nothing needs doing before rolling back past HF-A4.

### What a rollback delays: support's files on ticket replies (HF-A7)

HF-A7 lets support attach an image or an allowed document to a ticket reply in the Web
Admin. The file is kept in `ticket_reply_files` until Telegram accepts it and is sent as its
own `TICKET_REPLY_ATTACHMENT` notification beside the reply's text. The release before HF-A7
has none of this. The migration stays: the old release never reads the new table, and the
widened notification CHECK accepts everything either release writes. While it runs:

- **A file not yet delivered waits.** The old dispatcher has no template for
  `TICKET_REPLY_ATTACHMENT`. It defers the row without spending an attempt or stamping it,
  and the first pass after the roll-forward sends it. The reply's TEXT is an ordinary
  `TICKET_REPLY` and is delivered by the old release as before.
- **Support cannot attach a file.** The old Web Admin has no file picker, and the old API
  does not read the `attachment` field of a reply. A reply sent through the old Web Admin is
  text only.
- **The old Web Admin does not show support's files** on the conversation. The reply's text
  is shown; the file row is kept and appears again after the roll-forward.
- **Undelivered bytes are not cleared.** The old worker has no retention sweep for the new
  table. Nothing new can be staged while the old release runs, so what is held stays at or
  below the 100 MB per-tenant bound, and the new release's sweep clears it after the
  roll-forward.

Nothing needs doing before rolling back past HF-A7.

### What a rollback delays or loses: edit-in-place wizards and the renewal result (R2)

R2 edits the customer's purchase and top-up wizard in place, edits an administrator's
receipt-review message into its decision, has the gateway worker edit the invoice message
the moment the invoice is ready, and ends a renewal with its own `SERVICE_RENEWED` result.
Its migration adds two tables (`telegram_wizards`, `telegram_review_messages`) and widens the
notification kind CHECK. The migration stays: the old release never reads the new tables,
and the widened CHECK accepts everything either release writes. While it runs:

- **Every step is a new message again**, as before R2. A wizard message the new release left
  on screen still works: its buttons are ordinary callbacks the old release answers with a
  new message. Nothing is edited; nothing is refused as stale.
- **A ready gateway invoice waits for «🔄 بررسی وضعیت پرداخت».** The old worker does not
  edit the loading screen; the invoice itself is created and settled exactly as before.
- **A renewal result not yet sent waits.** The old dispatcher has no template for
  `SERVICE_RENEWED`: it defers the row without spending an attempt or stamping it, and the
  first pass after the roll-forward sends it. A renewal that succeeds DURING the rollback is
  announced by the old release with the generic `SERVICE_ACTION_SUCCEEDED`, as before.
- **A receipt decision taken in the old release does not edit the review message**; the
  decision itself is unchanged. The rows the new release recorded are kept and ignored.

Nothing needs doing before rolling back past R2.

Three notes on R2 itself, for whoever operates or extends it:

- **`SERVICE_RENEWED` carries no payload** (ADR 0030 §1). The announcer enqueues the kind and
  the RENEW operation's id; `DrizzleRenewalFactsReader` reads the account name, the duration,
  the new expiry and the tracking code at send time from that operation, its order, its
  service and the confirmed payment — the shape `TICKET_REPLY` and `TICKET_REPLY_ATTACHMENT`
  already use (`docs/wp-a7-tickets-audit.md` §2). A read that finds no succeeded renewal
  sends nothing.
- **`telegram_wizards` and `telegram_review_messages` are not pruned yet.** Each tracked
  message keeps its row; a retention sweep is a known limitation, not yet built.
- **The state writes take no idempotency key of their own.** Each is one conditional
  statement naming what it moves from: a claim names the step, the lease and, for a
  redelivery, the update's key; a landing names the claim's version; a review stamp names
  an unstamped row. So a replayed update either passes the gate again by its own key and
  repeats writes that are idempotent by that key, or matches nothing. That is safe because
  the rows are presentation only: the order, payment and capture writes behind a tap keep
  their own idempotency keys, and the worst a replay can do here is answer a tap as stale
  or show the same screen again.

### What a rollback delays or drops: reminder quiet hours (HF-A9)

HF-A9 holds a reminder that falls due inside the tenant's quiet window until the window
ends, by moving its queued row's `next_attempt_at` there. It has no migration: the flag
and the two settings are ordinary rows, and a held reminder is an ordinary `PENDING` row.
While the release before it runs:

- **A reminder already held still waits for the window's end.** The old dispatcher claims
  nothing before `next_attempt_at`, so it sends the held row then, re-checked as it always
  is — once, not early.
- **A reminder that falls due during the rollback is not held**: the old release has no
  quiet hours, so it is sent when it is due, night or not.
- **The flag and the two times are kept but ignored**, and come back with the roll-forward.

Nothing needs doing before rolling back past HF-A9.

### What a rollback changes back: the service card and connection files (R3)

R3's migration `0141_r3_operation_card_messages` adds one table, `operation_card_messages`
(the chat and message a customer's disable or enable was tapped from, and a 429's wait),
and one nullable column, `services.usage_refresh_started_at` (the refresh button's
reservation). The release before it reads neither: a reservation left set by a rollback
mid-read is taken over as dead after three panel timeouts. While that release runs:

- **A disable or enable planned by R3 and performed by the old release** is answered the
  old way — the lane's «درخواست شما با موفقیت روی سرور اعمال شد» — and the card is not
  edited. Its row stays unanswered; nothing reads it until the roll-forward, whose sweep
  may then edit that card to the state it is in by then (the card shows the truth either
  way).
- **The refresh button queues a `SYNC_USAGE` again** and answers «request registered»,
  and link changes and disables send their old intermediate messages.
- **A purchase's connection files are no longer sent automatically**, and a link change
  is announced with the purchase card again. The manual «📁 دریافت فایل‌های اتصال» still
  works, with the panel's own caption.

Nothing needs doing before rolling back past R3.

### What a rollback changes: per-panel trials and the bot's buttons (R1)

R1 configures the free trial per panel (`panel_trial_configs`) and issues it from no
product; it marks trial services `is_trial`; and it lets an operator arrange and relabel
the main-menu keyboard on «دکمه‌های ربات» (`bot.main_menu` and the `bot.menu.*` texts).
Migration `0142_r1_trial_per_panel_and_main_menu` only adds: a table, two nullable columns, a widened CHECK, a
`trial_grants.product_id` that may be null, and trigger bodies that accept everything
the previous release writes. While the release before R1 runs:

- **Its trial reads `trial.product_id` again.** The migration copied that product's panel,
  traffic and duration onto the panel's trial once and left the setting stored, so a
  tenant that had a trial product is offered it again from the product, as before R1; a
  tenant whose trial was set up only on a panel is offered none. Nothing is lost: the
  per-panel rows come back into force with the roll-forward.
- **A trial issued by R1 and not yet provisioned** is provisioned from its day count —
  its hours rounded UP to whole days — because the old provisioner does not know
  `line_duration_hours`. A 72-hour trial is exactly 3 days; a 12-hour one gets a day.
- **Services are still marked**: the trigger sets `is_trial` from the creating order on
  every insert, the old release's included.
- **The keyboard reverts to the shared default of that release** — its six buttons, in
  their fixed order and labels. The arrangement and the relabelled `bot.menu.*` texts are
  kept and come back with the roll-forward. A customer tapping, on a keyboard R1 drew, a
  relabelled button or the trial or referral button (which that release does not have) is
  answered as unknown text until then; the next reply redraws the old keyboard.
- **The panel trial tab and «دکمه‌های ربات» are gone from the old Web Admin**; the
  configuration they wrote is kept.

Nothing needs doing before rolling back past R1.

### What a rollback changes back: albums, panel captions and the same-card answers (round N, F2 + F4)

Round N's service UX (`docs/n-service-ux-audit.md`) has **no migration**: it reuses R3's
`operation_card_messages` and adds only code and template keys. While the release before it
runs:

- **Connection files go one document each again**, with the username caption R3 wrote,
  instead of an album with the panel's own captions.
- **A card a round-N tap turned «working»** stays «working» until it is answered or drawn
  again. The old release answers a SUCCEEDED disable or enable on it as before; a FAILED one
  it tells by message (the card stays «working» until the customer taps «♻️ بروزرسانی
  اطلاعات» or opens the service again, which draws it as it is); a link change is announced
  as a new message, as in R3. A failure round N had already stamped as answered on the card
  is not told again by the old release.
- **«🔗 لینک اشتراک» sends the delivery card again**, and the renew, add-traffic, note,
  refund, transfer and location screens arrive as new messages; their «back» buttons (`sv:`)
  are understood by that release and draw the card in place.

Nothing needs doing before rolling back past round N's service UX.

### What a rollback changes: reseller overrides and the monthly minimum (round N, package D)

Package D lets an operator override a tier's entitlements for one reseller, set a monthly
minimum sales figure on a tier or a reseller, and tell a reseller about it
(`docs/round-n-reseller-audit.md`). Migration `0145_round_n_reseller_controls` only adds:
three tables, two nullable column pairs and a widened notification-kind CHECK. While the
release before package D runs:

- **Every reseller is judged by their tier's grants again.** The old release does not read
  `reseller_entitlement_overrides`, so a reseller an override NARROWED can again buy what
  the tier allows, and one it WIDENED is refused what only the override allowed — at the
  catalogue and at confirmation alike, since both read the same grants. If a narrowing
  override exists for a reason that must hold during the rollback (a Product a reseller must
  not sell), put it in the tier or suspend the reseller before rolling back. The overrides
  are kept and come back into force with the roll-forward.
- **The two monthly-minimum kinds wait.** A `RESELLER_MINIMUM_REMINDER` or
  `RESELLER_MINIMUM_ACHIEVED` row still `PENDING` has no template in the old dispatcher,
  which defers it without spending an attempt; after the roll-forward the reminder is
  re-checked before it is sent, so a reseller who reached the minimum meanwhile is not
  told they are behind.
- **No notice is raised and the progress page is gone.** The minimums, the flags and
  `reminders.reseller_minimum_days` are kept but ignored. The minimum never had a
  consequence, so nothing about money, status or tiers differs.

Nothing needs doing before rolling back past package D unless a narrowing override must
keep holding (above).

### What an update and a rollback change: reseller credit removed (owner decision, 2026-10-01)

The owner removed reseller credit: no reseller debt, no negative balance from a purchase
and no credit purchase (`docs/reseller-phase3-closure.md` §5, §6). Migration
`0155_reseller_credit_removed` changes data once and adds nothing:

- **It sets limits to zero.** Every `reseller_tiers.credit_limit_amount` becomes 0, and
  every `resellers` own limit becomes NULL, which inherits the tier's 0.
- **It records the old values first.** Each non-zero value is written as an audit row on
  its tier or customer (correlation `migration-0155-reseller-credit-removed`), so the Web
  Admin's change history shows what it was. The pre-update backup holds it too.
- **Nothing restores a limit; that is deliberate.**

Why the migration and not only the code:

- An update migrates **before** the new release starts.
- While a replica of the previous release is still serving, it computes the allowance
  from the stored limits. After the migration it reads zero, so no purchase it settles can
  go below zero.
- One residual case remains. An operator typing a positive limit into the OLD form during
  that window would store one, which the new release ignores. The next tier save writes
  zero over it, and the next reseller save writes null.

While the previous release runs after a rollback:

- **Still no credit.** The rolled-back code reads the zeroed limits, so it extends no
  credit.
- **Its forms show a limit field again.** Leave it at zero. A positive value typed there
  would be credit again for as long as the rollback lasts, and the roll-forward refuses to
  keep it (the next tier save writes zero, the next reseller save writes null).
- **Balances are untouched.** A balance already below zero (a debt from before the
  decision) stays exactly as it is. Neither release collects it.

Nothing needs doing before rolling back past this change, except not re-entering a limit.

### What a rollback changes: the trial switch, the catalogue and the wallet (F5)

F5 retires the tenant-wide `trials` feature flag: a trial is offered exactly when a panel
has its own trial enabled (the panel's «سرویس تست» tab), and the Features page no longer
shows a trial switch. The catalogue no longer draws a trial button — the trial is its own
main-menu button, drawn only while at least one panel offers a trial — and the wallet no
longer draws the referral button, which stays on its own main-menu button.

Migration `0144_f5_trial_flag_retired` changes data once and adds nothing: every panel
trial of a tenant whose `trials` switch was OFF (or never set, which was off) is switched
off, with its revision moved on. A tenant whose switch was on keeps every panel as it was.
So no tenant starts offering a trial it was not offering before the upgrade. Traffic, hours
and the label are kept; re-enabling a panel offers what it was configured with. The
`feature_flag_states` rows for `trials` are left in place, unread by F5.

While the release before F5 runs:

- **The switch is read again, from where it was left.** A tenant whose switch was on
  behaves exactly as under F5. A tenant whose switch was off offers no trial even on a
  panel an operator enabled after the upgrade; to offer it during the rollback, turn
  «سرویس آزمایشی رایگان» on on that release's Features page — the panels decide the rest,
  as they do under F5.
- **A trial withdrawn during the rollback must be withdrawn on the panel.** F5 does not read
  the switch, so a trial switched off with it on the old release comes back with the
  roll-forward. Switch the panel's trial off on its «سرویس تست» tab — that release has
  the tab — and it stays off in both.
- **The catalogue's trial button and the wallet's referral button come back**; both callbacks
  are still answered by F5, so a message the old release drew keeps working after the
  roll-forward.

Nothing needs doing before rolling back past F5.

### What a rollback changes back: the review record and the gateway invoice ends (round N, F1 + F3)

Neither package has a migration: nothing new is stored but machine codes in columns that
already held free text, and nothing is removed. While the release before them runs:

- **A receipt decided then is finalised into the one-line outcome again** (✅ پرداخت تأیید
  شد …), not the complete record, and a tap on a finalised review message is acknowledged
  without its notice. Messages finalised by the newer release keep the record they show.
- **A gateway create's `creation_error_code` keeps the longer codes** the newer adapter
  wrote (`http.403.unreadable.html`, `http.network.ENOTFOUND`, …); the older Web Admin shows
  them as text, and the older adapter writes its shorter ones again.
- **A created invoice without a payable link** (`creation_error_code =
nexa.no_payment_link`) is shown by the older release as «پاسخ درگاه … دریافت نشد», and
  its retry hands the same attempt back until the attempt's deadline, as before this round.
- **A create answered with metadata in an undocumented shape** (a numeric invoice id, a
  null or decimal amount) is UNKNOWN again under the older adapter. An invoice the newer
  release already recorded as CREATED stays CREATED and is asked about as before.

Nothing needs doing before rolling back past round N's payments package.

### What a rollback delays: broadcasts and mass operations (round N, B1/B2)

Round N adds «ارسال همگانی» (broadcasts), «عملیات گروهی» (mass wallet credit and mass
traffic/time grants) and the shared audience they are selected by
(`docs/round-n-broadcast-audit.md`). Migration `0146_round_n_broadcast` only adds: new tables, an index on `trial_grants`, a widened
notification-kind CHECK, and role rows for three new permissions. The release before them
never reads the new tables. While it runs:

- **A broadcast that is sending stops, and nothing is lost.** The old worker has no
  broadcast dispatcher, so every recipient still `PENDING` waits. A send stamped at the
  moment the new worker stopped was either recorded (the worker's shutdown waits for the pass
  in flight) or is resolved `UNCONFIRMED` by the reaper after the roll-forward and is never
  sent twice. A `SCHEDULED` broadcast whose time passes during the rollback starts, late,
  on the roll-forward; cancel it first if late is wrong.
- **A mass operation stops between items, never inside one.** Each item is one
  transaction, so an item is either wholly credited (or planned) or untouched. Items still
  `PENDING` wait. Traffic/time operations already planned are ordinary `ADD_TRAFFIC` /
  `ADD_TIME` provisioning operations with no order, which the previous provisioner executes
  and reconciles as it does a free location change; their bulk items are settled from the
  operation's state after the roll-forward. This was exercised against this release's
  provisioner only.
- **The two new notices wait.** `WALLET_MASS_CREDITED` and `SERVICE_GIFT_APPLIED` have no
  template in the old dispatcher, which defers them without spending an attempt; they are
  delivered after the roll-forward.
- **Staged broadcast media is kept.** The old worker has no retention sweep for it; nothing
  new can be staged while it runs, so what is held stays within the 200 MB per-tenant bound
  and is cleared by the new sweep after the roll-forward.
- **The pages are gone from the old Web Admin** and the new permissions are charged by
  nothing; the role rows stay and apply again with the roll-forward.

Nothing needs doing before rolling back past round N. Pausing a broadcast that is sending is
the courteous step, so its report says «متوقف‌شده» rather than «در حال ارسال» while the old
release runs.

### What a rollback leaves running: campaigns (round N, C1)

Round N's campaigns (`docs/round-n-campaigns-audit.md`) add two tables, `campaigns` and
`campaign_actions` (migration `0147_round_n_campaigns`), and backfill `campaigns.view` and
`campaigns.manage` into the owner, observer and sales roles (`0148`). Both only add. A
campaign owns no price, credit or send of its own: what it made lives in the engines it
composed. So while a release without campaigns runs:

- **A campaign's discount and cashback keep applying on their own window.** They are
  ordinary rows in `discounts` and `cashback_rules`, windowed to the campaign, and the old
  pricing engine reads them like any other rule. To stop one during the rollback,
  deactivate it on the discounts page; the campaign page resumes managing it after the
  roll-forward (a resume re-activates it).
- **Its gifts and its announcement are the Broadcast and mass-operation rows** the
  round-N release created; what a rollback does to those is the section above.
- **No campaign changes state.** The worker lane that marks a campaign ACTIVE at its start
  and COMPLETED at its end is not in the old release, so the Web Admin shows a stale state
  after the roll-forward until the first tick (a minute) catches up — one tick moves a
  campaign whose whole window passed straight to COMPLETED. Nothing financial depends on
  that lane.
- **The Campaigns page is gone from the old Web Admin**; the old release skips the two
  permission keys, so no role page breaks.

Nothing needs doing before rolling back past C1.

### What a rollback sends, leaves paused and cannot list: round N close

Round N close (`docs/round-n-close-audit.md`) adds frozen audiences, a PAUSED state on
mass operations, FORWARD/COPY broadcasts with a per-recipient pin, a broadcast purpose and
the customers' promotional opt-out (migration `0152_round_n_close`, expand-only: two tables
— `frozen_audiences` with its `grant_kind` — and new nullable or defaulted columns; the
CHECKs on `content_kind` and `state` are widened, never narrowed). While the release before it runs on this schema:

- **Opted-out customers receive MARKETING broadcasts again.** The old dispatcher reads
  neither `purpose` nor `marketing_opt_out_at`; a broadcast it materialises or sends goes to
  the whole audience, and `/stop` is answered as an unknown command. Recipients already
  written SKIPPED stay skipped. If that is not acceptable, pause every SENDING broadcast
  before rolling back and leave scheduled ones cancelled.
- **A FORWARD or COPY broadcast that is sending FAILS its remaining recipients**, one by
  one: the old transport has no method for those kinds and records
  `broadcast.media_unavailable` after the stamp. Nothing is sent twice and nothing wrong is
  sent; after the roll-forward «تلاش دوباره برای ناموفق‌ها» re-queues them. Pause such a
  broadcast first. **The old Web Admin's broadcasts list refuses to render while a
  FORWARD or COPY broadcast is among the rows on the page** — its response schema does not
  know the kinds — so an operator who must roll back with one present reads the list through
  the API or after it has paged past.
- **A PAUSED mass operation stays paused** — the old claim query names RUNNING — and cannot
  be resumed from the old release, whose page also refuses to render an operation in a state
  its schema does not know. Resume, or cancel, every paused operation before rolling back.
- **Pins are not attempted** by the old dispatcher; a pin stamped PENDING by the new one is
  reaped UNCONFIRMED after the roll-forward. No pin is ever attempted twice.
- **Frozen audiences are ignored**: the old hand-over evaluates the definition live and
  refuses `audience.changed` on a moved set, as before; the old mass-action create ignores
  `frozenAudienceId`. Nothing releases member rows while the old release runs; the sweep
  resumes after the roll-forward. Header rows are never deleted by any release.

Before rolling back past round N close: pause sending FORWARD/COPY broadcasts, resume or
cancel paused mass operations, and know that opted-out customers are not excluded until the
roll-forward.

### What a rollback leaves as text: appearance markers (round P, Premium UI)

The Premium UI release puts `{icon:…}` markers into the DEFAULT bodies of about forty
customer templates and renders them at send time into an emoji (or a custom emoji
entity) through the messenger. The default bodies ship with the code, so a rollback
takes the markers away with the release that reads them; nothing in the database holds
one — except a tenant's own override, if an operator copied a marker into it.

- **An override carrying `{icon:…}` is sent literally by the old release.** The old
  renderer leaves an undeclared braced expression as written, so a customer reads
  `{icon:payment}`. Before rolling back, list them:

  ```bash
  docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
    exec -T postgres psql -U nexa -d nexa -c \
    "SELECT tenant_id, template_key FROM template_overrides WHERE body LIKE '%{icon:%'"
  ```

  and either revert those keys to the default from the texts page, or edit the marker
  into the emoji you want, before the rollback. The old release's editor refuses nothing
  here (it does not know the marker), so this is the operator's check.

- **The two new columns and the new table are ignored** by the old release:
  `bot_appearance_slots` and `bot_instances.custom_emoji_*` are additive, and nothing in
  it reads them. A later roll-forward finds every slot and every bot's verdict as they
  were.
- **Nothing was ever decorated by the old release**, so the customer-facing effect of a
  rollback is only the emoji returning to the literal ones the old bodies carried — and
  the literal marker in an override, above.

### What a rollback leaves queued: the command-menu sync (round P)

Round P (`docs/command-menu-audit.md`) adds one table, `bot_command_syncs` (migration
`0149_command_menu_sync`), and widens the `bot.main_menu` setting's entries with an optional
`target` and `appearanceSlot`. The Telegram command menu is now registered per bot by a
worker lane — after a description is reworded, a token replaced or a bot started — and
`bot_instances.commands_revision` keeps meaning what it meant: the digest of what Telegram
was last given. While the release before round P runs:

- **Telegram keeps whatever menu was last registered.** The old release registers the
  SHARED default descriptions again only when its own digest differs from the stored one,
  which it does exactly when a tenant had reworded a `bot.command.*` text under round P:
  `botctl update` / `rollback` then reconcile the menu back to the defaults. Nothing is
  lost — the override is a template row, and the lane re-registers it on the roll-forward.
- **The sync rows are left alone.** The old release neither reads nor writes
  `bot_command_syncs`; a row queued before the rollback is picked up by the lane after the
  roll-forward, with its back-off where it stood.
- **A `bot.main_menu` value saved by round P still parses** on the old release: the
  schema's `.strict()` refuses unknown keys, so an entry carrying `target` or
  `appearanceSlot` is REFUSED by the old schema and the setting resolver reports the stored
  value invalid — the keyboard falls back to the default arrangement (every button, its
  declared order) until the roll-forward, exactly as R1's rollback note describes for an
  unreadable value. The stored value is kept and comes back with the roll-forward. To keep
  an operator's order during the rollback, save the arrangement once on the old release's
  «دکمه‌های ربات» page.
- **The token replacement answers without `commandSync`**, and the bots page's STALE hint
  names `botctl telegram register` again.

Nothing needs doing before rolling back past round P.

### What a rollback leaves running: the central exchange rate (round P, package FX)

Package FX (`docs/fx-audit.md`) adds two tables, `fx_quotes` and `fx_source_states`, and
snapshot columns on `gateway_invoices` (migration `0150_round_p_fx`): a NOT NULL
`conversion_policy` with a default, backfilled from the rows the previous release wrote,
and nullable `fx_*` columns. It only adds, and the snapshot-guard trigger it widens still
freezes every column the previous release froze. So while a release without the package
runs:

- **Every invoice already issued keeps its snapshot.** The old release reads
  `conversion_rate_minor` and `sent_amount`, both unchanged, and never touches the new
  columns; a Stars attempt opened under the central rate carries `conversion_rate_minor
= NULL`, which the old code treats as a same-unit invoice for display only — the Star
  figure it asks Telegram for is `sent_amount`, already frozen, and pre-checkout compares
  against that.
- **New Stars attempts are priced by the fixed rate**, whatever `stars.pricing_mode`
  says: the old release does not read the mode, and every enabled Stars route has a rate
  because enabling has required one since Package A. The central rate is not consulted
  and cannot be. This is the one behaviour that silently changes across the rollback, and
  it is the conservative direction — the operator's own figure. The old release's INSERT
  carries the rate and no policy, so it arrives with the column's default beside a rate —
  the combination the snapshot CHECK refuses; a BEFORE INSERT trigger in 0150 infers
  `FIXED_RATE` for it, exactly as the backfill did for the rows already there. Without
  that trigger every Stars attempt on the old replica failed, during the rolling deploy
  as well as after a rollback (Codex review of #122, P1).
- **The refresh lane stops**, and `fx_quotes` goes stale. Nothing reads it in the old
  release. After the roll-forward the worker's first pass refreshes it within the TTL,
  and until then a central-rate attempt is refused, not priced by a stale quote past the
  limit.
- **The `central_fx` flag and the six `fx.*` / `stars.*` settings are stored rows the old
  release skips** (unknown keys are not read); the FX section is gone from the old Web
  Admin, and the old settings page draws no group for them.

Nothing needs doing before rolling back past package FX. Before rolling FORWARD again,
nothing either: the mode an operator set is still stored, and the first attempt after
the roll-forward prices by it — so an operator who switched to the central mode should
expect the fixed rate to have applied in between, and can read which policy each attempt
used on its invoice row.

### How far back you can roll

**One release**, safely. Migrations are expand-only within a release
(see below), so release N's schema runs release N−1's code. Rolling back
across more than one release is not promised and `botctl` does not pretend
otherwise.

## Migration compatibility

The rule that makes application rollback sound:

> **expand → deploy → contract**

- **Expand** — release N adds the column, table, index or constraint, nullable
  or defaulted.
- **Deploy** — release N's code writes both shapes and reads the new one.
- **Contract** — release N+1 or later removes the old shape, once no supported
  rollback target reads it.

A migration may add. It may not, in the same release, remove or narrow anything
the previous release still reads.

**This is now checked, for the current transition.**
`tests/integration/migration-compatibility.test.ts` migrates a scratch database
to the PREVIOUS release, runs the operations that release performs, applies this
release's migrations underneath it, and runs those operations again. A migration
that broke the previous release fails there rather than during somebody's
rollback. A second, cheaper check refuses `DROP COLUMN`, `DROP TABLE`,
`SET NOT NULL`, `DROP CONSTRAINT`, `DROP DEFAULT` and renames in the incoming
migrations.

Neither is a general proof for all future migrations — the replay exercises the
operations named in it, not every operation the previous release could perform.
It is evidence for this transition and a gate for the next one, which is more
than a documented rule and less than a mechanical guarantee.

**Indexes that must not lock the table they are built on are not migrations.**
Drizzle runs every pending migration inside one transaction, and PostgreSQL
refuses `CREATE INDEX CONCURRENTLY` there; an ordinary `CREATE INDEX` takes a
SHARE lock for the whole build, and a DDL statement waiting for that lock sits
at the head of the queue, so every operator write arriving behind it waits too.
Migrations run while the OUTGOING release is still serving, so that queue is an
operator's panel edits.

Such indexes are declared in
`apps/api/src/infrastructure/persistence/online-indexes.ts` and applied by
`runMigrations` after the migrator, on their own connection. The step is
idempotent — an index that is already valid costs one catalogue lookup — and it
recovers the state a cancelled build leaves behind: an index whose
`indisvalid` is false is dropped concurrently and rebuilt, rather than being
left to look healthy while the planner ignores it.

They are deliberately absent from `schema.ts`, so `pnpm db:check` cannot see
them. `tests/integration/online-indexes.test.ts` is what does: it asserts each
one exists and is valid after migrating, that a repeat run rebuilds nothing,
that an invalid one is repaired to the right definition, and that an operator
write is not queued behind the build.

There is no automated destructive schema rollback and there will not be one: a
down-migration that drops a column is a data-loss button beside a panic button.

One migration in this release can fail on an existing database rather than on
its own code. `0015_single_primary_tenant` adds a unique index that permits one
`PRIMARY` tenant, and it will not build on a database that already holds two —
a state provisioning cannot produce, but a hand-written `INSERT` can. It fails
loudly at migrate time with the index name, which is the correct outcome: the
operator decides which tenant is primary, not the migration. A development
database seeded before this release is the one place it will actually happen —
the old seed made both of its tenants `PRIMARY` — and there the answer is to
reseed, not to reconcile.

## Reboots

Every long-running service has `restart: unless-stopped`, so Docker brings the
installation back after a host reboot with no operator action and no systemd
unit. The one-shot that publishes the Web Admin bundle does **not** restart —
the volume it wrote still holds the activated release.

## The Web Admin bundle in the volume

Caddy is reading the asset volume while the incoming release writes into it, so
publishing is an activation rather than a copy. `deploy/bin/publish-web-assets.mjs`
runs once per `up`, from the release's own image, and leaves the volume in this
shape:

```
/srv/web/releases/<bundle-id>/     a complete published release
/srv/web/current -> releases/<id>  what Caddy serves index.html from
/srv/web/pool/assets/<file>        the union of the retained releases' assets
```

Four rules, and each closes a failure an operator would meet on a routine
update:

- **A release is written off to one side and activated by one `rename(2)`.**
  The shell one-shot this replaced cleared the served directory and then copied
  into it: every request in that window got a 404 for `index.html`, or an
  `index.html` naming assets that were not there yet. Nothing is ever activated
  half written, and a publication that fails leaves the previous release
  activated and untouched.
- **A release is named after its bundle's content.** Publishing the same bundle
  twice copies nothing — and a rollback IS publishing the same bundle twice, so
  `botctl rollback` re-activates a directory that is already on disk and
  complete.
- **`/assets/*` is served from the pool, not from the activated release.** A
  browser that fetched `index.html` a millisecond before a swap asks for its
  scripts a millisecond after it. The pool spans the retained releases, so both
  sides of a swap load. Two deployments later the older release is pruned along
  with its assets; `index.html` is `no-store`, so a reload resolves it.
- **One publisher mutates the volume at a time.** Publication is a sequence —
  read what is current, stage, fill the pool, swap, prune what the two retained
  releases do not own — and two publishers interleaving through it can each
  read the same previous release and have the loser's prune delete the winner's
  just-activated one. `current` then names a directory that is not there, which
  is a 404 for the whole Web Admin rather than a stale page. `.publish.lock` is
  a `mkdir(2)` lock over the whole sequence. A holder in this container that is
  no longer running is taken over at once; one in a container that is gone is
  waited out to two minutes, so a publisher killed by a host that went down
  costs an update that starts slowly rather than an installation that can never
  publish again.

Rolling back to a release older than this layout is safe in both directions:
that release's compose file and its publisher travel with its image, and its
own one-shot rewrites the volume flat. The reverse — the update that introduces
the layout — deliberately leaves the flat tree in place, because the Caddy
still running at that moment is the outgoing release's and is still serving out
of it. The publication after that removes it.

## Releases

A release is three facts that travel together:

- a **version** — the label humans use, `v1.2.3`
- a **source commit** — what it was built from
- an **image digest** — what actually runs

All three are stamped into the image at build time and are read **from the
image**. The installer does not write them into `/etc/nexa/nexa.env`: `env_file`
beats an image's own `ENV`, so anything written there would replace the
immutable values permanently. An earlier version wrote `pending` for the commit
and the build time, and `/health/info` then reported `pending` for the life of
the installation.

### What must be true before a release exists

Publication is gated. `release.yml` will not build until:

- the tag resolves to a commit, once, and every later job uses that **SHA**
  rather than re-resolving a mutable tag;
- a run of `.github/workflows/ci.yml` for **that exact SHA** completed with
  conclusion `success` — cancelled, skipped, stale and timed-out are not a pass;
- the version has **never been published**. A published version is immutable and
  there is no force-republish switch; the way to publish different bytes is a
  new version.

What the gate does **not** check is which ref that CI run belonged to. A commit
reachable from a pull-request branch and from the tag has one set of runs, and a
successful run recorded against the branch satisfies the gate. That is the
intent — the same bytes were tested — but it means the guarantee is "this SHA
passed CI", not "this SHA passed CI as a tag".

The image is built for `linux/amd64` and `linux/arm64` — every architecture the
installer accepts — and the published manifest is read back by digest and
checked for both before the release is considered done.

**A failed verification burns the version.** That read-back runs after the tag
is public, so a release that fails it is already installable, and the
immutability rule then makes that version unpublishable for ever. The recovery
is a version bump.

The digest is the identity. `latest` is never the installed identity, and
`botctl version` reports all three so an installation can be tied back to
source without trusting any single one of them.

Manifests live in `/var/lib/nexa/releases/<version>.json`. `current` and
`previous` name the active release and the rollback target.

## Secrets, keys and rotation

Stored secrets are envelope-encrypted: a fresh 256-bit data key per secret,
AES-256-GCM, and the data key wrapped by a key-encryption key from the keyring.

**The keyring.** One key encrypts, all configured keys decrypt.

```
SECRETS_KEYS=install-20260903:<base64>,rotate-20261101:<base64>
SECRETS_ACTIVE_KEY_ID=rotate-20261101
SECRETS_ACCEPT_V1=false
```

An installation made before the keyring has `SECRETS_KEK` and `SECRETS_KEK_ID`
instead. Those still work — they alias to a one-entry keyring — so adopting the
v2 envelope needs no reinstall and no hand-edit. They are the **legacy**
spelling, and converting them is `botctl secrets migrate-config`.

**Which spelling a host uses is load-bearing.** `botctl secrets status` prints
it, because it decides the default for `SECRETS_ACCEPT_V1` when nothing in
`nexa.env` sets it:

| Configuration              | Default v1 acceptance | Why                                                            |
| -------------------------- | --------------------- | -------------------------------------------------------------- |
| `SECRETS_KEYS` (canonical) | **off**               | only a keyring-era installer or `migrate-config` writes it     |
| `SECRETS_KEK` (legacy)     | on                    | only a pre-v2 installer writes it, and those hosts may hold v1 |

An explicit `SECRETS_ACCEPT_V1` always wins, in both directions. The default is
keyed this way rather than being a flat `true` because no host installed before
the setting existed has a line deciding it — so a flat default meant acceptance
was what happened when nobody chose, across the entire installed base.

**Converting a pre-keyring host.**

```bash
sudo botctl secrets migrate-config   # SECRETS_KEK -> SECRETS_KEYS, in place
sudo botctl restart                  # load it
sudo botctl secrets status           # confirm: configuration canonical
```

It moves the same key bytes under the same key id, atomically (written beside
the file and renamed over it, at the file's own mode and owner). It generates
nothing, re-encrypts nothing, touches no database row, restarts nothing, and
never prints, logs or passes key material through a command line. Rerunning it
on an already-converted host reports that and changes nothing.

**Turning v1 off.**

```bash
sudo botctl secrets shutdown-check   # may this installation stop reading v1?
sudo botctl secrets disable-v1       # only if the check passes
```

`shutdown-check` fails closed and names every blocker at once: any v1 row, any
envelope that is neither v1 nor v2, any row whose recorded key id disagrees with
its envelope, a legacy-spelled configuration, or an active key that is not in
the keyring. Each blocker names the command that clears it.

`disable-v1` runs that check first and refuses without it, then writes
`SECRETS_ACCEPT_V1=false` and **restarts**, because a setting the running
process has not loaded is an operator believing v1 is off while it is on. If the
stack does not come back ready, it restores the previous setting and restarts
again rather than leaving the installation down.

**Rotating a key.**

1. Append a second `id:key` pair to `SECRETS_KEYS`. Do not remove the first.
2. Point `SECRETS_ACTIVE_KEY_ID` at the new id, then `botctl restart`. New
   secrets are now written under the new key; old rows still read.
3. `botctl secrets rewrap` until it reports nothing left to re-encrypt. It is
   bounded (`--batch`, `--max`), safe to interrupt, and a converged run writes
   nothing at all.
4. `botctl secrets status` — every row should show `v2` and the new key id.
5. `botctl secrets retire-check --key <old id>` before removing the old pair.

**What retirement does and does not mean.** `retire-check` never edits
configuration; it reports whether removing a key would strand live ciphertext.
It refuses while any row still names the key, refuses for the active key, and
refuses while any row records a key id its envelope does not name — that last
one because the dependency count reads the recorded column, so a row that
disagrees with itself could hide a dependency.

A pass means the key may leave `SECRETS_KEYS`. It does **not** mean the key
material may be destroyed:

- every retained backup taken before the rewrap still contains ciphertext under
  that key, and taking a fresh backup afterwards does not make those readable;
- so the key must remain available offline for as long as any retained backup
  may contain ciphertext encrypted under it;
- only once the last such backup has passed its retention window is destroying
  the key material safe.

**What v1 acceptance costs while it is on.** The v1 envelope carries no
associated data, so a v1 ciphertext can be copied between rows and still
decrypt. v2 binds each value to its purpose, tenant and row and refuses a
transplant — but it does not protect values written under v1. Only re-encrypting
every row and then refusing v1 does that, and turning it off before the rows are
ready makes an installation unable to read its own secrets — which is what
`shutdown-check` exists to prevent.

**Restoring a backup after v1 is off.** A dump taken before the rewrap contains
v1 ciphertext, and nothing about disabling v1 changes what is inside a file
already written. Restoring such a dump into an installation that refuses v1
leaves those rows unreadable. To restore one you need both halves back: the key
material that was live when the dump was taken, and `SECRETS_ACCEPT_V1=true` for
the duration of the restore — after which `botctl secrets rewrap` and
`botctl secrets disable-v1` return the installation to the final state. This is
the same rule as key retirement, stated for the other direction: **the live
keyring is not the whole story, and a retained backup keeps its own
requirements until it expires.**

## Security properties

Checked by tests, not just intended:

- PostgreSQL and Redis publish no host port — asserted structurally in
  `tests/unit/deployment-compose.test.ts` and behaviourally in the smoke test,
  which opens a socket to both and requires a refusal.
- No container mounts the Docker socket, runs privileged, or uses host
  networking.
- The application containers run as a non-root user with all capabilities
  dropped. Exactly one container runs as root: the one-shot that copies the
  Web Admin bundle into a volume, which has no network and no configuration.
- Every third-party image is pinned by digest.
- Secrets live in `0600` files inside a `0700` directory and are never printed;
  the smoke test greps normal `botctl` output for each generated value.
- The installer never opens a firewall port.
- The updater never runs `git`.
- `botctl` refuses every `NEXA_*` variable from the caller's environment when
  it is invoked through `sudo`, and resets `PATH` — otherwise a delegated
  invocation could choose the library it loads, the registry it pulls from, and
  the `docker` binary it runs.

### Delegating botctl

A sudoers rule for `botctl` **must keep `env_reset`**, which is the default:

```
%ops ALL=(root) NOPASSWD: /usr/local/bin/botctl
```

The refusal described above is a backstop, not the defence. `BASH_ENV` and
similar are read by bash _before_ the script's first line runs, so an
`env_keep` that passes them through cannot be defended against from inside the
script they hijack.

### What is still visible, and to whom

Two things, both written down rather than left to be discovered. Both are
bounded by the same fact: everything that can see them is already root on this
host.

`env_file` values appear in a container's inspected environment, so anything
that can talk to the Docker socket can read `DATABASE_URL`. Socket access is
root-equivalent, so this is not a mitigable gap.

`docker compose config` prints the contents of every `env_file` — the compose
CLIENT reads them, not the daemon. So that command's output is not safe to paste
into a ticket, and `botctl status` exists partly so there is an output that is.

### Changing the edge subnet

`NEXA_EDGE_SUBNET` in `/etc/nexa/deploy.env` and `TRUSTED_PROXY_IPS` in
`/etc/nexa/nexa.env` are two halves of one decision. The installer derives the
second from the first once, and nothing keeps them in step afterwards.

**If you change the edge subnet, change the trusted proxy set to match, and
restart.** Otherwise the API stops believing Caddy's `X-Forwarded-For`, every
request appears to originate from the proxy, and a single failed-login burst
locks out every administrator. Nothing errors — the deployment just starts
attributing all traffic to one address.

```bash
sudo sed -i 's|^NEXA_EDGE_SUBNET=.*|NEXA_EDGE_SUBNET=10.42.0.0/24|' /etc/nexa/deploy.env
sudo sed -i 's|^TRUSTED_PROXY_IPS=.*|TRUSTED_PROXY_IPS=10.42.0.0/24|' /etc/nexa/nexa.env
sudo botctl restart
```

### Changing the data subnet

`NEXA_DATA_SUBNET` in `/etc/nexa/deploy.env` is the **one** place this
installation's own data network is named. PostgreSQL and Redis sit on that
bridge, and the panel HTTP client must refuse to call it — private addresses are
otherwise deliberately reachable so a self-hosted panel on a LAN works. Compose
passes the same value into the API's environment, and the runtime always denies
it. There is no second copy to keep in step: the denial follows the subnet
because it is read from the same variable that creates the network, and it is
not something `nexa.env` can turn off or leave out.

```bash
sudo sed -i 's|^NEXA_DATA_SUBNET=.*|NEXA_DATA_SUBNET=10.42.1.0/24|' /etc/nexa/deploy.env
sudo botctl restart
```

`PANEL_HTTP_DENIED_SUBNETS` in `/etc/nexa/nexa.env` is for **additional**
networks — a second bridge, a management VLAN — as a comma-separated list. It is
merged after the installation's own subnet and never replaces it. An empty or
absent value means "nothing extra", which is the ordinary case, and a
`nexa.env` written by an earlier release that never had the key is exactly as
protected as a fresh one. A panel on any other private address is unaffected.

Before staging.8 was accepted, the installer copied the subnet into
`PANEL_HTTP_DENIED_SUBNETS` once and nothing kept the two in step, so an
installation upgraded from a `nexa.env` that predated the key was protected only
because its subnet happened to be the default. That is the arrangement this
replaces.

## Still outstanding

**Images are digest-pinned but not signature-verified.** A release is addressed
by digest everywhere after the tag is resolved once, and the release workflow
records provenance and an SBOM. Provenance is not the same thing as
verification: nothing at install or update time checks that the bytes were
produced by this repository's release workflow, so the guarantee is only as
strong as the registry account.

Future hardening signs at publication and verifies before activation — the
installer and `botctl update` would check the signature between resolving the
digest and pulling it. Whether that is keyless (OIDC, tied to the workflow
identity) or a managed key is unresolved, and picking wrongly is expensive to
undo, so it is deliberately not decided here.

**Release provenance is trust-on-first-use.** A release is pinned by digest, so
the tag cannot be repointed under an installation and `botctl` addresses the
image by digest everywhere after resolving it once. But nothing verifies who
BUILT that digest. `nexa_resolve_digest` trusts whatever the registry answers
with the first time a version is named, and an attacker who can publish to the
package — a leaked `packages: write` token, a compromised Actions runner — can
publish a digest that every installation will then faithfully pin.

Closing it means signing releases at publish time and verifying the signature
before `botctl update` pulls: cosign with GitHub's OIDC identity, checked
against the repository and workflow that is allowed to produce releases. That is
a key-management decision of its own and it is not in this checkpoint. What is
here — one resolution, a digest everywhere after it, and `botctl version`
reporting the digest so it can be compared against the release job's summary —
is what makes the verification step addable later without changing the model.

**Migration compatibility is checked for one transition, not proved in
general.** The expand → deploy → contract rule is what makes application
rollback sound. `tests/integration/migration-compatibility.test.ts` now replays
the previous release's operations against this release's schema and refuses
`DROP COLUMN`, `SET NOT NULL`, `DROP TABLE`, `DROP CONSTRAINT`, `DROP DEFAULT`,
`TRUNCATE` and renames in the incoming migrations. What it does not do is prove
the rule for operations the replay does not name, and its boundary is a tag in
the file that a release has to move. A migration whose incompatibility lies
outside both still surfaces only as the previous release crash-looping AFTER
`botctl rollback` has stopped the working one.

**A failed release verification burns the version.** `publish` pushes the
version tag and `verify` reads the manifest back afterwards, so a release that
fails verification is already installable and the gate's immutability rule then
makes that version unpublishable for ever. Fixing it properly means pushing by
digest, verifying, and assigning the tag from the verified digest — a change
whose correctness turns on how the registry treats a re-pushed manifest, which
nothing in this repository can exercise. It belongs with the first real
registry acceptance, not with a static round. Until then the recovery is a
version bump, and it is a version bump for a release nobody had installed yet,
because the workflow fails loudly.

**`BLOCKER-SECRETS-V2`.** The v1 secret envelope binds no context to its
ciphertext, and a single configured KEK means rotation cannot read what the
previous key wrote. This checkpoint is arranged so the migration stays
possible — the key is a value in an operator-owned file, not baked into an
image — and nothing here implements v2. It remains the blocker before Phase 3
introduces provider credentials.
