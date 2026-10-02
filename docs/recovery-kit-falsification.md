# Recovery Kit — falsification record

Every production rule ADR-0032 added that a test claims to hold, reverted one at
a time against the working tree, with the test that dies named. Mutations were
applied by hand-scripted replacement of the exact text named below, the cited
test run, and the file restored with `git checkout` before the next row.

| #     | Rule                                                                 | Mutation                                                                      | Named test                                                                                                         | Result |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| RK-01 | A kit with two keys under one id is malformed, even authenticated    | the `seen.has(entry.keyId)` refusal in `openRecoveryKit` deleted              | `recovery-kit.test.ts` › refuses DUPLICATE KEY IDS, even in a kit that authenticates                               | KILLED |
| RK-02 | A different format version is refused by name, before deriving       | `format !== RECOVERY_KIT_FORMAT_VERSION` → `false`                            | `recovery-kit.test.ts` › refuses a WRONG VERSION by name, before deriving anything                                 | KILLED |
| RK-03 | A configured key id always wins over an imported one                 | the configured-id refusal in `InstallationKeyring.replaceImported` deleted    | `recovery-kit.test.ts` › refuses an imported key that claims the ACTIVE key id, and keeps the configured bytes     | KILLED |
| RK-04 | Same id, different bytes refuses the whole import (active key too)   | `sameKey(...) ? alreadyHeld : collisions` → always `alreadyHeld`              | `recovery-kit.test.ts` › REFUSES an attempt to replace the active key, and writes nothing                          | KILLED |
| RK-05 | A key is removed only when nothing retained depends on it            | `totalOf(counts) > 0` → `false`                                               | `recovery-kit.test.ts` › refuses while a stored SECRET still needs the key                                         | KILLED |
| RK-06 | (same rule, the archive dependency)                                  | as RK-05                                                                      | `recovery-kit.test.ts` › refuses while a RETAINED ARCHIVE on disk is sealed under the key                          | KILLED |
| RK-07 | (same rule, the wrapped-key dependency)                              | as RK-05                                                                      | `recovery-kit.test.ts` › refuses while another imported key is stored WRAPPED under it                             | KILLED |
| RK-08 | An import is one transaction: all keys or none                       | `this.deps.uow.run(scope, …)` → the same callback run outside any transaction | `recovery-kit.test.ts` › rolls back a PARTIAL import: a failure on one key leaves none written                     | KILLED |
| RK-09 | The executor carries imported keys into the candidate before cutover | `await this.deps.keys.carryInto(candidate)` → removed                         | `recovery-kit-restore.test.ts` › restores .nxb + kit + passphrase on a fresh install, and keeps the new key active | KILLED |
| RK-10 | The restore-test refuses a database whose secrets need an unheld key | `missing.length > 0` → `false` in `RecoveryService.restoreTest`               | `recovery-kit-restore.test.ts` › refuses before confirmation when the restored secrets need a key the kit lacks    | KILLED |

## PR #144 review fixes

Same method, against the fixed tree; every row KILLED.

| #     | Rule                                                            | Mutation                                                               | Named test                                                                                                          | Result |
| ----- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| RK-11 | Import needs the account password (step-up)                     | the `stepUp(...)` call in `importKit` deleted                          | `recovery-kit.test.ts` › needs the account password as well as the session (step-up), and writes nothing without it | KILLED |
| RK-12 | A reload never zeroes a key buffer that may be in use           | the previous imported buffers zeroed in `replaceImported`              | `recovery-kit.test.ts` › opens an archive sealed under an imported key while the keyring reloads mid-open           | KILLED |
| RK-13 | (same rule) an unchanged key keeps its buffer                   | as RK-12                                                               | `recovery-kit.test.ts` › keeps the same buffer for an unchanged key across a reload                                 | KILLED |
| RK-14 | Bytes held under another name are imported under the kit's name | an "already held under another id" branch restored                     | `recovery-kit.test.ts` › imports bytes already held under ANOTHER name as that name, so the name resolves           | KILLED |
| RK-15 | An archive taken while a key was held is a dependency of it     | the `takenAt >= heldSince` clause → `false`                            | `recovery-kit.test.ts` › refuses while a backup taken AFTER the import is on disk, whatever key sealed it           | KILLED |
| RK-16 | An unreadable archive counts against every key (fail closed)    | `scanned.unreadable +` → `0 +`                                         | `recovery-kit.test.ts` › FAILS CLOSED on an archive it cannot read: counted against every key                       | KILLED |
| RK-17 | The carry erases a removed key in the candidate (tombstone)     | tombstone rows skipped in `carryInto`                                  | `recovery-kit-restore.test.ts` › carries a TOMBSTONE into the candidate, and flags a key only the backup had        | KILLED |
| RK-18 | A key only the backup had is stamped `restored_at`              | the stamp's guard → never true                                         | `recovery-kit-restore.test.ts` › carries a TOMBSTONE into the candidate, and flags a key only the backup had        | KILLED |
| RK-19 | At most one kit derivation runs at a time                       | the `derivationInFlight` refusal deleted                               | `recovery-kit.test.ts` › runs at most one at a time in a process, refusing the second as BUSY                       | KILLED |
| RK-20 | An import may not exceed what one kit can carry                 | the limit predicate → `false`                                          | `recovery-kit.test.ts` › refuses an import that would leave more keys than one kit can carry                        | KILLED |
| RK-21 | A replay is answered only after the passphrase opens the kit    | the replay return moved before the kit is opened                       | `recovery-kit.test.ts` › does not replay an earlier success for a wrong passphrase                                  | KILLED |
| RK-22 | A configured key's fingerprint is hidden from LOW `backup.view` | `showConfigured ? … : null` → always the fingerprint                   | `recovery-kit.test.ts` › shows a configured key's fingerprint only to someone who may export the kit                | KILLED |
| RK-23 | Every refusal is audited                                        | the audit write in `refused()` disabled                                | `recovery-kit.test.ts` › audits an export refused for its passphrase                                                | KILLED |
| RK-24 | The wrapped-key tag length is fixed at 16                       | `authTagLength: 16` removed from the unwrap decipher                   | `recovery-kit.test.ts` › refuses a wrap whose authentication tag was shortened                                      | KILLED |
| RK-25 | Key reloads are serialised                                      | the reload chain not advanced                                          | `recovery-kit.test.ts` › applies reloads in the order they were asked for, never an older read last                 | KILLED |
| RK-26 | A recovery's key refresh fails closed                           | `loader.refresh()` → `loader.refreshQuietly()` in the coverage adapter | `recovery-kit.test.ts` › makes a recovery FAIL when the keys cannot be reloaded, rather than run on stale keys      | KILLED |
| RK-27 | The CLI refuses `--passphrase=VALUE`                            | the `startsWith('--passphrase=')` clause deleted                       | `backup-cli.test.ts` › refuses a kit passphrase given as --passphrase=VALUE too                                     | KILLED |

## Not separately falsified, and why

- **The executor's own missing-key check** (`recovery-executor.ts`, after the
  carry). With RK-10 in place no archive reaches it with a missing key, because
  the restore-test refuses first — the same shape as the executor's own cutover
  refusal in `disaster-recovery-falsification.md`. It stays as the authoritative
  re-check for a key removed between confirmation and execution.
- **Decrypt-only is structural**, not a predicate: `InstallationKeyring.activeKeyId`
  has no setter. There is nothing to revert; the property is asserted by
  `recovery-kit.test.ts` › encrypts under the configured key and decrypts under the imported one
  and by the restore test's final assertions.
