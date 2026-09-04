# Deploying Nexa

How an installation is created, operated, updated and rolled back. The
reasoning behind these choices is in
[ADR-0022](adr/0022-deployment-topology.md); this is the operator's document.

## What is supported

|                  |                                        |
| ---------------- | -------------------------------------- |
| Operating system | Ubuntu **22.04 LTS** or **24.04 LTS**  |
| Architecture     | `x86_64` (amd64) or `aarch64` (arm64)  |
| Disk             | at least 8 GB free on `/var`           |
| Ports            | 80 and 443 reachable from the internet |
| DNS              | a name already pointing at the host    |

The installer checks every one of these before it changes anything, and stops
with the specific problem if one fails.

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
                 │    api    │──────────────┐
                 └─────┬─────┘              │
                       │                    │  edge (egress to Telegram)
   data network ┌──────┴──────┐      ┌──────┴──────┐
                │             │      │   worker    │
          ┌─────┴─────┐ ┌─────┴────┐ └──────┬──────┘
          │ postgres  │ │  redis   │◄───────┘
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
- **api** and **worker** are the same image with different commands. Both reach
  the internet through the edge network — the worker needs it, because the
  notification dispatcher runs there and calls Telegram.
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
  --owner-password-file /root/owner-password
shred -u /root/owner-password
```

An install with no terminal and no `--owner-password-file` fails rather than
silently skipping the owner.

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

None of these print a secret. `botctl status` deliberately shows container
state rather than configuration, so its output can be pasted into a ticket.

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

1. **Stage** the target's set into `/var/lib/nexa/assets/<version>`, extracted
   from its image. A pure read: a release that does not carry them fails here,
   before anything on the host has changed. The extraction writes to a
   `.partial` directory and renames it only once every file is present, so an
   interrupted one leaves nothing for a later activation to install from.
2. **Record** what is live now, under the outgoing release, so a failed update
   has something to put back.
3. **Activate** the target's set, before the migration and the start, so the
   target runs under its own compose file and Caddy routes. Each file is
   written beside its destination and renamed over it — atomic, so an
   interruption leaves either the old file or the new one and never a truncated
   `botctl`; and safe for a `botctl` that is replacing itself while bash is
   still reading it, because a rename swaps the directory entry and leaves the
   running process's inode alone.

Every failure path from step 3 onwards puts the outgoing release's set back
before restarting it, so a failed update leaves an installation whose tooling
matches what is actually running.

A rollback does the same in reverse: it activates the previous release's
recorded set before starting its image. The alternative — leaving the newer
tooling to operate the older image — would be a compatibility contract, and
nothing here proves one. If the previous release's set was never recorded,
`botctl rollback` says so and stops rather than mixing them.

### Installations made before this mechanism existed

An update is performed by the `botctl` that is **already installed**, so a host
whose `botctl` predates this mechanism cannot be repaired by an update: the
script that would move the host assets is the one that is missing. That is not
a gap in the mechanism, it is what "the tool updates itself" means, and no
amount of work in a later release can reach backwards into a script already on
disk.

Such a host needs one repair, once, and then never again:

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

| Failure                             | Result                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The version cannot be resolved      | Current release untouched. Nothing pulled.                                                                |
| The image cannot be pulled          | Current release untouched. No backup, no migration.                                                       |
| The backup fails                    | **The update does not proceed.** Nothing is migrated.                                                     |
| The image carries no host assets    | Refused before anything on the host changes.                                                              |
| The outgoing set cannot be recorded | Refused: a failed update would have nothing to put back.                                                  |
| The migration fails                 | Host assets restored. The target does not become current. The pre-migration backup is named in the error. |
| The target does not start           | Host assets restored, then the previous release is restarted; it remains current.                         |
| The target is never ready           | Host assets restored, then the previous release is restarted; it remains current.                         |
| The rollback is not healthy         | Reported loudly. **Neither release is deleted.**                                                          |

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
the volume it wrote still holds the assets.

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

`NEXA_DATA_SUBNET` in `/etc/nexa/deploy.env` and `PANEL_HTTP_DENIED_SUBNETS` in
`/etc/nexa/nexa.env` are the same arrangement, for a different reason. The
second is the list of networks the panel HTTP client refuses to call because
they are this installation's own: PostgreSQL and Redis sit on that bridge, and
private addresses are otherwise deliberately reachable so a self-hosted panel on
a LAN works. The installer derives one from the other once, and nothing keeps
them in step afterwards.

**If you change the data subnet, change the denied list to match, and restart.**
Otherwise an operator with permission to edit a panel can aim one at the
database or the cache and read reachability off the health result. Nothing
errors — the protection is simply pointed at a network nothing is on.

```bash
sudo sed -i 's|^NEXA_DATA_SUBNET=.*|NEXA_DATA_SUBNET=10.42.1.0/24|' /etc/nexa/deploy.env
sudo sed -i 's|^PANEL_HTTP_DENIED_SUBNETS=.*|PANEL_HTTP_DENIED_SUBNETS=10.42.1.0/24|' /etc/nexa/nexa.env
sudo botctl restart
```

The value is a comma-separated list, so a deployment with more than one network
of its own can name them all. A panel on any other private address is
unaffected.

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
