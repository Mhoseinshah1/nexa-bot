# ADR-0032 — Portable disaster recovery: the encrypted Recovery Kit

**Status: accepted.** Owner specification § 15. Supersedes ADR-0028 § 10
("foreign-installation archives are refused") and closes the open question it
recorded in `docs/open-questions.md`. Extends ADR-0025 (the archive) and
ADR-0028 (the restore) without changing a rule either states.

## The problem

A `.nxb` copied off a VPS is not restorable on a fresh installation. The archive's
per-archive data key is wrapped under the key-encryption key (KEK) of the
installation that sealed it (`archive.ts`, `wrapAad = backupId|keyId`), and a
fresh install's installer generates a NEW KEK. The restore fails at the key —
`recovery.archive_foreign_key` — and the only way back was to recover the old
`/etc/nexa/nexa.env` by hand. The old Caddy/TLS state does not contain the KEK.
For an operator whose server is simply gone, the backups were cryptographically
lost.

The same is true one level down. Even with the archive open, every stored secret
inside the restored database — bot tokens, panel credentials, gateway
credentials — is a `SecretCipher` envelope naming the OLD installation's key. A
restore that only solved the archive would cut over to a database whose bot
cannot start.

## Decision

### 1. A separate, passphrase-sealed file — never the KEK inside the archive

The Recovery Kit is its own file (`.nxkit`), exported from the Web Admin and kept
apart from the backups. Putting the KEK into the `.nxb` would make the archive's
encryption decorative. The kit holds **every key the installation holds** —
configured and imported — because an archive sealed under the active key is the
common case and a restored database may need rotation-era keys too.

Format: `docs/recovery-kit-format.md`, contract in
`packages/contracts/src/recovery-kit.ts`, one reader and one writer in
`apps/api/src/infrastructure/crypto/recovery-kit.ts`.

- `NEXAKIT1` magic, a length-prefixed cleartext JSON header, AES-256-GCM
  ciphertext, 16-byte tag trailer — the archive's own layout, so the decisions
  ADR-0025 made about it carry over unchanged.
- The header carries the format version, the KDF algorithm and parameters, the
  salt and the nonce. The whole preamble is the payload's associated data:
  editing any of it fails the tag rather than steering the derivation.
- The payload is strict JSON: `{format, kitId, keys:[{keyId, material,
fingerprint}]}`. It has no field that could mark a key active, and a payload
  carrying one is refused as malformed.

### 2. scrypt, not Argon2id — a stated deviation

The owner named Argon2id. Node 22 — the version the image pins — ships scrypt and
no Argon2; every Argon2 binding is a native build or a single-maintainer
prebuilt, none is in the lockfile, and the offline store cannot add one. That is
exactly the trade `ScryptPasswordHasher` already documents. So format 1 uses
**scrypt, N = 2^17, r = 8, p = 4**: the memory of one login (128 MiB, on the same
small server) and four times the work, because a kit is an offline target. The
algorithm is NAMED in the authenticated header, so adding `argon2id` later is a
new branch in the reader, not a new format.

A reader bounds what an unauthenticated header may ask for (`log2N ≤ 18`,
`r = 8`, `p ≤ 8` — at most 256 MiB) before deriving anything. The passphrase
floor is 12 code points after NFC normalisation, without leading or trailing
spaces; NFC so the same passphrase typed on two keyboards opens the same kit.

### 3. One authentication error

A wrong passphrase and a damaged byte are both `recovery_kit.auth_failed`. GCM
cannot tell them apart and the reader must not try: distinguishing them is a
passphrase oracle (the archive's `BACKUP_ARCHIVE_AUTH_FAILED` argument). A file
that is not a kit, or a kit whose parameters are out of bounds, is
`recovery_kit.malformed` without deriving; a different format version is
`recovery_kit.unsupported_version` and is never guessed at. A payload that
authenticates and is still wrong — a duplicated key id, a fingerprint that is not
its key's, a payload moved from another kit — is malformed: it is what the
passphrase-holder sealed.

### 4. Imported keys are DECRYPT-ONLY by construction

`InstallationKeyring` wraps the configured keyring. `keys` is configured plus
imported; `activeKeyId` is the configured one, a getter with no setter and no
constructor argument that could change it. Both encrypting call sites —
`AesGcmSecretCipher.encrypt` and `sealArchive` — take the key by `activeKeyId`.
So an imported key can be held and never used for new material, and that is a
property of the type rather than of a check somebody might skip.

A configured id always wins: an imported row whose id a configured key also
answers to is never loaded, and an import that names a configured id with
different bytes — an attempt to replace the active key — is refused whole.

### 5. Storage that survives the restore it exists for

Imported keys live in `installation_keys` (migration 0158), **installation-wide,
with no tenant column and no tenant-bound encryption context**. Each key is
AES-256-GCM-wrapped under the active configured key, with
`nexa.installation_key.v1|keyId|wrappingKeyId` as associated data. It is not a
`SecretCipher` column: that cipher binds every value to a tenant, and a restore
replaces the tenant rows the binding would name; and the cipher reads the keyring
this table feeds. The column is named `wrapped_material`, not `*_ciphertext`, and
`secrets status | retire-check | rewrap` walk it explicitly.

The candidate a restore cuts over to is the OLD installation's database, which
does not contain this installation's imported keys. So the **executor writes the
current `installation_keys` rows into the candidate before the renames** — the
same reasoning that makes it re-assert its own request row afterwards (ADR-0028
§ 4), done before rather than after so the keys are in place at the instant the
candidate takes the live name. A row the candidate already holds under the same
id with the same fingerprint is replaced by this installation's wrap; the same
id with a different key aborts the recovery (`candidate_validation_failed`).

Every process loads the table at boot (`resolveInstallationTenant`, which every
role calls) and every 60 seconds; the API reloads after an import or removal, and
both halves of a recovery reload before opening an archive. A failed load keeps
what it had — a transient error must not empty the keyring under every restored
credential. Unwrapping is iterative, so a key wrapped under another imported key
(an old installation that had itself imported a kit) resolves.

### 6. Missing keys are refused before the confirmation and again before the renames

After the scratch restore, the restore-test asks which key ids the restored
database's secret columns name (`SECRET_COLUMNS`, tolerant of a schema that
predates a column) and refuses with `recovery.candidate_keys_missing` if any is
not held. The executor asks the same question of the candidate after carrying the
keys, authoritatively. The archive opening says nothing about the credentials
inside it, and cutting over to a database whose bot token is unreadable is a
restore that "succeeds" into an outage. The check is conservative: a key held
only inside the candidate's own `installation_keys` is not counted, so a kit
exported from the old installation — which includes its imported keys — is what
satisfies it.

### 7. The lifecycle, and its permissions

Three new CRITICAL permissions, owner-only (backfilled in 0158):

| Operation | Permission            | Also requires                                                                         |
| --------- | --------------------- | ------------------------------------------------------------------------------------- |
| List      | `backup.view`         | — (ids, fingerprints, origin, dependency counts; never bytes)                         |
| Export    | `recovery.kit.export` | the admin's own account password (throttled like login), passphrase typed twice       |
| Import    | `recovery.kit.import` | idempotency key; refused while a destructive recovery holds the installation          |
| Remove    | `recovery.key.remove` | the key's label typed; only an imported key; refused while anything retained needs it |

Export needs the account password because, with `backup.download` beside it, a
kit is the whole database in plaintext: a stolen session alone must not be
enough. `AdminManagementService.verifyOwnPassword` uses the same throttle counter
as login and `changeOwnPassword`, so it is not a second guessing door. A failed
step-up is a 400 (`recovery_kit.reauthentication_failed`), not a 401, so the
operator is not signed out of the page.

Import is all or nothing: the kit is opened (the expensive KDF) outside any
transaction, classified against what is held, then — under a table advisory lock,
in one unit-of-work transaction — classified again and written with its audit row
and its idempotency record. A failure on any key writes none. Same id and same
bytes is "already held"; same bytes under another id is also already held; same
id and different bytes is a collision that refuses the whole kit.

Removal counts four dependencies — stored secrets naming the key (via
`SECRET_COLUMNS`), imported keys wrapped under it, archives on this server's disk
whose cleartext header names it (`BACKUP_WORK_DIR/*/archive.nxb`), and
unfinished recoveries whose upload names it — and removes only at zero. Copies
elsewhere (Telegram, a laptop) are not countable, and the confirmation says so.
Configured keys are not removable from the Web Admin at all: that is a host
configuration change, gated by `botctl secrets retire-check`, which now counts
imported keys wrapped under the key too.

Every export, import and removal — and every refusal — writes an audit row with
key ids and fingerprints only. No key byte, passphrase or account password is
logged, audited, returned in an error, or put in a URL; `passphrase` joins the
redaction fragments.

### 8. ADR-0028's rules are untouched

No HTTP request restores into the live database: the kit endpoints change only
`installation_keys`, and the restore still happens in the `recovery` process. The
confirmation still binds to the artifact's SHA-256 and expires; the executor still
re-checks both. Every recovery state change is still a conditional UPDATE naming
its `from` states. Key changes are refused while a destructive recovery is
active, because the executor's carry step reads the keys once.

### 9. The command line

`pnpm backup verify|restore --kit PATH` opens an archive with a kit's keys for
that command only, reading the passphrase from standard input — never from an
argument, which is refused outright. Persisting the keys so the restored
installation can read its credentials is the Web Admin import, which wraps them
and audits it.

## Consequences

- **Bare-metal recovery works**: `.nxb` + kit + passphrase on a fresh install,
  proved end to end against a real PostgreSQL and the real cutover in
  `tests/integration/recovery-kit-restore.test.ts` (archive under KEK-A,
  installation with KEK-B, restored secrets read, new material sealed under
  KEK-B).
- **A kit is as sensitive as the database.** Kit + passphrase + any backup is
  everything. The Web Admin tells the operator to keep the kit apart from the
  backups and the passphrase apart from both.
- **Rotate, then re-export.** A kit holds the keys that existed when it was
  exported. After a key rotation an old kit cannot open new archives; the export
  hint says so.
- **New backups embed the imported keys**, wrapped under the active key, because
  `installation_keys` is in the dump. A later kit of THIS installation therefore
  opens both its own archives and, after a restore, the old installation's
  credentials.
- **Not run against a real server yet.** Like ADR-0028, the evidence is a real
  PostgreSQL in the integration suite.

## What was considered and rejected

**Putting the KEK in the archive, or next to it in the Telegram channel.** The
archive's encryption would then protect nothing.

**A form that accepts a pasted KEK** (ADR-0028 § 10). Still refused: the kit is a
sealed file, and the browser never sees key bytes.

**Storing imported keys in `/etc/nexa/nexa.env` or a file on a volume.** Every
process role would need write access to configuration, a restart would be
required, and nothing would audit it. The database is where every other durable,
audited state lives; carrying the rows across the cutover is the one extra step.

**Making an imported key active "for continuity".** The owner's rule, and the
right one: the current installation's key stays the only key that encrypts.
