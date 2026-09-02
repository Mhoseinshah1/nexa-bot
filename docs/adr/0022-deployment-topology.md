# ADR-0022 — Deployment topology, release identity and the update algorithm

**Status:** Accepted. Implemented in the deployment/installer checkpoint that
follows Phase 2.

## The problem

Nothing in this repository deployed. `BLOCKER-DEPLOY` recorded the gap plainly:
no image, no TLS topology, no release wiring, no installer. The compiled
maintenance entrypoints added during Phase 2's stabilisation pass were
groundwork for this checkpoint, not the checkpoint.

The legacy product is the warning. It is installed by pasting a shell one-liner
that clones a repository and runs it in place, which means the running version
is whatever `git pull` last produced, an update cannot be reasoned about or
undone, and no two installations are provably the same software. There is no
notion of "the version this customer is running" that survives contact with a
support conversation.

## What this checkpoint is not

It is not Phase 3. No provider or panel credential exists yet, and none is
introduced here.

It is not Secret Envelope v2. The v1 envelope's shortcomings — no AAD binding,
one configured KEK so rotation cannot read what the previous key wrote — remain
recorded as `BLOCKER-SECRETS-V2`, and this checkpoint is deliberately arranged
so that migration stays possible: the KEK is a mounted file the operator can
extend to a keyring, not a value baked into an image or a compose file.

## Decision

### One image, four process roles, selected by command

The API and the worker are the same immutable image with different commands.
They already are the same code — `main.ts` and `main.worker.ts` over one module
graph — so two images would be two things to build, sign, pull and get out of
step. The maintenance entrypoints (migrate, seed, bootstrap-owner, provision)
run as one-off containers from that same image.

This is what makes "the migration runs from the target release" mechanical
rather than aspirational: `botctl update` runs the target image's own
`dist/infrastructure/persistence/migrate.js`, so the schema change is the one
the incoming code expects, by construction.

The Web Admin is not a process. It is a static bundle, built in the same image
build and copied out to a volume the edge serves from, so there is no Node
process in the request path for a file that never changes between releases.

### Packaging: `pnpm deploy --prod --legacy`, then copy only the artefacts

The workspace is pnpm with two internal packages the API depends on
(`@nexa/contracts`, `@nexa/i18n`), both built to `dist`. `pnpm deploy` resolves
that graph into a self-contained tree; `--legacy` because pnpm 10 otherwise
requires `inject-workspace-packages`, and `--prod` because the runtime must not
carry `tsx`, `drizzle-kit`, `typescript` or a test runner.

The runtime stage copies four things out of it: `dist/`, `drizzle/`,
`node_modules/` and `package.json`. Not `src/`, not the tsconfigs, not
`drizzle.config.ts` — `pnpm deploy` includes them because `apps/api` declares no
`files` field, and a production image has no use for any of them.

`drizzle/` sits beside `dist/` because `migrationsFolder()` resolves
`dist/infrastructure/persistence/../../../drizzle`. A layout that nests one
level differently points the migrator at nothing and it cheerfully applies zero
migrations.

### Release identity is a digest, never a tag

A release is three facts that travel together: a **version**, the **source
commit** it was built from, and the **image digest** it resolved to. The digest
is the identity; the version is a label for humans and the commit is for
support.

`latest` is never the installed identity. `botctl update` resolves the requested
version to a digest **before** anything is switched, and activates by digest, so
a tag repointed after resolution cannot change what is running. The release
manifest that carries these three facts is a small JSON file per release under
`/var/lib/nexa/releases/`, not a service.

### Compose, not an orchestrator

One host, one customer, five containers. Kubernetes, Nomad, Swarm and Terraform
are all larger than the problem and each would add an upgrade surface of its own.
Compose restart policies satisfy the reboot requirement without a systemd unit,
which is why there is no systemd unit.

### The edge is the only public surface

Caddy publishes 80 and 443. PostgreSQL and Redis publish nothing — they are
reachable only on an internal Compose network, which is the difference between
"we set a strong password" and "there is nothing to connect to".

Caddy terminates TLS, serves the Web Admin bundle, and reverse-proxies the API
prefix and the three health routes. It adds no authentication of its own: the
API already authenticates every administrative route and answers `/health/info`
with 401 without a session, and a second auth layer in the proxy would be a
second place for that decision to be made differently.

`TRUSTED_PROXY_IPS` names the internal network's subnet, which is why the subnet
is pinned in the compose file rather than left to Docker's allocator. The
application refuses to boot in `reverse-proxy` topology with an empty trusted
set, and it refuses `/0`; a pinned subnet is the narrowest true answer.

### Configuration is derived from the application's own schema

There is no hand-written second list of environment variables. The installer
generates a file, and a test parses that file through the real `configSchema`,
so a variable added to the application without a deployment answer fails the
build rather than the first production boot. The schema already refuses the
dangerous combinations — `AUTH_MODE=none` outside development, a recording
notification transport, a `direct` topology in production, an `http://` admin
origin — so the deployment inherits those refusals instead of restating them.

### Secrets are generated files, not compose values

Four values are generated at install time: the PostgreSQL password, the Redis
password, the `SECRETS_KEK` and its id. They live in `/etc/nexa/nexa.env`, mode
`0600`, owned by root, and reach the containers through `env_file`. They are
never echoed, never passed as command arguments, and never baked into an image
layer.

The first owner's password is never generated and never stored: it is read on
the bootstrap CLI's stdin, which is the mechanism that CLI already implements
precisely because argv is world-readable in `ps`.

### Update is a state machine with one durable commit point

`botctl update` holds an exclusive `flock` for its whole run, so a second
`botctl update`, `install` or `rollback` waits rather than interleaving. The
order is: resolve to a digest, pull, preflight, back up, migrate with the target
image, start the target, wait for readiness, and only then write the new
`current` release pointer. Every failure before that write leaves the previous
release current and running.

The previous release is never deleted by the update that replaced it. That is
what makes rollback a switch rather than a download.

### Rollback is an application rollback and touches no data

`botctl rollback` returns the application to the previous release's digest. It
does **not** restore the database backup, and that is the most important
sentence in this ADR: the backup was taken before the migration, and restoring
it would discard every write made since — an outage turned into data loss by the
tool meant to fix it. Restoring a backup is a separate, explicitly destructive
action.

This is only sound while migrations are backward-compatible, so this checkpoint
also establishes the rule that makes it sound.

### Migration policy: expand, deploy, contract

A migration may add. It may not, in the same release, remove or narrow anything
the previous release still reads.

- **Expand** — add the column, table, index or constraint, nullable or defaulted,
  in release N.
- **Deploy** — release N's code writes both shapes and reads the new one.
- **Contract** — remove the old shape in release N+1 or later, once no supported
  rollback target reads it.

The practical guarantee: release N's schema runs release N−1's code. Rollback
across one release is therefore safe, and `botctl rollback` says so. Across more
than one it is not promised, and the tool does not pretend otherwise.

There is no automated destructive schema rollback, and there will not be one.
A down-migration that drops a column is a data-loss button beside a panic
button.

## Consequences

- An installation's identity is checkable: `botctl version` prints a version, a
  commit and a digest, and the digest is what is running.
- A failed update is a non-event: the previous release never stopped being
  current, and the operator sees why it failed.
- A failed release that _did_ start is one command from being undone, with no
  data implications.
- Redis holds nothing today, so it is deliberately run without persistence — see
  below. When it acquires queues or locks, that decision must be revisited, and
  the compose file says so.
- The retention of old releases is bounded and documented rather than unlimited.

## Rejected

**A `git pull` updater.** It is the legacy mechanism and the reason this
checkpoint exists. It cannot express "which version is this", cannot be undone,
and executes whatever the branch happens to contain at the moment it runs.

**Restoring the database during rollback.** It converts a recoverable
application fault into unrecoverable data loss. Discussed above at length
because it is the mistake most likely to be introduced by someone trying to make
rollback "more complete".

**A Redis persistence volume.** Redis is connected and health-checked and stores
nothing at all through Phase 2 — the login throttle is Postgres-backed and no
queue library is installed. A volume would persist an empty dataset and imply a
durability guarantee nothing relies on. It runs with `--save ""` and
`--appendonly no` so the intent is unambiguous in the file rather than implied
by its absence.

**A systemd unit.** Compose restart policies already satisfy "survives reboot",
and a unit would be a second thing that can disagree with the compose file about
whether Nexa should be running.

**Two images for API and worker.** They are one codebase with two entrypoints.
Two images means two builds, two digests and a new way for a deployment to run
mismatched halves of itself.

**Baking configuration into the image.** An image that contains a domain or a
key is not the same image the next customer runs, which defeats the point of a
digest.
