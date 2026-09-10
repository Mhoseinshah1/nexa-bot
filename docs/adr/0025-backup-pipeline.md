# ADR-0025 — The backup pipeline

**Status:** Accepted. Implemented as Telegram Backup V1. Supersedes nothing;
implements the delivery decision recorded in ADR-0011 and settles the questions
that ADR left open.

## The problem

ADR-0011 decided that a backup is delivered to Telegram, over the architecture
review's objection, and listed seven compensating controls the design would owe.
It did not say what a backup IS. This does.

The legacy system's answer is the corpus's most quietly alarming finding: a
database dump piped into a ZIP and posted into a chat. Unencrypted. Never
restored. Never checked. With the archive's password sent through the same
channel as the archive, which makes the password decorative. Nobody ever
established that any of those files could be turned back into a database, and
the only way to find out would have been the day it mattered.

So the failure to avoid is not "we have no backups". It is "we have files
everyone believes are backups". Those are different, and the second is worse,
because its existence stops anyone looking for a real one.

## Decision

A backup is one artifact and four claims about it, produced by six stages in a
fixed order.

```
DUMP  →  CHECKSUM  →  ENCRYPT  →  VERIFY_RESTORE  →  DELIVER  →  CLEANUP
```

The order is the whole contract: **DELIVER is reachable only from a
VERIFY_RESTORE that passed.** A successful `pg_dump` is a file. A backup is a
file that has been checksummed, encrypted, and proven to restore into a real,
empty PostgreSQL database.

### The dump excludes nothing

`pg_dump --format=custom`, whole database, `--no-owner --no-acl`. No
`--exclude-table`, no schema filter, no table left out because it looks
transient.

The rule is that data is included unless it is PROVEN safely reconstructable,
and nothing here is. `processed_messages` looks like a cache and is the only
thing standing between a redelivered outbox message and a duplicated effect.
`panel_probe_budgets` looks like a counter and is what bounds an installation's
outbound rate. A backup is not the place to be clever, and a table's name is not
evidence about its role.

The manifest carries an `exclusions` array so that any future exclusion has to
state a reason a restorer can evaluate, inside the artifact. It is empty, and
`tests/unit/backup-archive.test.ts` fails if it stops being.

### The checksum covers the plaintext dump

SHA-256, byte for byte, as `pg_dump` wrote it. Stated precisely because "the
checksum" is ambiguous by default and the ambiguity decides what it detects.

Over the plaintext it answers the question a restore actually asks — are these
the bytes PostgreSQL produced? — and therefore covers truncation, modification
and corruption anywhere in the chain INCLUDING the encrypt and decrypt steps. It
also stays verifiable years later by anyone holding the key and the manifest.

A checksum over the ciphertext would detect strictly less: it says an archive is
the archive we wrote, and says nothing about whether decryption reproduced the
dump. AES-GCM's authentication tag already covers the ciphertext, so a
ciphertext digest would duplicate the tag and leave the plaintext unchecked.
Both protections exist and answer different questions.

### The archive is a new streaming format, and `SecretCipher` was inspected first

The instruction was not to assume the existing cipher suits large files. It was
inspected, and it does not, for three independent reasons any one of which is
fatal:

- its port is `encrypt(plaintext: string)`, and a custom-format dump is binary.
  The `'utf8'` decode replaces every invalid byte sequence with U+FFFD — a
  64-byte gzip buffer round-trips to 96 bytes;
- its envelope is `base64url`, and `Buffer.toString` throws above
  `MAX_STRING_LENGTH`, so any payload over about 384 MiB cannot be encoded at
  all;
- it holds plaintext, ciphertext and envelope in memory simultaneously, which is
  three copies of the database.

What IS reused is everything that makes it trustworthy: the same keyring, so one
active key encrypts and every held key decrypts and a rotation is an overlap
rather than a flag day; the same envelope structure, a random per-archive data
key wrapped under the KEK; the same AES-256-GCM; the same associated-data
discipline. No new cryptography was invented — only a new container around the
same primitives.

No new `SECRET_PURPOSE` was added. The registry requires every declared purpose
to have a ciphertext COLUMN producer (`tests/unit/secret-registry.test.ts`), and
an archive is a file rather than a column; declaring one would have made that
check pass vacuously for a purpose it cannot see.

```
magic          8 bytes, ASCII `NEXABAK1`
headerLength   uint32 big-endian
header         UTF-8 JSON: format, backupId, keyId, wrapIv, wrappedKey,
               wrapTag, iv, cipher
ciphertext     to end-of-file minus 16
tag            16 bytes, the GCM authentication tag
```

The tag is a trailer because GCM produces it only after the last byte, and
holding a whole dump to move sixteen bytes forward is the memory cost this
format exists to avoid. Decryption reads it first; the archive is a file, so its
end is one seek away.

Inside the encrypted region: a length-prefixed manifest, then the dump. The
manifest is inside because it names the installation and the database.

**The header is cryptographically load-bearing in every field**, which is what
makes an edited header refused rather than obeyed. It is also the payload's
associated data — and that is defence in depth, not the thing doing the work,
because a falsification run showed that removing it changes nothing while the
key-unwrap binding remains. The record says so rather than claiming otherwise.

### Verification restores the ENCRYPTED archive, into a database it creates

Not the plaintext dump still on disk. That would prove `pg_dump` works and
nothing about whether the artifact being delivered can become a database again.

`openArchive` is the REAL restore path — the same function the operator's
restore command calls — so a verification cannot pass by decrypting through a
route nobody restores through. Three things must hold, each catching a different
failure: the archive authenticates; the decrypted bytes checksum to the
manifest; `pg_restore` into a freshly created EMPTY scratch database produces
tables. Zero tables is a failure, because an empty dump restores perfectly.

The scratch database is randomly named with a recognisable prefix, created
empty, and dropped. A drop that fails is reported on the run row rather than
logged and forgotten: a leftover scratch database is real debris on the
operator's server. The live database is refused as a target by name, in a check
that is separate from the fact that no call site can currently pass it.

A run that fails verification deletes its archive rather than delivering it.

### Delivery has three outcomes, and the third is the point

`SUCCEEDED` / `FAILED_DEFINITIVE` / `OUTCOME_UNKNOWN`, on the run row, with its
own enum rather than extending `DELIVERY_OUTCOMES`.

Extending that one was rejected deliberately. It is shared with the notification
dispatcher and pinned by a database CHECK constraint, and its `FAILED_RETRYABLE`
encodes a DECISION ("try again") rather than a FACT — correct there, because a
notification carries a dedupe key and a duplicate alert is free. A duplicate
forty-megabyte encrypted database in an administrators' group is not free.

So a 5xx, a 429, a timeout, a dropped socket and an unreadable 2xx are all
`OUTCOME_UNKNOWN`. Telegram can reject a request whose upload it already
accepted, and a 5xx can follow a write that landed. Nothing resends
automatically. The state is durable, queryable (`withUnknownDelivery`), and
exists precisely so a system that does not know does not guess.

A delivery failure does NOT fail the run. An archive that dumped, checksummed,
encrypted and restored is a sound backup whose transport failed; calling that a
failed backup would tell an operator their data is unprotected while it sits
verified on their own disk.

### One backup at a time, enforced by PostgreSQL

`backup_runs_single_active_idx` is a partial unique index over a constant, where
`state = 'RUNNING'`. At most one such row can exist in the table, so a second
starter's INSERT raises a unique violation, which the repository turns into a
truthful BUSY.

The alternatives were rejected on their failure modes rather than on taste. An
in-memory flag bounds one process, and two worker replicas is the normal case on
every rolling update. A `pg_advisory_xact_lock` would have to be held for the
length of a dump inside a transaction that `idle_in_transaction_session_timeout`
exists to kill. A session-scoped `pg_try_advisory_lock` dies with a pooled
connection that gets recycled underneath it.

Because a lock nobody can release outlives its owner's crash, the claim is a
LEASE: `lease_owner` names the process, `lease_heartbeat_at` is refreshed while
it works, and a stale lease can be taken over — by transitioning the abandoned
run to FAILED, never by adopting it. Its workspace belongs to a process that may
still be writing, and a second writer to the same paths is how two partial dumps
become one plausible-looking corrupt archive. The files are left in place and
named on the row, because deleting another process's open output is the other
way to corrupt it.

### One execution path

`BackupService.run(trigger)` is what the scheduler calls and what the operator
calls. `trigger` is recorded and branched on nowhere. A second path for "the
operator pressed the button" is how the manual and scheduled backups come to
differ in exactly the property nobody tests — which, on a pipeline whose whole
purpose is the unattended case, would mean the tested path is the one that does
not matter.

### Configuration is installation-level, in the environment

Not tenant settings. A dump is of the whole database, so a per-tenant switch
would be a setting that cannot mean what it says. And the CLI has to read this
configuration when the database is the thing that is broken, which is exactly
when a settings table is unavailable.

`BACKUP_TELEGRAM_CHAT_ID` and `BACKUP_TELEGRAM_BOT_TOKEN` must be set together
or not at all. Neither is a real choice — the archive is verified and retained.
One alone is an installation whose operator believes their backups are leaving
the host and finds out otherwise during a disaster.

## ADR-0011's seven compensating controls

| #   | Control                                                                     | Status in V1                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Per-backup keys, never a shared password, never through the same channel    | **Done.** A random data key per archive, wrapped under a KEK that never leaves `/etc/nexa/nexa.env`. Nothing about the key is in the caption, the manifest, the log or the message.                                                                                                                |
| 2   | Off-server object storage as the primary destination, Telegram secondary    | **NOT in V1.** Recorded honestly rather than implied. The archive is retained on the host and delivered to Telegram; there is no second destination.                                                                                                                                               |
| 3   | A size ceiling above which Telegram gets a notification, not the artifact   | **Done.** Above `BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES` the group receives a message naming the backup, its checksum and where it stays.                                                                                                                                                              |
| 4   | A retention/deletion policy for the Telegram channel, applied by the system | **NOT in V1.** Nothing deletes an old backup, from the channel or from the disk. `BACKUP_WORK_DIR` grows without bound until an operator prunes it. This is the most operationally significant gap and is stated in `docs/backup.md`.                                                              |
| 5   | A dedicated channel with documented, reviewed membership                    | **Partly.** The configuration makes a dedicated channel possible and gives it its own bot token rather than reusing the customer-facing one. Membership review is an operational obligation no code can enforce; `docs/backup.md` states it.                                                       |
| 6   | An access log recording every delivery                                      | **Done, on our side.** Every run records its delivery state, the time it was attempted and a redacted detail. What this cannot record is who READ the archive in Telegram — Telegram does not expose that, and claiming otherwise would be the kind of unverifiable assurance this project avoids. |
| 7   | A verified restore drill before the first production backup is relied on    | **Done, and made structural.** Rather than a drill somebody remembers to run, every single backup verifies by restoring.                                                                                                                                                                           |

## Consequences

An installation whose database grows past Telegram's ceiling stops receiving
artifacts and starts receiving notifications. That is deliberate and visible, and
it is the point at which control 2 stops being optional.

Every backup costs a full restore into a scratch database, so a run is roughly
twice the work of a dump and needs disk for the dump, the archive and the
verification copy at once. That is the price of the claim, and the claim is the
product.

Nothing prunes anything. Until control 4 exists, `BACKUP_WORK_DIR` is an
operator's responsibility.

`OUTCOME_UNKNOWN` rows accumulate until a person resolves them. There is
deliberately no automatic reconciliation in V1: resending a document Telegram may
already hold is a decision, and the state exists because the system does not know
enough to make it.

## Four decisions this ADR originally left unrecorded

Added by the Architecture Hardening pass (item N), which found them. Each was a
real decision taken while the pipeline was written and argued only in a code
comment, which means the next reader would have found the behaviour and not the
reasoning.

### The operator's restore deviates from ADR-0010, deliberately

`backup restore` is the most destructive operation this codebase has: it writes a
dump into a database. ADR-0010's protocol has five steps, and restore performs
one and a half of them. There is no dry run, no counted preview, no typed
confirmation phrase, and no audit row.

That is a deviation, not an oversight, and the reasons differ per step:

- **No dry run.** `pg_restore` has no mode that computes the effect without
  applying it. The closest thing is a restore into a scratch database, and that is
  not a preview of this operation — it is a different operation with a different
  target, which is why the pipeline already does it as VERIFICATION.
- **No counted preview.** The count is "the whole database", and a number that is
  always the same is not a check.
- **No typed confirmation.** The CLI is the confirmation: it refuses a live target
  by name, it refuses a target that already holds tables, and it requires the
  target to be named explicitly with no default. Three refusals that a typed
  phrase cannot add to — a phrase proves the operator meant to run the command,
  and these prove the operator meant to run it HERE.
- **No audit row.** `audit_logs` is tenant-scoped and a restore is
  installation-wide, and the operator running it is a shell user rather than an
  `admins` row. An audit row would have to invent both a scope and an actor, which
  `CLAUDE.md` forbids in the same sentence. The `backup_runs` row is the record,
  and for a restore there is not even that — see the next section.

**What is owed:** the Web Admin disaster-recovery surface will have a real
administrator actor and a real scope, and there the five steps apply in full. This
deviation covers the CLI only, and the CLI exists because a restore has to be
possible when the application will not start.

### A restore leaves no durable record, and that is the weakest decision here

`restoreInto` is the one state-changing external effect in this codebase with no
row saying it happened. It is a human one-shot, run from a shell, and the
alternative at the time would have been a table with one writer and no reader.

Stated plainly because it is the decision most likely to be wrong: an operator who
restores a backup and then cannot remember which one has no way to find out. The
Web Admin recovery surface is where this is fixed, and it is fixed by having a
recovery REQUEST entity rather than by adding a row to the backup table.

### A failed backup raised no operational event

It raised a log line and a `backup_runs` row, and nothing else — so an unattended
nightly failure was silent on the one channel built to report failures.

**Corrected by the Architecture Hardening pass** (item B): `backup.run_failed` is
an operational condition deduped on one installation-wide key, so a nightly
failure is ONE open condition with a rising occurrence count rather than a new
alert every night, and `backup.run_ok` closes it. The recovery is recorded before
the run row is finished, so a crash between the two leaves the condition open
rather than resolved.

### Who a backup is attributable to, and why there is no audit row for a run

The owner's hardening brief asks for a manual backup to be attributable to the
actual operator "where the architecture has an operator actor". In this release it
does not, and that is the finding rather than a gap to paper over.

`backup run` is a CLI invoked on the host. The actor model here has exactly two
kinds of actor — an `admins` row reached through the Web Admin, and `SYSTEM_JOB` —
and a shell user on the box is neither. Recording one would mean either inventing
an administrator id or addressing the run to a tenant that has nothing to do with
it, and `CLAUDE.md` forbids both in the same sentence ("no fabricated actors").

So attribution is by TRIGGER, which is a fact the pipeline actually has:

- `MANUAL` means a human ran the CLI on the host. The record names the host
  (`lease_owner` is the process identity) and the time. It does not name a person,
  because nothing in this release knows which person.
- `SCHEDULED` means the worker's timer fired. It names no human at all, which is
  the point: a system-triggered run that carried an administrator's name would be a
  false attribution, and a false one is worse than an absent one.

**`backup_runs` is the accountability record.** A separate generic audit row would
carry the same id, the same timestamps, the same trigger and the same outcome, and
would add a scope and an actor that would both have to be invented. Two rows saying
the same thing is how they come to disagree — one written and one not, when a
failure lands between them. The tests therefore assert the real source of
accountability (the run row's trigger, times, lease owner, state and failure code)
rather than the existence of a ceremonial duplicate.

**What is owed**: the Web Admin's Run Backup Now button has a real `ActorContext`
and a real permission to check, and there the manual path records who. That is the
disaster-recovery surface's work, and the record it writes belongs beside the other
authorized mutations rather than in this table.

### A request-level idempotency key does not apply to `backup run`

`docs/conventions.md` requires an idempotency key on every state-changing command,
and this one does not have an explicit one. That is a decision.

An idempotency key answers "is this the same request I already handled, and may I
return the first answer?" For a backup the honest answer to a repeat is no: an
operator who runs `backup run` twice wants two backups, taken at two times, of two
states of the database. Suppressing the second as a replay would be wrong, and a
key that never suppresses anything is ceremony.

What the convention is actually protecting against — two effects where the operator
asked for one — is handled by the partial unique index on `backup_runs`, which
admits exactly one RUNNING row per installation. A concurrent second invocation is
told BUSY and the holder's start time; a sequential second invocation is a second
backup, which is what was asked for. That is a stronger guarantee than a key,
because it holds across processes and replicas without either of them agreeing on
anything.

### The scheduler runs in the worker, and is not a fourth process role

Phase 3C added `monitor` as a third role because panel health is a continuous
obligation with its own cadence, its own budget and its own failure mode, and
putting it in the worker would have made one process's backlog another's outage.

The backup scheduler is the opposite shape: it fires at most once per interval,
holds an installation-wide lock while it runs, and has no per-tenant fairness
question. A fourth role for it would be a container, a healthcheck, a readiness
entry and a compose service for one `setInterval` — and a role whose only job is
rare work is a role nobody notices has stopped.

So it lives in the worker, gated on `BACKUP_SCHEDULE_ENABLED`, and the worker's
readiness consults its freshness like any other loop. What makes that safe is that
the lock is a partial unique index rather than a process: two worker replicas
racing a tick is the normal case on every rolling update, and the database decides.

### Eight error codes, and two deliberate choices about their granularity

Four cryptographic causes are COLLAPSED into one code, and the malformed case is
deliberately NOT collapsed into it.

`backup.archive_auth_failed` covers a wrong key, a flipped ciphertext byte, a
truncated payload and a forged tag. Those are four different causes and one
answer: this archive cannot be trusted, do not use it. Distinguishing them would
tell an attacker which of their guesses was closer, and would tell an operator
nothing they could act on differently.

`backup.archive_malformed` is separate because it is actionable in a different
direction: the file is not a Nexa archive at all — a wrong path, a truncated
download, somebody else's file. The remedy is to find the right file, not to
question the key.

The ordering between the two is load-bearing and was a real defect: the manifest
length was validated BEFORE the AEAD tag, so one flipped bit in the first
ciphertext byte reported `archive_malformed` — acting on attacker-chosen plaintext
and answering with an oracle. It now records the complaint and drains the stream
so `decipher.final()` authenticates first.
