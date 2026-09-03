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
  TLS, serves the Web Admin, and proxies `/api/*` and `/health/*` to the API.
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
4. **Migrate**, using the _target_ release's own compiled migrator — so the
   schema change is the one the incoming code expects, by construction.
5. **Start** the target release.
6. **Wait** for the API's readiness probe.
7. **Commit**: write the release manifest, then the image pointer, then
   `previous`, then `current`.

Step 7 is the only durable moment. Everything before it leaves the previous
release current and running.

The order inside step 7 is deliberate. The image pointer — what a restart or a
reboot would actually start — is written before `current`, which is what every
command reports. So an interruption partway through leaves an installation that
still reports the previous release and is fixed by re-running the update, rather
than one that reports the new release while quietly starting the old one.
`botctl version` and `botctl status` compare the two and report a divergence
loudly if they ever disagree.

### What happens when it fails

| Failure                        | Result                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| The version cannot be resolved | Current release untouched. Nothing pulled.                                          |
| The image cannot be pulled     | Current release untouched. No backup, no migration.                                 |
| The backup fails               | **The update does not proceed.** Nothing is migrated.                               |
| The migration fails            | The target does not become current. The pre-migration backup is named in the error. |
| The target does not start      | The previous release is restarted; it remains current.                              |
| The target is never ready      | The previous release is restarted; it remains current.                              |
| The rollback is not healthy    | Reported loudly. **Neither release is deleted.**                                    |

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

There is no automated destructive schema rollback and there will not be one: a
down-migration that drops a column is a data-loss button beside a panic button.

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

The digest is the identity. `latest` is never the installed identity, and
`botctl version` reports all three so an installation can be tied back to
source without trusting any single one of them.

Manifests live in `/var/lib/nexa/releases/<version>.json`. `current` and
`previous` name the active release and the rollback target.

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

## Still outstanding

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

**Migration compatibility is policy with no mechanism.** The expand → deploy →
contract rule below is what makes application rollback sound, and nothing in
this repository checks that a migration obeys it. A single same-release
`DROP COLUMN` or `SET NOT NULL` silently invalidates every rollback afterwards,
and it surfaces only as the previous release crash-looping AFTER `botctl
rollback` has already stopped the working one. A migration-review gate belongs
beside `check-migration-drift.sh`.

**`BLOCKER-SECRETS-V2`.** The v1 secret envelope binds no context to its
ciphertext, and a single configured KEK means rotation cannot read what the
previous key wrote. This checkpoint is arranged so the migration stays
possible — the key is a value in an operator-owned file, not baked into an
image — and nothing here implements v2. It remains the blocker before Phase 3
introduces provider credentials.
